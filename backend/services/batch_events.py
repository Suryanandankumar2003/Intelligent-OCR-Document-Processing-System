"""
The application-log entries a batch worker writes: one file started, one
file finished, and — once — the batch itself completing.

--- Why this is shared when the executors are not ---------------------

`services/batch_dispatch.py` explains at length why `_process_file_inline`
is a near-copy of `worker/tasks.py:process_batch_file` rather than a call
into a shared helper: the two differ in exactly the places that matter
(Celery's soft time limit, task retry, session lifecycle), and a helper
taking those three as parameters would be harder to follow than either
version.

None of that applies to *logging*. These three functions take plain
values, make no decisions about control flow, and have no reason to
differ between the two executors — and if they did differ, the symptom
would be a Logs screen where a batch looks different depending on
whether Redis happened to be running, which is the one thing that
absolutely must not vary between the two paths. So the logging is shared
and the orchestration is not.

--- Every function here is best-effort ---------------------------------

They are called from worker threads and Celery tasks whose whole design
is that a failure is a value in a column, never an exception that
propagates. `services/event_log.py` already swallows its own database
errors; these add nothing that could raise on top of it beyond building
a message, and they are still called from inside the executors' existing
try/except structure rather than outside it.
"""
import logging
from typing import Optional

from sqlalchemy.orm import Session

from core.batch_status import ACTIVE_BATCH_STATUSES
from core.document_types import DocumentType
from core.log_events import LogEventType, LogStatus
from database.models import Batch
from services.event_log import log_event, log_once

logger = logging.getLogger(__name__)


def log_file_started(
    db: Session,
    *,
    batch_id: str,
    batch_file_id: int,
    filename: str,
    original_filename: str,
    retry_count: int,
    executor: str,
) -> None:
    """
    Record that a worker has claimed this file and is about to run it.

    Written *after* the claim, not before. A claim can fail — that is
    what makes duplicate delivery safe — and a "started" row for a file
    another worker already owns would put two starts against one file in
    the log, which is precisely the signature this table uses to mean
    "something ran twice".

    `retry_count` rides along because it is the difference between a file
    that is being processed and one that is being processed *again*, and
    that distinction is invisible from the timestamps alone.
    """
    log_event(
        db,
        event_type=LogEventType.BATCH_FILE_STARTED,
        status=LogStatus.STARTED,
        message=f"Processing '{original_filename}' in batch {batch_id}.",
        batch_id=batch_id,
        filename=filename,
        details={
            "batch_file_id": batch_file_id,
            "original_filename": original_filename,
            "attempt": retry_count + 1,
            "executor": executor,
        },
    )


def log_file_succeeded(
    db: Session,
    *,
    batch_id: str,
    batch_file_id: int,
    filename: str,
    original_filename: str,
    retry_count: int,
    executor: str,
    document_id: Optional[int],
    document_type: DocumentType,
    extracted: bool,
    processing_time_seconds: float,
) -> None:
    """
    Record a file that finished its pipeline.

    `extracted` is carried separately from the status because a document
    that classified as `Unknown` succeeded — nothing went wrong, the
    transcript and the verdict are both saved — but produced no fields.
    `services/document_pipeline.py` makes that distinction deliberately
    ("Unknown is an outcome, not a failure"), and a log that collapsed it
    into a plain success would leave an operator wondering why a batch of
    300 successes yielded 280 reviewable documents.
    """
    log_event(
        db,
        event_type=LogEventType.BATCH_FILE_COMPLETED,
        status=LogStatus.SUCCESS if extracted else LogStatus.WARNING,
        message=(
            f"Processed '{original_filename}' as {document_type.value}."
            if extracted
            else f"Processed '{original_filename}', but its type could not be identified — no fields extracted."
        ),
        batch_id=batch_id,
        filename=filename,
        document_id=document_id,
        document_type=document_type,
        details={
            "batch_file_id": batch_file_id,
            "original_filename": original_filename,
            "attempt": retry_count + 1,
            "executor": executor,
            "extracted": extracted,
        },
        processing_time=processing_time_seconds,
    )
    _log_retry_completed(
        db,
        batch_id=batch_id,
        batch_file_id=batch_file_id,
        filename=filename,
        original_filename=original_filename,
        retry_count=retry_count,
        outcome="Success",
        processing_time_seconds=processing_time_seconds,
    )


def log_file_failed(
    db: Session,
    *,
    batch_id: str,
    batch_file_id: int,
    filename: str,
    original_filename: str,
    retry_count: int,
    executor: str,
    error_message: str,
    processing_time_seconds: Optional[float] = None,
) -> None:
    """
    Record a file that failed, with the same sentence stored on its row.

    Deliberately the *same* message the `batch_files.error_message`
    column gets, not a second wording of it. Two descriptions of one
    failure — one in the file table, one in the log — is how an operator
    ends up unsure whether they are looking at one problem or two.
    """
    log_event(
        db,
        event_type=LogEventType.BATCH_FILE_FAILED,
        status=LogStatus.FAILURE,
        message=f"Failed to process '{original_filename}': {error_message}",
        batch_id=batch_id,
        filename=filename,
        details={
            "batch_file_id": batch_file_id,
            "original_filename": original_filename,
            "attempt": retry_count + 1,
            "executor": executor,
            "error_message": error_message,
        },
        processing_time=processing_time_seconds,
    )
    _log_retry_completed(
        db,
        batch_id=batch_id,
        batch_file_id=batch_file_id,
        filename=filename,
        original_filename=original_filename,
        retry_count=retry_count,
        outcome="Failure",
        processing_time_seconds=processing_time_seconds,
    )


def _log_retry_completed(
    db: Session,
    *,
    batch_id: str,
    batch_file_id: int,
    filename: str,
    original_filename: str,
    retry_count: int,
    outcome: str,
    processing_time_seconds: Optional[float],
) -> None:
    """
    Close the loop on a retry — but only for a file that actually was
    one.

    `RETRY_STARTED` is written per *request* by the retry endpoints, and
    that request returns the moment the work is queued. This is the other
    end of it, per file, once the file has actually run. Without it the
    Retry category would be a list of intentions with no outcomes.

    Skipped entirely on a first attempt (`retry_count == 0`), which is
    the overwhelming majority of files — so this costs one extra row only
    on the path where a second row genuinely says something new.
    """
    if retry_count <= 0:
        return

    log_event(
        db,
        event_type=LogEventType.RETRY_COMPLETED,
        status=LogStatus.SUCCESS if outcome == "Success" else LogStatus.FAILURE,
        message=f"Retry {retry_count} of '{original_filename}' finished: {outcome}.",
        batch_id=batch_id,
        filename=filename,
        details={
            "batch_file_id": batch_file_id,
            "original_filename": original_filename,
            "retry_count": retry_count,
            "outcome": outcome,
        },
        processing_time=processing_time_seconds,
    )


def log_batch_completed(db: Session, batch: Optional[Batch]) -> None:
    """
    Record that a batch has finished, if it has, and if nobody has
    already said so.

    Called by every worker after `recompute_batch_progress`, because that
    is the only moment anything in this system learns a batch is done —
    there is no batch-level callback, by design (`worker/tasks.py`: one
    task per file, not one per batch). The file that happens to finish
    last is the one that sees a terminal status.

    Two guards, both needed:

    * the status check, because every *other* file's recompute sees a
      batch still in flight;
    * `log_once`, because two files finishing in the same instant both
      see the terminal status, and a batch that reports completing twice
      is an audit log stating something untrue.

    A batch reopened by a retry passes back through `PROCESSING` and can
    complete again — and will *not* be logged again, because `log_once`
    has no notion of "since the last retry". That is the right trade: the
    `RETRY_STARTED`/`RETRY_COMPLETED` pair already records the second
    run, and a duplicate completion row would be indistinguishable from
    the double-write bug this guard exists to prevent.
    """
    if batch is None or batch.status in ACTIVE_BATCH_STATUSES:
        return

    log_once(
        db,
        event_type=LogEventType.BATCH_COMPLETED,
        batch_id=batch.id,
        status=LogStatus.SUCCESS if batch.failed_files == 0 else LogStatus.WARNING,
        message=(
            f"Batch '{batch.batch_name}' finished: {batch.successful_files} succeeded, "
            f"{batch.failed_files} failed of {batch.total_files}."
        ),
        details={
            "batch_name": batch.batch_name,
            "final_status": batch.status.value,
            "total_files": batch.total_files,
            "successful_files": batch.successful_files,
            "failed_files": batch.failed_files,
            "executor": batch.executor,
        },
        processing_time=(
            (batch.completed_at - batch.started_at).total_seconds()
            if batch.completed_at is not None and batch.started_at is not None
            else None
        ),
    )
