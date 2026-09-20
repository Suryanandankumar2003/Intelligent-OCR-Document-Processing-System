"""
Persistence for batches and the files inside them.

Kept out of `database/crud.py` for the same reason `database/analytics.py`
is: that module answers one question — "how does one `Document` get
written or read" — and this one is about a different aggregate with
different concurrency requirements. Mixing them would make `crud.py`
harder to scan for its own purpose.

Same framework-agnostic rule as the rest of the data layer: every
function takes a plain `Session` and returns plain ORM objects or plain
Python data. No FastAPI, no Celery.

--- The two hard parts ------------------------------------------------

Everything interesting in this module is about several workers writing
to the same batch at once.

1. **Claiming a file** (`claim_batch_file`) is a compare-and-set, not a
   read-then-write. Two workers handed the same file id — which happens
   whenever a task is redelivered after `acks_late`, or when a manual
   retry races the queue — must not both process it. The UPDATE carries
   the expected current status in its WHERE clause, so exactly one of
   them changes a row and the other is told to stand down.

2. **Progress** (`recompute_batch_progress`) is recomputed from scratch
   on every call rather than incremented. See its docstring; the short
   version is that `SET processed = processed + 1` is wrong under
   redelivery and this is not.
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Iterable, Optional, Sequence

from sqlalchemy import and_, case, func, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from core.batch_status import (
    BatchFileStatus,
    BatchStatus,
    RETRYABLE_FILE_STATUSES,
)
from core.document_types import DocumentType
from core.exceptions import DocumentPersistenceError
from database.models import Batch, BatchFile

logger = logging.getLogger(__name__)


def _commit(db: Session) -> None:
    """
    Shared commit/error-translation path, mirroring `crud._commit`.

    Translates a database-level failure into `DocumentPersistenceError`
    — an exception type `app.py` already has a handler for — rather than
    letting a raw `SQLAlchemyError` escape the data layer.
    """
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Batch database commit failed")
        raise DocumentPersistenceError(str(exc)) from exc


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# --- Creation ------------------------------------------------------------


def create_batch(db: Session, *, batch_name: str, files: Sequence[dict]) -> Batch:
    """
    Create one batch and all of its file rows in a single transaction.

    `files` is a sequence of `{"filename": str, "original_filename": str}`
    — the output of `services/batch_service.py` having already written
    each file to disk. Building the rows with `db.add_all` and committing
    once is what keeps a 500-file upload to one transaction instead of
    500: the per-row overhead of SQLite's commit (an fsync each) is what
    would otherwise dominate the request.

    The batch is left `PENDING` with `total_files` set and every other
    counter zero. Dispatch is a separate step on purpose — the rows must
    be committed and visible before any worker is told they exist, or a
    fast worker can look up a file id that its own transaction cannot yet
    see.
    """
    batch = Batch(
        id=uuid.uuid4().hex,
        batch_name=batch_name,
        status=BatchStatus.PENDING,
        total_files=len(files),
    )
    db.add(batch)
    db.add_all(
        BatchFile(
            batch_id=batch.id,
            filename=entry["filename"],
            original_filename=entry["original_filename"],
            processing_status=BatchFileStatus.PENDING,
        )
        for entry in files
    )
    _commit(db)
    db.refresh(batch)
    logger.info("Created batch %s (%r) with %d file(s)", batch.id, batch_name, len(files))
    return batch


# --- Reads ---------------------------------------------------------------


def get_batch(db: Session, batch_id: str) -> Optional[Batch]:
    return db.get(Batch, batch_id)


def list_batches(
    db: Session,
    *,
    skip: int = 0,
    limit: int = 50,
    status: Optional[BatchStatus] = None,
    search: Optional[str] = None,
) -> tuple[list[Batch], int]:
    """
    One page of batches, newest first, plus the total number matching the
    same filters.

    Returns the count alongside the page — unlike `crud.list_documents`,
    which returns a bare list and leaves the frontend to page until it
    gets a short batch. That worked for a table the frontend loads
    entirely into memory; it does not work for a DataGrid doing
    server-side pagination, which cannot render "page 3 of 7" without
    knowing there are 7. The count is a second query rather than a window
    function so it stays portable to a database without them.
    """
    filters = []
    if status is not None:
        filters.append(Batch.status == status)
    if search and search.strip():
        # `ilike` rather than `like`: SQLite's LIKE is already
        # case-insensitive for ASCII, but Postgres's is not, and this is
        # the one place the difference would silently change behaviour on
        # a future migration.
        filters.append(Batch.batch_name.ilike(f"%{search.strip()}%"))

    total = db.execute(select(func.count()).select_from(Batch).where(*filters)).scalar_one()

    stmt = (
        select(Batch)
        .where(*filters)
        # `id` breaks ties on `created_at`: a 500-file upload and the one
        # submitted a moment later can share a timestamp at SQLite's
        # resolution, and an unstable sort makes a paginated list repeat
        # or skip rows between pages.
        .order_by(Batch.created_at.desc(), Batch.id.desc())
        .offset(skip)
        .limit(limit)
    )
    return list(db.execute(stmt).scalars().all()), total


def list_batch_files(
    db: Session,
    *,
    batch_id: str,
    skip: int = 0,
    limit: int = 100,
    status: Optional[BatchFileStatus] = None,
    search: Optional[str] = None,
) -> tuple[list[BatchFile], int]:
    """One page of a batch's files, plus the matching total. Same contract as `list_batches`."""
    filters = [BatchFile.batch_id == batch_id]
    if status is not None:
        filters.append(BatchFile.processing_status == status)
    if search and search.strip():
        needle = f"%{search.strip()}%"
        filters.append(
            BatchFile.original_filename.ilike(needle) | BatchFile.filename.ilike(needle)
        )

    total = db.execute(select(func.count()).select_from(BatchFile).where(*filters)).scalar_one()
    stmt = select(BatchFile).where(*filters).order_by(BatchFile.id.asc()).offset(skip).limit(limit)
    return list(db.execute(stmt).scalars().all()), total


def get_batch_file(db: Session, *, batch_id: str, file_id: int) -> Optional[BatchFile]:
    """
    Scoped to the batch on purpose.

    Looking a file up by id alone would let `/batches/A/files/7/retry`
    act on a file belonging to batch B — an id-substitution bug that is
    invisible until two batches exist.
    """
    stmt = select(BatchFile).where(BatchFile.id == file_id, BatchFile.batch_id == batch_id)
    return db.execute(stmt).scalar_one_or_none()


def pending_file_ids(db: Session, batch_id: str) -> list[int]:
    """Ids of every file in the batch still waiting to be processed, in a stable order."""
    stmt = (
        select(BatchFile.id)
        .where(
            BatchFile.batch_id == batch_id,
            BatchFile.processing_status == BatchFileStatus.PENDING,
        )
        .order_by(BatchFile.id.asc())
    )
    return list(db.execute(stmt).scalars().all())


# --- The claim (duplicate-processing guard) ------------------------------


def claim_batch_file(db: Session, file_id: int) -> Optional[BatchFile]:
    """
    Atomically move one file from a queued state to `PROCESSING`, and
    return it — or return `None` if someone else got there first.

    This is the only thing preventing the same document from being
    OCR'd twice, and it has to be a single guarded UPDATE rather than a
    read, a check, and a write. The gap between reading `PENDING` and
    writing `PROCESSING` is exactly where a redelivered Celery message
    (`acks_late` re-queues a task whose worker died) or a manual retry
    racing the queue slips a second worker through.

    `synchronize_session=False` because nothing in this session has the
    row loaded yet — the fetch below is what loads it, after the UPDATE
    has decided who won.

    Returns the claimed row, or `None` when `rowcount` is 0, which means
    the row was already `PROCESSING` or `SUCCESS`. `None` is not an error
    — it is the expected answer for a duplicate delivery, and the caller
    simply stops.
    """
    now = _utcnow()
    result = db.execute(
        update(BatchFile)
        .where(
            BatchFile.id == file_id,
            BatchFile.processing_status.in_(RETRYABLE_FILE_STATUSES),
        )
        .values(
            processing_status=BatchFileStatus.PROCESSING,
            started_at=now,
            completed_at=None,
            # Cleared here, not on success: a retry in progress should
            # not still be displaying the previous attempt's failure.
            error_message=None,
        )
        .execution_options(synchronize_session=False)
    )
    _commit(db)

    if result.rowcount == 0:
        logger.info("File %s was already claimed by another worker; skipping", file_id)
        return None
    return db.get(BatchFile, file_id)


# --- Per-file outcomes ---------------------------------------------------


def mark_file_succeeded(
    db: Session,
    *,
    file_id: int,
    document_id: Optional[int],
    document_type: Optional[DocumentType],
    processing_time_seconds: float,
) -> None:
    """Record a completed pipeline run: the document it produced, its type, and how long it took."""
    db.execute(
        update(BatchFile)
        .where(BatchFile.id == file_id)
        .values(
            processing_status=BatchFileStatus.SUCCESS,
            document_id=document_id,
            document_type=document_type,
            error_message=None,
            processing_time_seconds=processing_time_seconds,
            completed_at=_utcnow(),
        )
        .execution_options(synchronize_session=False)
    )
    _commit(db)


def mark_file_failed(
    db: Session,
    *,
    file_id: int,
    error_message: str,
    processing_time_seconds: Optional[float] = None,
) -> None:
    """
    Record a failed pipeline run.

    The message is truncated rather than stored unbounded: it can
    originate from an upstream SDK error whose text is not under this
    project's control, and a details page that renders a 40KB stack trace
    into a table cell is not a better page than one that renders the
    first 2000 characters.
    """
    db.execute(
        update(BatchFile)
        .where(BatchFile.id == file_id)
        .values(
            processing_status=BatchFileStatus.FAILED,
            error_message=error_message[:2000],
            processing_time_seconds=processing_time_seconds,
            completed_at=_utcnow(),
        )
        .execution_options(synchronize_session=False)
    )
    _commit(db)


# --- Progress ------------------------------------------------------------


def recompute_batch_progress(db: Session, batch_id: str) -> Optional[Batch]:
    """
    Recalculate a batch's five counters and its status from its files,
    and persist them. Returns the updated batch, or `None` if it is gone.

    --- Why recompute instead of increment -----------------------------

    `UPDATE batches SET processed_files = processed_files + 1` is one
    statement and is wrong. It is correct only if every file transitions
    to a terminal state exactly once, and the things this system does
    routinely — `acks_late` redelivering a task whose worker was killed,
    an operator retrying a failed file, a batch retried wholesale — each
    break that assumption in a different direction. The counters would
    drift upward, and nothing would ever correct them; a batch would sit
    at "103 of 100 processed" with no way back.

    Recomputing is a single GROUP BY over one indexed column
    (`batch_files.batch_id`) across at most `MAX_BATCH_FILES` rows, so
    the cost is a few hundred microseconds against a table small enough
    to be entirely in SQLite's page cache. In exchange the counters are
    *self-healing*: whatever went wrong, the next file to finish restores
    the truth.

    --- Why it is one statement and not a read then a write ------------

    Because two workers finish files at the same moment, and this is the
    function both of them call. Written as "SELECT the counts, assign
    them to the ORM object, commit", the two interleave like this:

        A: reads {3 success}      -> status COMPLETED, successful 3
        B: reads {2 success, 1 pending}, a snapshot taken before A wrote
        A: commits
        B: commits                -> successful 2, progress 66.7%

    and because SQLAlchemy emits only the columns *that session* saw
    change, B's UPDATE can carry the stale counters while leaving A's
    status untouched — producing a batch that reads "Completed" next to
    "2 of 3, 66.7%". Nothing recomputes afterwards, because there are no
    files left to finish, so that contradiction is permanent: the exact
    opposite of the self-healing claimed above.

    Doing the whole thing as one UPDATE whose values are correlated
    subqueries closes the gap. The counts are read and written inside a
    single statement, so a concurrent recompute runs either entirely
    before it or entirely after it, and whichever runs last is the one
    that saw every committed file. Every column is also written
    together, so no mixture of two snapshots can survive.

    This is not a SQLite quirk — it is the ordinary lost-update race,
    and it is reachable wherever two workers share a batch, which is the
    normal case for the threads pool this project ships with.

    --- The status rules -----------------------------------------------

    Derived, never set by hand, so there is one definition of what
    "Partially Completed" means rather than one per call site:

      * anything still pending or processing -> `PROCESSING`
        (or `PENDING` if nothing has started yet)
      * all done, none failed                -> `COMPLETED`
      * all done, all failed                 -> `FAILED`
      * all done, some failed                -> `PARTIALLY_COMPLETED`

    A batch that reopens because its failed files were retried passes
    back through `PROCESSING` by exactly these rules, with no special
    case for the transition.
    """
    # Existence is still checked up front, so a deleted batch answers
    # `None` rather than an UPDATE that silently matches no rows.
    if db.get(Batch, batch_id) is None:
        return None

    def _count(*conditions):
        """A correlated scalar subquery counting this batch's files."""
        return (
            select(func.count())
            .select_from(BatchFile)
            .where(BatchFile.batch_id == batch_id, *conditions)
            .scalar_subquery()
        )

    total = _count()
    successful = _count(BatchFile.processing_status == BatchFileStatus.SUCCESS)
    failed = _count(BatchFile.processing_status == BatchFileStatus.FAILED)
    processing = _count(BatchFile.processing_status == BatchFileStatus.PROCESSING)
    pending = _count(BatchFile.processing_status == BatchFileStatus.PENDING)
    processed = successful + failed
    outstanding = pending + processing

    # The same four rules as before, expressed as a CASE so they are
    # evaluated against the same snapshot as the counters above. Order
    # matters, and matches the prose in the docstring.
    status = case(
        # `PENDING` only while genuinely untouched, so the list can
        # distinguish "queued, waiting for a worker" from "running".
        (and_(outstanding > 0, processed + processing == 0), BatchStatus.PENDING),
        (outstanding > 0, BatchStatus.PROCESSING),
        (failed == 0, BatchStatus.COMPLETED),
        (successful == 0, BatchStatus.FAILED),
        else_=BatchStatus.PARTIALLY_COMPLETED,
    )

    db.execute(
        update(Batch)
        .where(Batch.id == batch_id)
        .values(
            total_files=total,
            processed_files=processed,
            successful_files=successful,
            failed_files=failed,
            # An empty batch reads as 100% rather than dividing by zero.
            # It cannot occur through the API (`EmptyBatchError` rejects
            # it) but can if every file row is deleted, and "0 of 0 done"
            # is complete.
            progress_percentage=case(
                (total == 0, 100.0),
                else_=func.round(processed * 100.0 / func.nullif(total, 0), 1),
            ),
            status=status,
            completed_at=case(
                # Cleared when a batch reopens, so a retried batch does
                # not keep claiming it finished at a time before its
                # newest file ran.
                (outstanding > 0, None),
                # Stamped once: a batch that was already finished keeps
                # the moment it first finished.
                (Batch.completed_at.is_(None), _utcnow()),
                else_=Batch.completed_at,
            ),
        )
        .execution_options(synchronize_session=False)
    )
    _commit(db)

    # Re-read after the write, because the values the caller wants are
    # the ones the database computed, not the ones this session happened
    # to be holding before the UPDATE ran.
    batch = db.get(Batch, batch_id)
    if batch is not None:
        db.refresh(batch)
    return batch


def mark_batch_started(db: Session, batch_id: str, *, executor: str) -> None:
    """
    Stamp `started_at` and record which executor took the batch.

    `started_at` is written only once — the first worker to pick up any
    file in the batch sets it, and a later retry must not overwrite it,
    or the queue-wait measurement (`started_at - created_at`) silently
    becomes a measurement of the retry instead.
    """
    db.execute(
        update(Batch)
        .where(Batch.id == batch_id, Batch.started_at.is_(None))
        .values(started_at=_utcnow(), status=BatchStatus.PROCESSING, executor=executor)
        .execution_options(synchronize_session=False)
    )
    _commit(db)


# --- Retries -------------------------------------------------------------


def reset_files_for_retry(db: Session, file_ids: Iterable[int], *, max_retries: int) -> list[int]:
    """
    Move each eligible failed file back to `PENDING`, bump its retry
    count, and return the ids actually reset.

    Eligibility is checked in the UPDATE's WHERE clause, not in Python
    beforehand, for the same reason `claim_batch_file` is a
    compare-and-set: a file that another worker is already retrying must
    not be reset underneath it, and `retry_count < max_retries` evaluated
    in the database is what makes the cap hold when two retry requests
    arrive together.

    Returning the ids that were actually reset — rather than the ids
    requested — is what lets the caller distinguish "nothing was
    eligible" (every file has exhausted its retries) from "done", and
    report the difference honestly.
    """
    file_ids = list(file_ids)
    if not file_ids:
        return []

    eligible_stmt = select(BatchFile.id).where(
        BatchFile.id.in_(file_ids),
        BatchFile.processing_status == BatchFileStatus.FAILED,
        BatchFile.retry_count < max_retries,
    )
    eligible = list(db.execute(eligible_stmt).scalars().all())
    if not eligible:
        return []

    db.execute(
        update(BatchFile)
        .where(BatchFile.id.in_(eligible))
        .values(
            processing_status=BatchFileStatus.PENDING,
            retry_count=BatchFile.retry_count + 1,
            last_retry_at=_utcnow(),
            error_message=None,
            completed_at=None,
            processing_time_seconds=None,
        )
        .execution_options(synchronize_session=False)
    )
    _commit(db)
    logger.info("Reset %d file(s) for retry", len(eligible))
    return eligible


def failed_file_ids(db: Session, batch_id: str, *, max_retries: Optional[int] = None) -> list[int]:
    """
    Every failed file in the batch; with `max_retries`, only those that
    still have retries left.

    The unfiltered form is what the details page counts to decide whether
    to offer "Retry all failed" at all; the filtered form is what the
    retry endpoint acts on.
    """
    filters = [
        BatchFile.batch_id == batch_id,
        BatchFile.processing_status == BatchFileStatus.FAILED,
    ]
    if max_retries is not None:
        filters.append(BatchFile.retry_count < max_retries)
    stmt = select(BatchFile.id).where(*filters).order_by(BatchFile.id.asc())
    return list(db.execute(stmt).scalars().all())


def batch_file_status_counts(db: Session, batch_id: str) -> dict[BatchFileStatus, int]:
    """
    Per-status file counts for one batch, every status present with an
    explicit zero.

    The details page's summary cards need "0 processing" to render as a
    zero rather than as a missing card, and having the query fill the
    gaps means neither the route nor the UI has to know the full set of
    statuses to do it.
    """
    stmt = (
        select(BatchFile.processing_status, func.count())
        .where(BatchFile.batch_id == batch_id)
        .group_by(BatchFile.processing_status)
    )
    counts = {status: 0 for status in BatchFileStatus}
    for status, count in db.execute(stmt).all():
        counts[status] = count
    return counts


def retryable_file_count(db: Session, batch_id: str, *, max_retries: int) -> int:
    """How many failed files in this batch still have retries left — drives the Retry button's enabled state."""
    stmt = select(func.count()).select_from(BatchFile).where(
        BatchFile.batch_id == batch_id,
        BatchFile.processing_status == BatchFileStatus.FAILED,
        BatchFile.retry_count < max_retries,
    )
    return db.execute(stmt).scalar_one()


def delete_batch(db: Session, batch: Batch) -> None:
    """
    Delete a batch and its file rows.

    The `Document` rows the batch produced are deliberately left alone —
    they are the system's permanent record of those documents and are
    reachable, reviewable and exportable independently of how they were
    uploaded. The FK is `ON DELETE SET NULL` in that direction for
    exactly this reason (see `database/models.py:BatchFile`).
    """
    db.delete(batch)
    _commit(db)


def stale_processing_file_ids(db: Session, batch_id: str) -> list[int]:
    """
    Files stuck in `PROCESSING` for this batch.

    A file lands here when the worker holding it died between claiming it
    and recording an outcome — a killed process, a hard time limit, a
    machine reboot. Nothing will ever move it on its own, because the
    claim already succeeded, so a whole-batch retry needs to be able to
    find and release them (see `services/batch_dispatch.py:retry_batch`).
    """
    stmt = (
        select(BatchFile.id)
        .where(
            BatchFile.batch_id == batch_id,
            BatchFile.processing_status == BatchFileStatus.PROCESSING,
        )
        .order_by(BatchFile.id.asc())
    )
    return list(db.execute(stmt).scalars().all())


def release_stale_processing(db: Session, file_ids: Iterable[int]) -> int:
    """
    Force files stuck in `PROCESSING` back to `PENDING` so they can be
    requeued. Returns how many were released.

    Deliberately does not bump `retry_count`: these files never produced
    an outcome, so counting the lost attempt against a budget meant for
    genuine failures would let an unlucky worker restart permanently
    exhaust a document's retries.
    """
    file_ids = list(file_ids)
    if not file_ids:
        return 0
    result = db.execute(
        update(BatchFile)
        .where(
            BatchFile.id.in_(file_ids),
            BatchFile.processing_status == BatchFileStatus.PROCESSING,
        )
        .values(processing_status=BatchFileStatus.PENDING, started_at=None)
        .execution_options(synchronize_session=False)
    )
    _commit(db)
    return result.rowcount


def batch_summary_row(db: Session, batch_id: str) -> Optional[tuple]:
    """
    The minimum a progress stream needs, as one row: status, the four
    counters, and the percentage.

    A dedicated narrow query rather than loading the `Batch` ORM object,
    because the SSE stream re-runs this every second per connected
    client. Selecting seven scalars avoids constructing (and identity-
    mapping, and later expiring) a full entity to read seven numbers off
    it.
    """
    stmt = select(
        Batch.status,
        Batch.total_files,
        Batch.processed_files,
        Batch.successful_files,
        Batch.failed_files,
        Batch.progress_percentage,
        Batch.completed_at,
    ).where(Batch.id == batch_id)
    return db.execute(stmt).one_or_none()


def batch_counts_by_status(db: Session) -> dict[BatchStatus, int]:
    """Batch counts grouped by status, every status present — for the analytics cards."""
    stmt = select(Batch.status, func.count()).group_by(Batch.status)
    counts = {status: 0 for status in BatchStatus}
    for status, count in db.execute(stmt).all():
        counts[status] = count
    return counts


def file_outcome_totals(db: Session) -> tuple[int, int, int]:
    """
    System-wide `(total, successful, failed)` file counts across every
    batch, in one query.

    `case()` rather than three separate COUNT queries: the analytics
    dashboard asks for all three together, and one pass over the table
    beats three.
    """
    stmt = select(
        func.count(),
        func.sum(case((BatchFile.processing_status == BatchFileStatus.SUCCESS, 1), else_=0)),
        func.sum(case((BatchFile.processing_status == BatchFileStatus.FAILED, 1), else_=0)),
    ).select_from(BatchFile)
    total, successful, failed = db.execute(stmt).one()
    # SUM over zero rows is NULL, not 0.
    return total or 0, successful or 0, failed or 0
