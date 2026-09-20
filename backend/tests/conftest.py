"""
Shared pytest fixtures for the batch-processing test suite.

--- Every test runs against its own database ---------------------------

`DATABASE_URL` is pointed at a temporary SQLite file *before* anything
that touches `database.session` is imported, because that module builds
its engine at import time from the cached settings. A fixture that
swapped the URL afterwards would be talking to a different engine than
the code under test.

A file rather than `:memory:`: the inline executor runs files on other
threads, and an in-memory SQLite database is per-connection — a worker
thread would open a second, empty database and see none of the rows the
test just created.

--- Nothing here calls Vertex AI ---------------------------------------

`stub_pipeline` replaces `services.document_pipeline.process_document`,
so the tests exercise the batch machinery — claiming, progress,
retries, status transitions — without network calls, credentials, or
per-run cost. The stub is programmable per filename, which is what lets
a test say "file 3 fails" and assert the other files still finish.
"""
import os
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

# Must precede any import of `core.config` / `database.session`.
_TMP_DIR = Path(tempfile.mkdtemp(prefix="ocr-batch-tests-"))
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP_DIR / 'test.db'}"
os.environ["UPLOAD_DIR"] = str(_TMP_DIR / "uploads")
os.environ["GOOGLE_CLOUD_PROJECT"] = "test-project"
# Keep every test on the deterministic in-process path: no broker probe,
# no Redis, no waiting on a network timeout in CI.
os.environ["BATCH_INLINE_FALLBACK"] = "true"
os.environ["BATCH_INLINE_MAX_WORKERS"] = "2"
os.environ["MAX_FILE_RETRIES"] = "2"
os.environ["DEBUG"] = "false"

from core.config import get_settings  # noqa: E402
from core.document_types import DocumentType  # noqa: E402
from database.base import Base  # noqa: E402
from database.session import SessionLocal, engine  # noqa: E402
from services.document_pipeline import PipelineResult  # noqa: E402

settings = get_settings()
settings.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@pytest.fixture(scope="session", autouse=True)
def _create_schema():
    """Build the schema once for the session; drop it at the end."""
    import database.models  # noqa: F401 - registers every table on Base.metadata

    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


def _drain_inline_workers(timeout: float = 15.0) -> None:
    """
    Wait until no inline batch worker is still running.

    --- Why this is necessary, and why it isn’t paranoia -------------

    The app’s shutdown handler stops the inline pool with `wait=False`,
    which is right in production (a batch can have hours of work queued,
    and a Ctrl-C must not block on it) and leaves a specific hole in a
    test suite: the threads already *inside* `_process_file_inline`
    carry on running after the pool object is dropped, so a worker from
    one test can still be mid-file when the next test begins.

    On its own that would be harmless — it would write to rows the next
    line is about to delete. What makes it a real cross-test failure is
    that these tables have plain INTEGER PRIMARY KEY ids, so SQLite
    reuses row ids from 1 after a truncation. A straggler holding
    `batch_file_id=3` therefore claims *the next test’s* file 3, and
    processes it with the previous test’s stub. The victim test then
    sees one fewer call than it made, or a file it never configured to
    fail, and the symptom lands on whichever test happened to run next
    — which is why this presented as one unrelated test failing per
    full-suite run.

    Draining is done by shutting the pool down *waiting* (for a pool
    still live, e.g. a test that never built a TestClient) and then
    watching for the named worker threads to exit (for a pool the app
    shutdown already dropped a reference to, which is the common case).
    """
    from services.batch_dispatch import shutdown_inline_pool

    shutdown_inline_pool(wait=True)

    # Once shut down, the pool’s threads exit as soon as they finish the
    # item in hand, so their disappearance is the signal that no worker
    # can touch the database again.
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not any(
            thread.name.startswith("batch-inline") and thread.is_alive()
            for thread in threading.enumerate()
        ):
            return
        time.sleep(0.02)

    raise AssertionError("Inline batch workers did not stop within the drain timeout")


@pytest.fixture(autouse=True)
def clean_tables(_create_schema):
    """
    Truncate every table between tests.

    Deleting rows rather than recreating the schema: `create_all`/
    `drop_all` per test is slow, and — more importantly — the engine and
    its connection pool are module-level singletons, so dropping tables
    underneath a pooled connection is exactly the kind of cross-test
    interference this is meant to prevent.

    The drain below has to happen here rather than in a fixture of its
    own, because it must run *before* the truncation and fixtures tear
    down in reverse order of setup — a separate fixture would be at the
    mercy of which one each test happened to request first.
    """
    yield
    _drain_inline_workers()
    with engine.begin() as connection:
        for table in reversed(Base.metadata.sorted_tables):
            connection.execute(table.delete())


@pytest.fixture
def db():
    """A session for the test itself, always closed."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client():
    """
    A `TestClient` over the real app.

    The app is imported lazily, inside the fixture, so the environment
    overrides at the top of this file are already in place when
    `app.py` reads settings and builds the engine.
    """
    from fastapi.testclient import TestClient

    from app import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def make_upload(tmp_path):
    """
    Build a `(field_name, (filename, bytes, content_type))` tuple for
    `TestClient`'s multipart `files=` argument.

    Real PDF magic bytes, so the payload is at least structurally what it
    claims to be — the upload path only checks the declared type and the
    extension, but a test fixture that hands it obvious garbage would
    stop being a useful signal the moment content sniffing is added.

    `field` defaults to the batch endpoint's parameter name, because that
    is what all but one caller wants. The single-file endpoint takes
    `file` (singular), and posting a batch-shaped part to it is a 422
    from FastAPI's own request validation before any handler runs — a
    failure that looks exactly like the upload route being broken, and
    isn't.
    """

    def _make(
        name: str = "scan.pdf",
        content_type: str = "application/pdf",
        size: int = 2048,
        field: str = "files",
    ):
        payload = b"%PDF-1.4\n" + (b"0" * max(0, size - 9))
        return (field, (name, payload, content_type))

    return _make


@pytest.fixture
def stub_pipeline(monkeypatch):
    """
    Replace the real pipeline with a programmable stub.

    Returns a configuring function:

        stub_pipeline(fail_for={"abc.pdf": "Unreadable scan"})

    Every other filename succeeds. `calls` on the returned object records
    each filename processed, which is how the duplicate-processing tests
    assert that a file ran exactly once rather than merely ended in the
    right state.

    --- The gate -------------------------------------------------------

    `stub.hold()` makes every file block until `stub.release()` is
    called. Without it, a test that wants to observe a batch *while it
    is running* is racing the workers: the stub returns in microseconds,
    so two inline threads can finish a dozen files before the upload
    response has even been serialised, and an assertion like "the batch
    is still Pending or Processing" fails intermittently — on a claim
    that is true of the system and merely untestable at that speed.
    Holding the workers makes "returns before the work is done" a
    deterministic fact rather than a bet on scheduling.
    """

    class Stub:
        def __init__(self):
            self.calls: list[str] = []
            self.fail_for: dict[str, str] = {}
            self.document_type = DocumentType.INVOICE
            # Starts set, so an ungated stub never waits.
            self._gate = threading.Event()
            self._gate.set()

        def hold(self):
            """Make every subsequent file block until `release()`."""
            self._gate.clear()

        def release(self):
            """Let the held files through."""
            self._gate.set()

        async def __call__(self, db, *, filename: str, track_stage=None):
            # Recorded before the wait, so a test can assert that the
            # workers have picked the files up while still holding them.
            self.calls.append(filename)
            # Generous, and never reached in a passing run: this is here
            # so a test that forgets to release fails with its own
            # assertion rather than hanging the suite.
            if not self._gate.wait(timeout=30):
                raise AssertionError(f"Gate never released while processing {filename}")
            if filename in self.fail_for:
                raise RuntimeError(self.fail_for[filename])
            return PipelineResult(
                filename=filename,
                document_type=self.document_type,
                ocr_text="stub transcript",
                extracted_data={"invoice_number": "INV-1"},
                document_id=None,
                processing_time_seconds=0.01,
            )

    stub = Stub()

    def _configure(fail_for: dict[str, str] | None = None, document_type: DocumentType | None = None):
        stub.fail_for = fail_for or {}
        if document_type is not None:
            stub.document_type = document_type
        return stub

    # Patched in both places it is looked up. The Celery task imports it
    # at module scope; the inline executor imports it inside the function
    # (to keep the service layer from importing `api/`), so patching only
    # one would leave the other running the real pipeline.
    monkeypatch.setattr("services.document_pipeline.process_document", stub)
    monkeypatch.setattr("worker.tasks.process_document", stub, raising=False)
    yield _configure
    # Released unconditionally, so a test that holds the gate and then
    # fails an assertion reports *that* failure rather than deadlocking
    # the drain in `clean_tables` behind workers nobody is going to let
    # through.
    stub.release()


@pytest.fixture
def batch_factory(db):
    """Create a batch with `count` pending files directly, skipping the HTTP upload."""
    from database import batch_crud

    def _make(count: int = 3, name: str = "Test batch"):
        files = [
            {"filename": f"{uuid.uuid4().hex}.pdf", "original_filename": f"doc-{index}.pdf"}
            for index in range(count)
        ]
        return batch_crud.create_batch(db, batch_name=name, files=files)

    return _make
