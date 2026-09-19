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


@pytest.fixture(autouse=True)
def clean_tables(_create_schema):
    """
    Truncate every table between tests.

    Deleting rows rather than recreating the schema: `create_all`/
    `drop_all` per test is slow, and — more importantly — the engine and
    its connection pool are module-level singletons, so dropping tables
    underneath a pooled connection is exactly the kind of cross-test
    interference this is meant to prevent.
    """
    yield
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
    """

    def _make(name: str = "scan.pdf", content_type: str = "application/pdf", size: int = 2048):
        payload = b"%PDF-1.4\n" + (b"0" * max(0, size - 9))
        return ("files", (name, payload, content_type))

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
    """

    class Stub:
        def __init__(self):
            self.calls: list[str] = []
            self.fail_for: dict[str, str] = {}
            self.document_type = DocumentType.INVOICE

        async def __call__(self, db, *, filename: str, track_stage=None):
            self.calls.append(filename)
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
    return _configure


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
