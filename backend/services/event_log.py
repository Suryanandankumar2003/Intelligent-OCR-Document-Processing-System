"""
The application log's write side: one function every call site in the
platform uses to say what just happened.

--- Why this is a service and not just `log_crud.record_log` -----------

Because a call site should name the event and nothing else. Left to
call sites, each would have to remember the event's category (which is
why `core/log_events.py` owns that mapping), pick a status, invent a
message, and decide what counts as structured detail — and a dozen call
sites making those four decisions independently is how an audit log ends
up with three spellings of "extraction failed" and a category breakdown
that under-counts the one thing it was built to measure.

So this module is the narrow waist: `log_event` takes an event type and
whatever context the caller has, derives the category, and writes one
row. `track_event` wraps an operation and writes the pair — `Started`
before, `Success`/`Failure` after, with the elapsed time on the second —
which is the shape almost every interesting event in this system
actually has.

--- Nothing here may raise --------------------------------------------

Not "should not" — may not. Every call site is a piece of real work with
its own contract (an upload that must return the stored filename, a
batch file that must record its own outcome), and none of them is
prepared for the logger to fail. `log_crud.record_log` already swallows
database errors; this module additionally guards the *construction* of
the row, because the other way a logger breaks a caller is by raising
while assembling a message from data that turned out to be `None`.

The one thing `track_event` does re-raise is the wrapped operation's own
exception, unchanged and with its traceback intact — the wrapper records
the failure and then gets out of the way, exactly as
`api/processing_metrics.py:track_processing_stage` does.

--- Sessions ----------------------------------------------------------

Every function takes a `Session` as its first argument, unlike the rest
of `services/`, which is deliberately session-agnostic. That is not an
exception to the rule so much as a consequence of what this module is:
writing a row *is* the whole operation, and a version that returned "the
row you should write" for the route layer to persist would be a strictly
more awkward way to spell the same thing, imposed at every one of thirty
call sites.
"""
import logging
import time
from contextlib import contextmanager
from typing import Any, Iterator, Optional

from sqlalchemy.orm import Session

from core.document_types import DocumentType
from core.log_events import LogEventType, LogStatus, category_for
from database import log_crud

logger = logging.getLogger(__name__)

# Long enough for a stack-derived message plus context, short enough that
# one pathological error cannot write a megabyte per occurrence into a
# table that is already the fastest-growing one in the schema.
MAX_MESSAGE_CHARS = 2000


def describe_exception(exc: BaseException) -> str:
    """
    One sentence naming a failure, for a log message.

    The same rule `worker/tasks.py:_describe` applies, and deliberately
    the same wording: everything in `core/exceptions.py` is already
    written to be read by a person, so those are used as-is, while
    anything else gets its class name prepended — "'NoneType' object is
    not subscriptable" on its own tells an operator nothing about where
    to look.

    Not imported from `worker/tasks.py` because that module pulls in
    Celery, and `services/` must stay importable without a broker
    installed; duplicating four lines is cheaper than that dependency.
    """
    message = str(exc).strip()
    if not message:
        return type(exc).__name__
    module = type(exc).__module__ or ""
    if module.startswith("core.exceptions"):
        return message
    return f"{type(exc).__name__}: {message}"


def log_event(
    db: Session,
    *,
    event_type: LogEventType,
    status: LogStatus = LogStatus.SUCCESS,
    message: str,
    document_id: Optional[int] = None,
    batch_id: Optional[str] = None,
    filename: Optional[str] = None,
    document_type: Optional[DocumentType] = None,
    details: Optional[dict[str, Any]] = None,
    processing_time: Optional[float] = None,
) -> None:
    """
    Record one event. Returns nothing — there is nothing a caller could
    usefully do with the row, and returning it would invite code that
    branches on whether logging worked.

    The category is derived from `event_type` (see `core/log_events.py`),
    which is the point of this wrapper: a call site cannot put an OCR
    event in the System category, so the analytics breakdown cannot
    quietly under-count.
    """
    try:
        log_crud.record_log(
            db,
            event_type=event_type,
            event_category=category_for(event_type),
            status=status,
            message=message[:MAX_MESSAGE_CHARS],
            document_id=document_id,
            batch_id=batch_id,
            filename=filename,
            document_type=document_type,
            details_json=details,
            processing_time=processing_time,
        )
    except Exception:  # noqa: BLE001 - see the module docstring: a logger may not break its caller
        logger.exception("Could not record application log for %r", event_type)


def log_once(
    db: Session,
    *,
    event_type: LogEventType,
    batch_id: Optional[str] = None,
    document_id: Optional[int] = None,
    **kwargs: Any,
) -> None:
    """
    Record an event only if it has not already been recorded for this
    batch or document.

    For the handful of events that describe a whole thing finishing.
    "Batch completed" is noticed by whichever file happens to finish last
    — and two files finishing in the same moment both see a terminal
    status, so both would write it. One duplicate row is not a formatting
    nuisance on an audit log; it is the log asserting the batch completed
    twice.

    See `log_crud.event_already_logged` for why this is a check and not a
    uniqueness constraint.
    """
    try:
        if log_crud.event_already_logged(
            db, event_type=event_type, batch_id=batch_id, document_id=document_id
        ):
            return
    except Exception:  # noqa: BLE001 - a failed check must not stop the event being recorded
        logger.exception("Could not check for an existing %r log; writing it anyway", event_type)

    log_event(db, event_type=event_type, batch_id=batch_id, document_id=document_id, **kwargs)


@contextmanager
def track_event(
    db: Session,
    *,
    started: LogEventType,
    completed: LogEventType,
    start_message: str,
    success_message: str,
    failure_message: Optional[str] = None,
    error_event: LogEventType = LogEventType.ERROR,
    **context: Any,
) -> Iterator[dict[str, Any]]:
    """
    Wrap an operation and record both ends of it.

    Writes `started` with status `STARTED` before the block runs, then
    either `completed`/`SUCCESS` or `error_event`/`FAILURE` after it,
    with the elapsed wall-clock seconds on whichever lands. Any exception
    is recorded and then re-raised unchanged, so the caller's own error
    handling — the global handlers in `app.py`, a worker's per-file
    failure path — runs exactly as if this wrapper were not there.

    Yields a mutable `details` dict. Anything the block puts in it is
    merged into the completion row's `details_json`, which is how an
    operation reports facts it does not know until it has finished — the
    number of rows an export wrote, the type a document classified as.
    The start row never sees it, because at that point it is empty by
    definition.

    `**context` is the document/batch/filename/document_type identity,
    passed through to both rows unchanged. Failures use
    `failure_message`, or a sentence built from the exception when the
    caller has nothing better to say — which is the usual case, since the
    exception generally knows more about what went wrong than the call
    site does.

    Sync, not async, like `track_processing_stage`: the wrapper itself
    does no awaiting, and `with ...: result = await call()` is valid
    Python — the `await` happens inside the block and the timing wraps
    around it either way.
    """
    details: dict[str, Any] = {}
    log_event(db, event_type=started, status=LogStatus.STARTED, message=start_message, **context)

    clock_start = time.perf_counter()
    try:
        yield details
    except BaseException as exc:
        elapsed = round(time.perf_counter() - clock_start, 3)
        log_event(
            db,
            event_type=error_event,
            status=LogStatus.FAILURE,
            message=failure_message or describe_exception(exc),
            details={**details, "error_type": type(exc).__name__, "failed_event": completed.value},
            processing_time=elapsed,
            **context,
        )
        raise
    else:
        elapsed = round(time.perf_counter() - clock_start, 3)
        log_event(
            db,
            event_type=completed,
            status=LogStatus.SUCCESS,
            message=success_message,
            details=details or None,
            processing_time=elapsed,
            **context,
        )
