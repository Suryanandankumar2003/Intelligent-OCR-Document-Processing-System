"""
Read-only aggregation queries for the batch half of the analytics
dashboard.

Sits beside `database/analytics.py` and follows its conventions exactly:
plain `Session` in, plain Python data out; date bucketing done in Python
rather than with a database-specific truncation function, so this stays
portable to Postgres; and every "no data yet" answer is `None` rather
than `0`, because a dashboard that reports a 0% success rate when nothing
has run is lying.

Kept as its own module rather than appended to `analytics.py` because
the two answer different questions over different tables — that one is
about documents and pipeline stages, this one about batches and their
files — and because the batch tables are the ones that will grow.
"""
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from core.batch_status import BatchFileStatus, BatchStatus
from database.models import Batch, BatchFile


def _as_utc_date(value: datetime) -> date:
    """
    SQLite returns a naive datetime for a value stored as UTC — the same
    fact `database/analytics.py` works around. Treated as UTC here too,
    so "which day" means one thing across both modules.
    """
    return value.date()


def total_batches(db: Session) -> int:
    return db.execute(select(func.count()).select_from(Batch)).scalar_one()


def batch_counts_by_status(db: Session) -> dict[BatchStatus, int]:
    """Batch counts per status, every status present with an explicit zero."""
    stmt = select(Batch.status, func.count()).group_by(Batch.status)
    counts = {status: 0 for status in BatchStatus}
    for status, count in db.execute(stmt).all():
        counts[status] = count
    return counts


def file_outcome_totals(db: Session) -> dict:
    """
    System-wide file counts across every batch, in one pass.

    `case()` inside a single SELECT rather than three COUNT queries: the
    dashboard needs all four numbers together, and one scan of the table
    beats three. `SUM` over zero rows is NULL in SQL, hence the `or 0`.
    """
    stmt = select(
        func.count(),
        func.sum(case((BatchFile.processing_status == BatchFileStatus.SUCCESS, 1), else_=0)),
        func.sum(case((BatchFile.processing_status == BatchFileStatus.FAILED, 1), else_=0)),
        func.sum(case((BatchFile.processing_status == BatchFileStatus.PROCESSING, 1), else_=0)),
    ).select_from(BatchFile)
    total, successful, failed, processing = db.execute(stmt).one()

    total = total or 0
    successful = successful or 0
    failed = failed or 0
    processed = successful + failed

    return {
        "total_files": total,
        "successful_files": successful,
        "failed_files": failed,
        "processing_files": processing or 0,
        # Rates are over *processed* files, not over all files. Dividing
        # by the total would make a batch that is half-finished report a
        # 50% success rate purely because the other half hasn't run —
        # the number would drift upward as work completed and mean
        # nothing at any point in between.
        "success_rate": (successful / processed) if processed else None,
        "failure_rate": (failed / processed) if processed else None,
    }


def average_file_processing_seconds(db: Session) -> Optional[float]:
    """
    Mean wall-clock time for one document's full pipeline, across every
    successful file in every batch.

    Uses `batch_files.processing_time_seconds` rather than summing the
    per-stage `ProcessingEvent` durations, because the two measure
    different things: the stage durations exclude the time between
    stages, and this is the number a throughput estimate is actually made
    of ("500 files at 8s each across 4 workers").

    Only successful files are averaged. A file that failed after two
    seconds because the type was unsupported would otherwise drag the
    mean down while describing nothing about how long processing takes.
    """
    stmt = select(func.avg(BatchFile.processing_time_seconds)).where(
        BatchFile.processing_status == BatchFileStatus.SUCCESS,
        BatchFile.processing_time_seconds.is_not(None),
    )
    value = db.execute(stmt).scalar_one_or_none()
    return float(value) if value is not None else None


def average_batch_size(db: Session) -> Optional[float]:
    """Mean `total_files` across every batch, or `None` when no batch has ever been created."""
    value = db.execute(select(func.avg(Batch.total_files))).scalar_one_or_none()
    return float(value) if value is not None else None


def average_batch_duration_seconds(db: Session) -> Optional[float]:
    """
    Mean elapsed time from a batch's first file starting to its last one
    finishing, over completed batches only.

    Measured from `started_at`, not `created_at`, so the figure describes
    how long the work took rather than how long it waited in a queue —
    those are different numbers with different fixes (more workers vs.
    faster processing), and averaging them together would hide both.

    Computed in Python because subtracting two timestamps portably is
    otherwise dialect-specific (`julianday` on SQLite, an interval on
    Postgres), and the row count here is the number of batches ever run.
    """
    stmt = select(Batch.started_at, Batch.completed_at).where(
        Batch.started_at.is_not(None),
        Batch.completed_at.is_not(None),
    )
    durations = [
        (completed_at - started_at).total_seconds()
        for started_at, completed_at in db.execute(stmt).all()
        # A clock adjustment mid-batch can invert these. Dropping the
        # row is better than letting a negative duration pull the mean.
        if completed_at >= started_at
    ]
    if not durations:
        return None
    return sum(durations) / len(durations)


def daily_batch_volume(db: Session, *, days: int) -> list[dict]:
    """
    One entry per day for the last `days` days including today, oldest
    first:
    `{"date", "batches_created", "files_submitted", "files_succeeded", "files_failed"}`.

    Zero-filled, so a chart never has to guess whether a missing day
    means "nothing happened" or "no data came back" — the same contract
    `database/analytics.py:daily_trend` provides.

    Batches bucket by `Batch.created_at`; file outcomes bucket by
    `BatchFile.completed_at`, deliberately unlinked. A batch uploaded at
    23:55 whose files finish after midnight belongs to one day and its
    outcomes to the next, and forcing them onto the same day would
    misreport both the volume and the throughput.
    """
    today = datetime.now(timezone.utc).date()
    start_date = today - timedelta(days=days - 1)
    range_start = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)

    batches_created: dict[date, int] = defaultdict(int)
    files_submitted: dict[date, int] = defaultdict(int)
    batch_rows = db.execute(
        select(Batch.created_at, Batch.total_files).where(Batch.created_at >= range_start)
    ).all()
    for created_at, total_files in batch_rows:
        day = _as_utc_date(created_at)
        batches_created[day] += 1
        files_submitted[day] += total_files or 0

    succeeded: dict[date, int] = defaultdict(int)
    failed: dict[date, int] = defaultdict(int)
    file_rows = db.execute(
        select(BatchFile.completed_at, BatchFile.processing_status).where(
            BatchFile.completed_at.is_not(None),
            BatchFile.completed_at >= range_start,
        )
    ).all()
    for completed_at, status in file_rows:
        day = _as_utc_date(completed_at)
        if status == BatchFileStatus.SUCCESS:
            succeeded[day] += 1
        elif status == BatchFileStatus.FAILED:
            failed[day] += 1

    return [
        {
            "date": (day := start_date + timedelta(days=offset)),
            "batches_created": batches_created[day],
            "files_submitted": files_submitted[day],
            "files_succeeded": succeeded[day],
            "files_failed": failed[day],
        }
        for offset in range(days)
    ]
