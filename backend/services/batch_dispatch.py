"""
Getting a batch's files executed, by whichever route is available.

Two executors, one interface:

* **celery** — files are published to Redis and picked up by a separate
  worker process. The real one. Survives an API restart, scales by
  starting more workers, and keeps heavy work off the web process
  entirely.
* **inline** — files are processed in a small thread pool inside the API
  process. The fallback, used when the broker is unreachable.

--- Why the fallback exists -------------------------------------------

Redis is not a native Windows service, and this project is explicitly a
local Windows install. Without a fallback, every batch feature — the
upload, the list, the details page, the progress stream — is dead until
an operator has installed and started a broker, which makes the whole
feature look broken rather than unconfigured. With it, the system works
out of the box and gets *better* when Redis appears.

--- What the fallback is not ------------------------------------------

It is not equivalent, and it is recorded on the batch (`batches.executor`)
precisely so nobody has to guess which one ran:

* It shares the API process. Files compete with HTTP requests for the
  GIL, and `BATCH_INLINE_MAX_WORKERS` is deliberately small for that
  reason.
* It does not survive a restart. Files still `PROCESSING` when the API
  stops are stranded and need a batch retry, which
  `release_stale_processing` exists to handle.
* It does not scale past one process.

The *work* is identical — both call the same `process_document` through
the same claim/record/recompute sequence — so a batch processed inline is
indistinguishable from a queued one in the database. Only the delivery
differs.
"""
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Iterable, Optional

from sqlalchemy.orm import Session

from core.async_runner import run_async
from core.config import get_settings
from database import batch_crud
from database.session import SessionLocal
from services import batch_events

logger = logging.getLogger(__name__)
settings = get_settings()

EXECUTOR_CELERY = "celery"
EXECUTOR_INLINE = "inline"

# One pool for the whole process, created on first use rather than at
# import time so a deployment that never falls back never spawns threads.
# `_pool_lock` guards construction only — two concurrent uploads arriving
# before the pool exists must not build two of them.
_pool: Optional[ThreadPoolExecutor] = None
_pool_lock = threading.Lock()


def _get_inline_pool() -> ThreadPoolExecutor:
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = ThreadPoolExecutor(
                    max_workers=settings.BATCH_INLINE_MAX_WORKERS,
                    # Named so a thread dump during a slow batch says
                    # which threads are document workers rather than
                    # "ThreadPoolExecutor-0_3".
                    thread_name_prefix="batch-inline",
                )
                logger.info(
                    "Started inline batch executor with %d worker thread(s)",
                    settings.BATCH_INLINE_MAX_WORKERS,
                )
    return _pool


def _process_file_inline(batch_file_id: int) -> None:
    """
    Process one file on an inline worker thread.

    A near-copy of `worker/tasks.py:process_batch_file`, and deliberately
    so rather than sharing a helper: the two differ in exactly the places
    that matter — Celery's soft time limit does not exist here, there is
    no task retry to re-raise into, and the session lifecycle is the
    thread's rather than the task's. A shared helper would have to take
    those three as parameters and would end up harder to follow than
    either version. What *is* shared is the part that must never diverge:
    the claim, the pipeline call, and the progress recompute.

    Never raises. It runs on a pool thread whose exceptions nobody
    observes — `ThreadPoolExecutor` captures them into a `Future` that
    this code deliberately drops — so an escape would be silent. Every
    failure is recorded on the row instead.
    """
    # Imported here rather than at module import: `api.processing_metrics`
    # is route-layer plumbing, and importing it at the top would make this
    # service module depend on `api/`, inverting this project's layering.
    from api.processing_metrics import track_processing_stage
    from services.document_pipeline import process_document

    db: Session = SessionLocal()
    try:
        batch_file = batch_crud.claim_batch_file(db, batch_file_id)
        if batch_file is None:
            return

        batch_id = batch_file.batch_id
        filename = batch_file.filename
        # Read off the claimed row up front: the row is rewritten below
        # and these two are needed on every exit path. Same reason
        # `worker/tasks.py` reads them at the same point.
        original_filename = batch_file.original_filename
        retry_count = batch_file.retry_count
        batch_crud.mark_batch_started(db, batch_id, executor=EXECUTOR_INLINE)
        batch_events.log_file_started(
            db,
            batch_id=batch_id,
            batch_file_id=batch_file_id,
            filename=filename,
            original_filename=original_filename,
            retry_count=retry_count,
            executor=EXECUTOR_INLINE,
        )

        try:
            result = run_async(
                process_document(
                    db,
                    filename=filename,
                    track_stage=lambda stage: track_processing_stage(
                        db, filename=filename, stage=stage
                    ),
                )
            )
        except Exception as exc:  # noqa: BLE001 - a bad document must not kill the pool thread
            logger.exception("Inline pipeline failed for file %s (%s)", batch_file_id, filename)
            message = str(exc).strip() or type(exc).__name__
            if not type(exc).__module__.startswith("core.exceptions"):
                message = f"{type(exc).__name__}: {message}"
            message = message[:2000]
            batch_crud.mark_file_failed(db, file_id=batch_file_id, error_message=message)
            batch_events.log_file_failed(
                db,
                batch_id=batch_id,
                batch_file_id=batch_file_id,
                filename=filename,
                original_filename=original_filename,
                retry_count=retry_count,
                executor=EXECUTOR_INLINE,
                error_message=message,
            )
            batch_events.log_batch_completed(db, batch_crud.recompute_batch_progress(db, batch_id))
            return

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
            executor=EXECUTOR_INLINE,
            document_id=result.document_id,
            document_type=result.document_type,
            extracted=result.is_extracted,
            processing_time_seconds=result.processing_time_seconds,
        )
        batch_events.log_batch_completed(db, batch_crud.recompute_batch_progress(db, batch_id))
    except Exception:  # noqa: BLE001 - last line of defence; see the docstring
        logger.exception("Unhandled error in inline batch worker for file %s", batch_file_id)
    finally:
        db.close()


def _submit_inline(file_ids: Iterable[int]) -> int:
    """Hand a set of file ids to the inline pool. Returns how many were submitted."""
    pool = _get_inline_pool()
    count = 0
    for file_id in file_ids:
        pool.submit(_process_file_inline, file_id)
        count += 1
    return count


def _broker_available() -> bool:
    """
    Whether to use Celery for this dispatch.

    Probed per dispatch rather than cached at startup: Redis is a service
    an operator starts and stops, often *after* the API is already
    running, and a cached "no" would keep every batch inline until the
    API was restarted too. The probe has a short timeout
    (`BROKER_PROBE_TIMEOUT_SECONDS`) precisely because it is on the
    upload's critical path.
    """
    if not settings.BATCH_INLINE_FALLBACK:
        # Fallback disabled: always take the Celery path and let a publish
        # failure surface, rather than silently running work in the API
        # process against an explicit configuration choice.
        return True
    from worker.celery_app import broker_is_reachable

    return broker_is_reachable()


def dispatch_batch(db: Session, batch_id: str) -> str:
    """
    Start processing every pending file in a batch. Returns the executor
    that took it — `"celery"` or `"inline"`.

    Called from `POST /batches/upload` after the batch and its file rows
    are committed. That ordering is not incidental: a worker can begin
    the instant the message is published, and a task that looks up a file
    id its own transaction cannot yet see would fail on a race that only
    shows up under load.
    """
    if _broker_available():
        from worker.tasks import send_dispatch

        if send_dispatch(batch_id) is not None:
            batch_crud.mark_batch_started(db, batch_id, executor=EXECUTOR_CELERY)
            logger.info("Batch %s dispatched to Celery", batch_id)
            return EXECUTOR_CELERY
        # Publish failed despite the probe succeeding — the broker went
        # away in between. Fall through rather than failing the upload.
        logger.warning("Broker probe succeeded but publish failed for batch %s", batch_id)

    file_ids = batch_crud.pending_file_ids(db, batch_id)
    submitted = _submit_inline(file_ids)
    batch_crud.mark_batch_started(db, batch_id, executor=EXECUTOR_INLINE)
    logger.info("Batch %s dispatched inline (%d file(s))", batch_id, submitted)
    return EXECUTOR_INLINE


def dispatch_files(db: Session, file_ids: list[int]) -> str:
    """
    Start processing a specific set of files — the retry path.

    Takes explicit ids rather than re-deriving "everything pending",
    because a retry must act on exactly the files it reset. Re-deriving
    would also sweep up anything a concurrent upload had just added to
    the same batch.
    """
    if not file_ids:
        return EXECUTOR_INLINE

    if _broker_available():
        from worker.tasks import send_queue_files

        if send_queue_files(file_ids) is not None:
            return EXECUTOR_CELERY

    _submit_inline(file_ids)
    return EXECUTOR_INLINE


def retry_files(db: Session, *, batch_id: str, file_ids: list[int]) -> tuple[list[int], str]:
    """
    Reset the eligible files among `file_ids` and queue them. Returns
    `(ids_actually_retried, executor)`.

    Eligibility — failed, and under `MAX_FILE_RETRIES` — is decided in
    the database by `reset_files_for_retry`, not here, so two retry
    requests arriving together cannot both push the same file past its
    cap. An empty result means nothing qualified, which the route turns
    into `NothingToRetryError` rather than a misleading success.
    """
    retried = batch_crud.reset_files_for_retry(
        db, file_ids, max_retries=settings.MAX_FILE_RETRIES
    )
    if not retried:
        return [], EXECUTOR_INLINE

    # Recomputed before queueing so the batch leaves its terminal state
    # immediately. Otherwise a retried batch keeps reporting "Completed"
    # until the first retried file finishes, and the UI shows a finished
    # batch with work visibly running in it.
    batch_crud.recompute_batch_progress(db, batch_id)
    executor = dispatch_files(db, retried)
    return retried, executor


def retry_batch(db: Session, batch_id: str) -> tuple[list[int], str]:
    """
    Retry a whole batch: every failed file that has retries left, plus
    any file stranded in `PROCESSING`.

    The stranded files are the reason this is not just "retry all failed".
    A file whose worker died after claiming it but before recording an
    outcome sits in `PROCESSING` for ever — the claim already succeeded,
    so nothing will pick it up again. Releasing those is the only way to
    recover a batch from a killed worker or an API restart mid-run, and
    they are released without charging `retry_count`, since they never
    actually produced a failure (see
    `batch_crud.release_stale_processing`).
    """
    stale = batch_crud.stale_processing_file_ids(db, batch_id)
    released = batch_crud.release_stale_processing(db, stale) if stale else 0
    if released:
        logger.info("Released %d stranded file(s) in batch %s", released, batch_id)

    failed = batch_crud.failed_file_ids(db, batch_id, max_retries=settings.MAX_FILE_RETRIES)
    retried = batch_crud.reset_files_for_retry(db, failed, max_retries=settings.MAX_FILE_RETRIES)

    to_queue = sorted(set(retried) | set(stale[:released] if released else []))
    if not to_queue:
        return [], EXECUTOR_INLINE

    batch_crud.recompute_batch_progress(db, batch_id)
    executor = dispatch_files(db, to_queue)
    return to_queue, executor


def shutdown_inline_pool(wait: bool = False) -> None:
    """
    Stop the inline pool, for application shutdown.

    `wait=False` by default: a batch of 500 files may have hours of work
    queued on it, and blocking a Ctrl-C until that finishes is not a
    shutdown. Files already claimed are left `PROCESSING` and recovered
    by a batch retry, which is exactly the case `retry_batch` handles.
    """
    global _pool
    if _pool is not None:
        _pool.shutdown(wait=wait, cancel_futures=not wait)
        _pool = None
        logger.info("Inline batch executor stopped")
