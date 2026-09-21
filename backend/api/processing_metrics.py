"""
The one piece of instrumentation every pipeline route wraps its call to
`services.ocr_service` / `classification_service` / `extraction_service`
in, so each attempt — success or failure — becomes a row in
`processing_events` for the analytics dashboard to read
(`database/analytics.py`) *and* a pair of rows in `application_logs` for
the Logs screen to show (`database/log_crud.py`).

Lives here rather than in `core/` or `services/`: it needs a `Session`
to call `database.crud.record_processing_event`, and this project's own
layering rule (`docs/architecture.md`) is that `core/` sits *below*
`database/` and must never import from it, while `services/` stays
session-agnostic by convention (see `services/review_service.py`'s
docstring) — a service takes plain data in and returns plain data out,
never a `Session`. Timing a call and writing the result to the database
is route-layer plumbing wrapped around a service call, not the service's
own business logic, so a small shared module next to `api/routes/` is
where it belongs.

Why every call site is wrapped individually rather than once per route:
`extract_text_from_stored_file` (OCR) is called from three different
routes — its own `POST .../ocr`, but also `POST .../classify` and
`POST .../extract`, which both run OCR again internally instead of
reusing a prior result. Wrapping each *service call*, not each *route*,
is what makes the OCR success rate reflect every real attempt at OCR
regardless of which endpoint triggered it — instrumenting only
`api/routes/ocr.py` would silently miss two-thirds of the OCR traffic
this system actually generates.

--- Why both tables, from one wrapper ---------------------------------

Because they answer different questions and this is the only place that
knows the answer to both at once. `ProcessingEvent` is the metric — a
stage, an outcome, a duration, all of it group-by-able, which is exactly
what a success-rate chart needs and all it needs. `ApplicationLog` is
the narrative: a sentence naming the file, a `Started` row that exists
even for a call that never returns, and a structured payload. Writing
them from two different wrappers would mean two sets of call sites to
keep in step, and the first one to fall behind would make the dashboard
and the log disagree about what the pipeline did — which is worse than
either being missing.

The cost is honest and worth stating: a fully processed document writes
three `processing_events` rows and six `application_logs` rows. At 500
files that is 4,500 small commits against a local SQLite file, which the
WAL journal and the 15-second busy timeout in `database/session.py` are
already configured for. Every one of those rows is what makes a stuck
batch diagnosable, so the trade is deliberate rather than incidental.
"""
import logging
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator, Optional

from sqlalchemy.orm import Session

from core.document_types import DocumentType
from core.log_events import STAGE_EVENT_TYPES, LogStatus
from core.processing_event import ProcessingStage, ProcessingStatus
from database import crud
from services.event_log import describe_exception, log_event

logger = logging.getLogger(__name__)


def _document_context(db: Session, filename: str) -> tuple[Optional[int], Optional[DocumentType]]:
    """
    The document id and type to stamp on this stage's log rows, or
    `(None, None)` if there is no record for the filename.

    Read at the moment the row is written rather than passed in by the
    caller, which makes it a *snapshot* and not a prediction: at OCR
    time a freshly uploaded document genuinely is `Unknown`, and a log
    row claiming otherwise because the classifier later said "Invoice"
    would be describing a fact that had not happened yet. The type
    recorded here is the one that was true when the stage ran, which is
    what an audit trail is for.

    One indexed lookup per stage. Never raises: a failure to read the
    context must not stop the stage's own telemetry from being written,
    let alone the stage itself.
    """
    try:
        document = crud.get_document_by_filename(db, filename)
    except Exception:  # noqa: BLE001 - context is a nicety; the log row is not
        logger.debug("Could not resolve document context for %r", filename, exc_info=True)
        return None, None
    if document is None:
        return None, None
    return document.id, document.document_type


@contextmanager
def track_processing_stage(db: Session, *, filename: str, stage: ProcessingStage) -> Iterator[None]:
    """
    Time one attempt at `stage` for `filename` and record the outcome, to
    both `processing_events` and `application_logs`.

    Usage is a plain `with` block around the single line that calls the
    service — sync, not async, even though every call site is inside an
    `async def` route: the context manager itself does no I/O of its own
    beyond synchronous DB writes, so it doesn't need `async with`, and
    `with ...: result = await service_call(...)` is valid Python — the
    `await` happens inside the block, the timing wraps around it either
    way.

    Any exception raised inside the block is recorded as a `FAILURE` (the
    exception's class name as `error_type`) and then re-raised unchanged,
    so the route's normal error handling — the global exception handlers
    registered in `app.py` — still runs exactly as if this wrapper
    weren't there. Every write here is best-effort
    (`crud.record_processing_event` and `services.event_log.log_event`
    both swallow their own failures); telemetry must never replace or
    mask the real result of the wrapped call.
    """
    started_event, completed_event, failed_event = STAGE_EVENT_TYPES[stage.value]

    started_at = datetime.now(timezone.utc)
    clock_start = time.perf_counter()
    status = ProcessingStatus.SUCCESS
    error_type: Optional[str] = None
    failure_message: Optional[str] = None

    # Written before the work begins, so a call that never returns still
    # leaves a trace. A log that only recorded completions could not
    # distinguish "this never ran" from "this ran and died", which is
    # precisely the question asked of a batch stuck at 63%.
    log_event(
        db,
        event_type=started_event,
        status=LogStatus.STARTED,
        message=f"{stage.value} started for '{filename}'.",
        filename=filename,
    )

    try:
        yield
    except BaseException as exc:
        status = ProcessingStatus.FAILURE
        error_type = type(exc).__name__
        failure_message = describe_exception(exc)
        raise
    finally:
        duration_ms = round((time.perf_counter() - clock_start) * 1000)
        crud.record_processing_event(
            db,
            filename=filename,
            stage=stage,
            status=status,
            duration_ms=duration_ms,
            started_at=started_at,
            error_type=error_type,
        )

        document_id, document_type = _document_context(db, filename)
        succeeded = status == ProcessingStatus.SUCCESS
        log_event(
            db,
            # The stage's own failure event, not a generic `ERROR` one —
            # see `core/log_events.py:STAGE_EVENT_TYPES` for why that
            # distinction is what keeps the "OCR failures" and
            # "extraction failures" cards able to find these rows at all.
            # "Everything that went wrong" remains one filter regardless,
            # because it is a filter on `status`, which every failure row
            # carries whatever its event type.
            event_type=completed_event if succeeded else failed_event,
            status=LogStatus.SUCCESS if succeeded else LogStatus.FAILURE,
            message=(
                f"{stage.value} completed for '{filename}'."
                if succeeded
                else f"{stage.value} failed for '{filename}': {failure_message}"
            ),
            filename=filename,
            document_id=document_id,
            document_type=document_type,
            details={
                "stage": stage.value,
                "duration_ms": duration_ms,
                **({} if succeeded else {"error_type": error_type}),
            },
            processing_time=round(duration_ms / 1000, 3),
        )
