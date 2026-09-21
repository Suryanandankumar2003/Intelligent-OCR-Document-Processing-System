"""
The Celery tasks: one file's pipeline, and the fan-out that queues a
batch's worth of them.

--- One task per file, not one per batch ------------------------------

`process_batch_file` handles exactly one document. A batch of 500 files
becomes 500 independent messages rather than one long-running task, and
every requirement in the brief falls out of that choice:

* **One failure cannot stop the batch** — a failed file is one message
  that ended, not a loop that raised.
* **Concurrency is free** — N worker threads pull N messages. A single
  batch task would be pinned to one thread no matter how many are idle.
* **Retry is per file** — the unit of retry is the unit of work. Retrying
  a 500-file batch task to fix one document would redo 499.
* **Progress is real** — each file commits its own outcome as it lands,
  so the UI moves continuously instead of jumping from 0% to 100%.

--- Where failures go -------------------------------------------------

A failing file is recorded as `FAILED` with its message on the
`batch_files` row and the task returns *normally*. It does not raise, and
it does not use Celery's `autoretry_for`.

That is deliberate. Celery's retry machinery counts attempts inside the
message, which does not survive a broker restart, is invisible to the
UI, and cannot be triggered by an operator clicking "Retry". This system
already has a retry counter that survives all three
(`batch_files.retry_count`), and the retry entry point is
`services/batch_dispatch.py:retry_files`. Two competing retry mechanisms
would race, and the one that isn't visible in the database would win
silently.

The one thing that *is* retried by Celery is infrastructure failure —
the task cannot reach the database at all — because that isn't a property
of the document and a moment later it may well work.
"""
import logging
from typing import Optional

from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded

from api.processing_metrics import track_processing_stage
from core.async_runner import run_async
from core.exceptions import DocumentPersistenceError
from core.processing_event import ProcessingStage
from database import batch_crud
from database.session import SessionLocal
from services import batch_events
from services.document_pipeline import process_document
from worker.celery_app import BATCH_QUEUE, celery_app

logger = logging.getLogger(__name__)


def _describe(exc: BaseException) -> str:
    """
    Turn an exception into the sentence stored on the file row and shown
    in the UI.

    Every exception in `core/exceptions.py` is already written to be read
    by a person ("File exceeds the maximum allowed size of 10 MB."), so
    for those the message is used as-is. Anything else — an SDK error, a
    bug — gets its class name prepended, because "'NoneType' object is
    not subscriptable" on its own tells an operator nothing about where
    to look.
    """
    message = str(exc).strip()
    if not message:
        return type(exc).__name__
    module = type(exc).__module__
    if module and module.startswith("core.exceptions"):
        return message
    return f"{type(exc).__name__}: {message}"


@shared_task(
    name="batch.process_file",
    queue=BATCH_QUEUE,
    bind=True,
    # Only infrastructure failure is retried by Celery; see the module
    # docstring for why document failures are not. A database that cannot
    # be written to is not a property of this document.
    autoretry_for=(DocumentPersistenceError,),
    retry_backoff=True,
    retry_backoff_max=60,
    retry_jitter=True,
    max_retries=3,
)
def process_batch_file(self, batch_file_id: int) -> dict:
    """
    Run the full pipeline for one file in a batch.

    Takes only the row id — not the filename, not the batch id, not a
    dict of state. Everything else is read from the database inside the
    task, which is what makes the task idempotent and makes a redelivered
    message correct rather than merely tolerable: the message carries no
    snapshot that could have gone stale between being queued and being
    run.

    Returns a small dict for the result backend (operational debugging
    only — the UI never reads it; batch state lives in the database).
    """
    db = SessionLocal()
    try:
        # The compare-and-set that makes duplicate delivery safe. `None`
        # means another worker already owns this file, which is the
        # expected outcome of a redelivery, not an error.
        batch_file = batch_crud.claim_batch_file(db, batch_file_id)
        if batch_file is None:
            return {"batch_file_id": batch_file_id, "status": "skipped", "reason": "already claimed"}

        batch_id = batch_file.batch_id
        filename = batch_file.filename
        # Read off the claimed row before the pipeline runs, because the
        # row is re-read and rewritten below and these three are needed
        # on every exit path — including the ones where the row's own
        # state has already moved on.
        original_filename = batch_file.original_filename
        retry_count = batch_file.retry_count
        batch_crud.mark_batch_started(db, batch_id, executor="celery")
        batch_events.log_file_started(
            db,
            batch_id=batch_id,
            batch_file_id=batch_file_id,
            filename=filename,
            original_filename=original_filename,
            retry_count=retry_count,
            executor="celery",
        )

        try:
            result = run_async(
                process_document(
                    db,
                    filename=filename,
                    # Feeds the same `processing_events` table the
                    # interactive routes do, so the existing analytics
                    # dashboard measures batch traffic without any change
                    # to it.
                    track_stage=lambda stage: track_processing_stage(
                        db, filename=filename, stage=stage
                    ),
                )
            )
        except SoftTimeLimitExceeded:
            # Raised inside the task by Celery's soft limit, which exists
            # precisely so this branch can run: record a real message
            # before the hard limit kills the thread with no explanation.
            logger.warning("File %s (%s) exceeded the soft time limit", batch_file_id, filename)
            timeout_message = (
                "Processing timed out. The document may be very large or the AI service slow."
            )
            batch_crud.mark_file_failed(db, file_id=batch_file_id, error_message=timeout_message)
            batch_events.log_file_failed(
                db,
                batch_id=batch_id,
                batch_file_id=batch_file_id,
                filename=filename,
                original_filename=original_filename,
                retry_count=retry_count,
                executor="celery",
                error_message=timeout_message,
            )
            batch_events.log_batch_completed(db, batch_crud.recompute_batch_progress(db, batch_id))
            return {"batch_file_id": batch_file_id, "status": "failed", "reason": "timeout"}
        except DocumentPersistenceError:
            # Let Celery retry this one — it is the database being
            # unavailable, not the document being bad. Re-raised *before*
            # the file is marked failed, so a transient lock does not burn
            # the document's own retry budget.
            raise
        except Exception as exc:  # noqa: BLE001 - a bad document must never kill the worker
            logger.exception("Pipeline failed for file %s (%s)", batch_file_id, filename)
            message = _describe(exc)
            batch_crud.mark_file_failed(db, file_id=batch_file_id, error_message=message)
            batch_events.log_file_failed(
                db,
                batch_id=batch_id,
                batch_file_id=batch_file_id,
                filename=filename,
                original_filename=original_filename,
                retry_count=retry_count,
                executor="celery",
                error_message=message,
            )
            batch_events.log_batch_completed(db, batch_crud.recompute_batch_progress(db, batch_id))
            return {"batch_file_id": batch_file_id, "status": "failed", "reason": message}

        batch_crud.mark_file_succeeded(
            db,
            file_id=batch_file_id,
            document_id=result.document_id,
            document_type=result.document_type,
            processing_time_seconds=result.processing_time_seconds,
        )
        batch_events.log_file_succeeded(
            db,
            batch_id=batch_id,
            batch_file_id=batch_file_id,
            filename=filename,
            original_filename=original_filename,
            retry_count=retry_count,
            executor="celery",
            document_id=result.document_id,
            document_type=result.document_type,
            extracted=result.is_extracted,
            processing_time_seconds=result.processing_time_seconds,
        )
        # The recompute's return value is what tells us whether this file
        # was the one that finished the batch off — the only moment
        # anything in this system learns that, since there is no
        # batch-level callback by design.
        batch_events.log_batch_completed(db, batch_crud.recompute_batch_progress(db, batch_id))

        return {
            "batch_file_id": batch_file_id,
            "status": "success",
            "document_type": result.document_type.value,
            "extracted": result.is_extracted,
            "seconds": result.processing_time_seconds,
        }
    finally:
        # Always closed, on every path including a retry raise. A leaked
        # session holds a SQLite connection, and a worker that leaks one
        # per task exhausts the pool within a single large batch.
        db.close()


@shared_task(name="batch.dispatch", queue=BATCH_QUEUE)
def dispatch_batch(batch_id: str) -> dict:
    """
    Queue one `process_batch_file` task per pending file in a batch.

    Exists so that `POST /batches/upload` can return after sending a
    single message, instead of publishing 500 of them while the client
    waits. At 500 files the difference is the whole point: publishing is
    a network round-trip each, and doing it inside the request makes
    upload latency scale with batch size — the exact thing this feature
    is meant to remove.

    Reads the pending ids from the database rather than accepting a list,
    so a redelivery of *this* message re-queues only what is still
    pending. Files already claimed or finished are simply not in the
    query's result.
    """
    db = SessionLocal()
    try:
        file_ids = batch_crud.pending_file_ids(db, batch_id)
        if not file_ids:
            logger.info("Batch %s has no pending files to dispatch", batch_id)
            return {"batch_id": batch_id, "queued": 0}

        for file_id in file_ids:
            process_batch_file.delay(file_id)

        logger.info("Dispatched %d file task(s) for batch %s", len(file_ids), batch_id)
        return {"batch_id": batch_id, "queued": len(file_ids)}
    finally:
        db.close()


@shared_task(name="batch.queue_files", queue=BATCH_QUEUE)
def queue_files(file_ids: list[int]) -> dict:
    """
    Queue a specific set of files — the retry path.

    Separate from `dispatch_batch` because a retry knows exactly which
    files it reset (`batch_crud.reset_files_for_retry` returns them) and
    must queue those and no others. Re-deriving "everything pending"
    would also sweep up files a concurrent upload had just added.
    """
    for file_id in file_ids:
        process_batch_file.delay(file_id)
    logger.info("Queued %d file task(s) for retry", len(file_ids))
    return {"queued": len(file_ids)}


def send_dispatch(batch_id: str) -> Optional[str]:
    """
    Publish a dispatch message and return its task id, or `None` if the
    broker refused it.

    Wrapped so the caller (`services/batch_dispatch.py`) gets a plain
    boolean-ish answer instead of having to know which of kombu's
    exception types mean "no broker". Every one of them means the same
    thing here: fall back to inline execution.
    """
    try:
        async_result = dispatch_batch.apply_async(args=[batch_id])
        return async_result.id
    except Exception:  # noqa: BLE001 - any publish failure means "use the fallback"
        logger.warning("Could not publish dispatch task for batch %s", batch_id, exc_info=True)
        return None


def send_queue_files(file_ids: list[int]) -> Optional[str]:
    """`send_dispatch`'s counterpart for the retry path."""
    try:
        async_result = queue_files.apply_async(args=[file_ids])
        return async_result.id
    except Exception:  # noqa: BLE001
        logger.warning("Could not publish retry task for %d file(s)", len(file_ids), exc_info=True)
        return None


# Re-exported so `celery -A worker.celery_app` finds the app object and
# the tasks registered on it from one import.
__all__ = [
    "celery_app",
    "process_batch_file",
    "dispatch_batch",
    "queue_files",
    "send_dispatch",
    "send_queue_files",
]
