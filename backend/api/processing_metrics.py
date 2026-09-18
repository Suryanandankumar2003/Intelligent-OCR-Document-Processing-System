"""
The one piece of instrumentation every pipeline route wraps its call to
`services.ocr_service` / `classification_service` / `extraction_service`
in, so each attempt — success or failure — becomes one row in
`processing_events` for the analytics dashboard to read
(`database/analytics.py`).

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
"""
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator, Optional

from sqlalchemy.orm import Session

from core.processing_event import ProcessingStage, ProcessingStatus
from database import crud


@contextmanager
def track_processing_stage(db: Session, *, filename: str, stage: ProcessingStage) -> Iterator[None]:
    """
    Time one attempt at `stage` for `filename` and record the outcome.

    Usage is a plain `with` block around the single line that calls the
    service — sync, not async, even though every call site is inside an
    `async def` route: the context manager itself does no I/O of its own
    beyond a synchronous DB write, so it doesn't need `async with`, and
    `with ...: result = await service_call(...)` is valid Python — the
    `await` happens inside the block, the timing wraps around it either
    way.

    Any exception raised inside the block is recorded as a `FAILURE`
    (the exception's class name as `error_type`) and then re-raised
    unchanged, so the route's normal error handling — the global
    exception handlers registered in `app.py` — still runs exactly as if
    this wrapper weren't there. Recording is best-effort
    (`crud.record_processing_event` never raises); a telemetry failure
    must never replace or mask the real result of the wrapped call.
    """
    started_at = datetime.now(timezone.utc)
    clock_start = time.perf_counter()
    status = ProcessingStatus.SUCCESS
    error_type: Optional[str] = None

    try:
        yield
    except BaseException as exc:
        status = ProcessingStatus.FAILURE
        error_type = type(exc).__name__
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
