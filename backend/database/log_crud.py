"""
Reads and writes against `application_logs` — the query layer behind the
Logs screen, its analytics dashboard, and its xlsx export.

Its own module rather than more functions on `database/crud.py`, for the
same reason `database/analytics.py` and `database/batch_crud.py` are:
`crud.py` answers "how does one Document get written or read", and a
reader opening it should not have to wade past a filter builder and four
GROUP BY reports to find out.

--- Writes never raise -------------------------------------------------

`record_log` swallows database failures and returns `None`, exactly as
`crud.record_processing_event` does and for the same reason spelled out
there: this is a record *about* an operation that has already succeeded
or failed on its own terms. An upload that worked must not become a 500
because the audit row describing it could not be written. Everything
else in this module is a read, and reads are allowed to fail — a logs
screen that cannot load should say so.

--- Filtering is SQL, not Python --------------------------------------

Every filter the Logs screen offers — category, type, status, document
type, date range, free-text — is a predicate over an indexed column or a
`LIKE` over two text ones, so all of it is pushed into the query and the
frontend renders a page it is handed. That is the opposite of the
documents list (`database/crud.py:list_documents`, filtered in the
browser), and the difference follows the data: that table is bounded by
what one operator has processed and its search runs over values inside a
JSON column, while this one grows by several rows per file per batch and
has nothing hiding in JSON that the search needs to see.
"""
import logging
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterator, Optional, Sequence

from sqlalchemy import Select, func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from core.document_types import DocumentType
from core.log_events import LogCategory, LogEventType, LogStatus
from database.models import ApplicationLog

logger = logging.getLogger(__name__)

#: Columns the list endpoint will sort on, by the name the API accepts.
#: A whitelist rather than `getattr(ApplicationLog, sort_by)`: that would
#: let a query parameter name any attribute on the class, including ones
#: that are not columns at all, and turn a typo into a 500.
SORTABLE_COLUMNS = {
    "created_at": ApplicationLog.created_at,
    "event_type": ApplicationLog.event_type,
    "event_category": ApplicationLog.event_category,
    "status": ApplicationLog.status,
    "filename": ApplicationLog.filename,
    "processing_time": ApplicationLog.processing_time,
}

DEFAULT_SORT = "created_at"


def record_log(
    db: Session,
    *,
    event_type: LogEventType,
    event_category: LogCategory,
    status: LogStatus,
    message: str,
    document_id: Optional[int] = None,
    batch_id: Optional[str] = None,
    filename: Optional[str] = None,
    document_type: Optional[DocumentType] = None,
    details_json: Optional[dict[str, Any]] = None,
    processing_time: Optional[float] = None,
) -> Optional[ApplicationLog]:
    """
    Append one entry. Returns it, or `None` if the write failed.

    Failure is logged to the Python logger and swallowed — see the module
    docstring. Note the rollback on failure: without it the session is
    left in a failed-transaction state, and the *caller's* next commit
    (saving the extraction this log was describing) would fail too, which
    would turn a best-effort logger into the thing that broke the
    request it was only supposed to observe.
    """
    entry = ApplicationLog(
        event_type=event_type,
        event_category=event_category,
        status=status,
        message=message,
        document_id=document_id,
        batch_id=batch_id,
        filename=filename,
        document_type=document_type,
        details_json=details_json,
        processing_time=processing_time,
    )
    db.add(entry)
    try:
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        logger.exception(
            "Failed to record application log (event_type=%r, filename=%r) — dropping it",
            event_type.value,
            filename,
        )
        return None
    db.refresh(entry)
    return entry


def event_already_logged(
    db: Session,
    *,
    event_type: LogEventType,
    batch_id: Optional[str] = None,
    document_id: Optional[int] = None,
) -> bool:
    """
    Whether this event has already been recorded for this batch/document.

    The guard behind `services/event_log.py:log_once`. Needed because a
    handful of events are "the whole thing finished", and the code that
    notices is per-file: the last file of a batch to complete is the one
    that sees a terminal status, but two files finishing in the same
    moment can both see it. Without this check that batch would report
    having completed twice, which on an audit log is not a cosmetic
    duplicate — it is the log asserting something untrue.

    An indexed existence check on `batch_id`/`document_id` plus
    `event_type`, so it costs an index seek on the one path that runs it.
    It is not a uniqueness *constraint*: two workers racing can both read
    "no" before either writes. That window is microseconds against a
    local SQLite file and the cost of losing it is one duplicate row, so
    a constraint (and the failed-insert handling it would need at every
    call site) is not worth buying.
    """
    stmt = select(ApplicationLog.id).where(ApplicationLog.event_type == event_type).limit(1)
    if batch_id is not None:
        stmt = stmt.where(ApplicationLog.batch_id == batch_id)
    if document_id is not None:
        stmt = stmt.where(ApplicationLog.document_id == document_id)
    return db.execute(stmt).first() is not None


def _apply_filters(
    stmt: Select,
    *,
    search: Optional[str] = None,
    event_type: Optional[LogEventType] = None,
    event_category: Optional[LogCategory] = None,
    status: Optional[LogStatus] = None,
    document_type: Optional[DocumentType] = None,
    batch_id: Optional[str] = None,
    filename: Optional[str] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
) -> Select:
    """
    Add every supplied filter to `stmt`. Shared by the list query, its
    count, and the export iterator, so those three can never disagree
    about what a filter means — the bug that makes "export what I'm
    looking at" quietly export something else.

    `search` matches the message, the stored filename and the batch id,
    case-insensitively. It deliberately does *not* match `event_type` or
    `event_category`: both have their own dropdown, and folding them into
    the free-text box would make typing "error" return every row in the
    Error category as well as every message containing the word, with no
    way to ask for only one.
    """
    if search and search.strip():
        needle = f"%{search.strip()}%"
        stmt = stmt.where(
            or_(
                ApplicationLog.message.ilike(needle),
                ApplicationLog.filename.ilike(needle),
                ApplicationLog.batch_id.ilike(needle),
            )
        )
    if event_type is not None:
        stmt = stmt.where(ApplicationLog.event_type == event_type)
    if event_category is not None:
        stmt = stmt.where(ApplicationLog.event_category == event_category)
    if status is not None:
        stmt = stmt.where(ApplicationLog.status == status)
    if document_type is not None:
        stmt = stmt.where(ApplicationLog.document_type == document_type)
    if batch_id is not None:
        stmt = stmt.where(ApplicationLog.batch_id == batch_id)
    if filename is not None:
        stmt = stmt.where(ApplicationLog.filename == filename)
    if date_from is not None:
        stmt = stmt.where(ApplicationLog.created_at >= date_from)
    if date_to is not None:
        stmt = stmt.where(ApplicationLog.created_at <= date_to)
    return stmt


def list_logs(
    db: Session,
    *,
    skip: int = 0,
    limit: int = 50,
    sort_by: str = DEFAULT_SORT,
    descending: bool = True,
    **filters: Any,
) -> tuple[list[ApplicationLog], int]:
    """
    One page of entries plus the total the filters matched.

    The total is a second query rather than a window function, which is
    two round trips instead of one. That is the right trade here: the
    count runs against the same indexed predicates as the page and, on a
    table this shape, is cheaper than making every row of the page carry
    a repeated total through the result set.

    Ordering always falls back to `id` after the requested column. Sorting
    by, say, `status` leaves thousands of rows tied, and a tie SQLite is
    free to break differently on each query means a row can appear on two
    consecutive pages while another appears on neither — the classic
    unstable-pagination bug, which is invisible in testing and infuriating
    in use.
    """
    column = SORTABLE_COLUMNS.get(sort_by, SORTABLE_COLUMNS[DEFAULT_SORT])
    order = (column.desc(), ApplicationLog.id.desc()) if descending else (column.asc(), ApplicationLog.id.asc())

    stmt = _apply_filters(select(ApplicationLog), **filters).order_by(*order).offset(skip).limit(limit)
    count_stmt = _apply_filters(select(func.count()).select_from(ApplicationLog), **filters)

    logs = list(db.execute(stmt).scalars().all())
    total = db.execute(count_stmt).scalar_one()
    return logs, total


def get_log(db: Session, log_id: int) -> Optional[ApplicationLog]:
    """One entry by primary key, or `None`."""
    return db.get(ApplicationLog, log_id)


def count_related_logs(
    db: Session, *, document_id: Optional[int], batch_id: Optional[str], exclude_id: int
) -> int:
    """
    How many *other* entries share this one's document or batch.

    The number the details screen shows as "part of a larger story" — a
    single OCR failure means one thing on its own and another as one of
    forty in the same batch. Returns 0 when the entry relates to neither,
    rather than counting the whole table.
    """
    conditions = []
    if document_id is not None:
        conditions.append(ApplicationLog.document_id == document_id)
    if batch_id is not None:
        conditions.append(ApplicationLog.batch_id == batch_id)
    if not conditions:
        return 0

    stmt = (
        select(func.count())
        .select_from(ApplicationLog)
        .where(or_(*conditions), ApplicationLog.id != exclude_id)
    )
    return db.execute(stmt).scalar_one()


def iter_logs_for_export(db: Session, *, batch_size: int = 1000, **filters: Any) -> Iterator[ApplicationLog]:
    """
    Yield every matching entry, oldest first, holding at most one
    `batch_size` chunk in memory at a time.

    Keyset pagination on `id`, exactly as
    `database/crud.py:iter_documents_for_export` does and for the reason
    given there: OFFSET paging rescans and discards an ever-larger prefix
    as the offset grows, which is quadratic work over a full-table export
    — and this table is the one in the schema most likely to reach
    millions of rows, since it gains several per file per batch.

    Oldest first, unlike the list screen. A spreadsheet of logs is read
    top to bottom as a sequence of events, and a reader scrolling into
    the middle of one should be moving forwards through time.
    """
    last_seen_id = 0
    while True:
        stmt = _apply_filters(
            select(ApplicationLog).where(ApplicationLog.id > last_seen_id), **filters
        ).order_by(ApplicationLog.id.asc()).limit(batch_size)

        batch = list(db.execute(stmt).scalars().all())
        if not batch:
            return

        yield from batch
        last_seen_id = batch[-1].id

        # A short batch is the only reliable "that was the last page"
        # signal once filters are involved — a full one does not promise
        # more rows exist, but a short one promises none do.
        if len(batch) < batch_size:
            return


# --- Analytics -----------------------------------------------------------
#
# Same conventions as `database/analytics.py`: day bucketing is done in
# Python rather than with a database-specific date-truncation function,
# so nothing here has to be rewritten if this project ever moves off
# SQLite; and every series is zero-filled, so a chart never has to guess
# whether a missing day means "nothing happened" or "no data came back".


def _as_utc_date(value: datetime) -> date:
    """SQLite returns a naive datetime for a value stored as UTC; treat it as UTC."""
    return value.date()


def _window_start(days: int) -> datetime:
    """Midnight UTC, `days - 1` days ago — the inclusive start of a trailing window that includes today."""
    start_date = datetime.now(timezone.utc).date() - timedelta(days=days - 1)
    return datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)


def total_logs(db: Session) -> int:
    """Every entry ever recorded. Deliberately not windowed — it is the "how much history is there" number."""
    return db.execute(select(func.count()).select_from(ApplicationLog)).scalar_one()


def errors_today(db: Session) -> int:
    """
    Failures logged since midnight UTC.

    UTC, not the viewer's local midnight, because that is the boundary
    every other date bucket in this module uses and a card that disagreed
    with the chart beside it about when "today" started would be read as
    one of the two being broken.
    """
    today = datetime.now(timezone.utc).date()
    start = datetime(today.year, today.month, today.day, tzinfo=timezone.utc)
    stmt = (
        select(func.count())
        .select_from(ApplicationLog)
        .where(ApplicationLog.status == LogStatus.FAILURE, ApplicationLog.created_at >= start)
    )
    return db.execute(stmt).scalar_one()


def failure_counts_by_category(
    db: Session, categories: Sequence[LogCategory], *, days: int
) -> dict[LogCategory, int]:
    """
    Failures per category over the trailing window, for the spotlight
    cards (OCR, Extraction, Batch — see
    `core/log_events.py:FAILURE_SPOTLIGHT_CATEGORIES`).

    Always returns an entry for every requested category, including zero,
    so the caller renders a card reading "0" rather than dropping it —
    a card that disappears when things are going well is a card nobody
    trusts when it reappears.
    """
    stmt = (
        select(ApplicationLog.event_category, func.count())
        .where(
            ApplicationLog.status == LogStatus.FAILURE,
            ApplicationLog.event_category.in_(categories),
            ApplicationLog.created_at >= _window_start(days),
        )
        .group_by(ApplicationLog.event_category)
    )
    counts = {category: 0 for category in categories}
    for category, count in db.execute(stmt).all():
        counts[category] = count
    return counts


def events_by_category(db: Session, *, days: int) -> list[tuple[LogCategory, int]]:
    """Event counts per category over the window, largest first — the event-distribution chart."""
    stmt = (
        select(ApplicationLog.event_category, func.count())
        .where(ApplicationLog.created_at >= _window_start(days))
        .group_by(ApplicationLog.event_category)
        .order_by(func.count().desc())
    )
    return list(db.execute(stmt).all())


def error_trend(db: Session, *, days: int) -> list[dict]:
    """
    One entry per day, oldest first:
    `{"date", "errors", "warnings", "total"}`.

    `total` rides along with the two failure counts because an error
    count on its own is unreadable: ten failures on a day with twelve
    events and ten on a day with four thousand are opposite facts, and
    the chart needs both to say which one it is showing.
    """
    start_date = datetime.now(timezone.utc).date() - timedelta(days=days - 1)
    stmt = select(ApplicationLog.created_at, ApplicationLog.status).where(
        ApplicationLog.created_at >= _window_start(days)
    )

    errors: dict[date, int] = defaultdict(int)
    warnings: dict[date, int] = defaultdict(int)
    totals: dict[date, int] = defaultdict(int)
    for created_at, status in db.execute(stmt).all():
        day = _as_utc_date(created_at)
        totals[day] += 1
        if status == LogStatus.FAILURE:
            errors[day] += 1
        elif status == LogStatus.WARNING:
            warnings[day] += 1

    return [
        {
            "date": start_date + timedelta(days=offset),
            "errors": errors[start_date + timedelta(days=offset)],
            "warnings": warnings[start_date + timedelta(days=offset)],
            "total": totals[start_date + timedelta(days=offset)],
        }
        for offset in range(days)
    ]


def processing_time_trend(db: Session, *, days: int) -> list[dict]:
    """
    Mean `processing_time` per day, oldest first, over the entries that
    recorded one.

    `average_seconds` is `None` — never `0.0` — on a day with no timed
    operation, so the chart can break its line rather than draw a dip to
    zero that claims everything suddenly got instantaneous. `timed_events`
    is what makes that distinguishable downstream without re-deriving it.

    Only completion rows carry a duration (a `STARTED` row has nothing to
    measure yet), so no filter on status is needed: the `IS NOT NULL`
    already selects exactly the operations that finished.
    """
    start_date = datetime.now(timezone.utc).date() - timedelta(days=days - 1)
    stmt = select(ApplicationLog.created_at, ApplicationLog.processing_time).where(
        ApplicationLog.created_at >= _window_start(days),
        ApplicationLog.processing_time.is_not(None),
    )

    sums: dict[date, float] = defaultdict(float)
    counts: dict[date, int] = defaultdict(int)
    for created_at, processing_time in db.execute(stmt).all():
        day = _as_utc_date(created_at)
        sums[day] += processing_time
        counts[day] += 1

    points = []
    for offset in range(days):
        day = start_date + timedelta(days=offset)
        count = counts[day]
        points.append(
            {
                "date": day,
                "average_seconds": (sums[day] / count) if count else None,
                "timed_events": count,
            }
        )
    return points


def list_document_action_logs(
    db: Session, *, document_id: Optional[int], filename: str
) -> list[ApplicationLog]:
    """
    The review actions recorded against one document — saves, approvals,
    rejections — newest first.

    The action half of the audit history (the other half is
    `crud.list_field_corrections`). Matched on `document_id` *or*
    `filename`, not one or the other: a log written before the document
    row existed carries only the filename, and a log for a document
    deleted and re-uploaded under the same stored name would otherwise
    strand its earlier entries. Both columns are indexed, so the `OR`
    still resolves by index rather than by scan.
    """
    from core.log_events import REVIEW_ACTION_EVENT_TYPES

    identity = [ApplicationLog.filename == filename]
    if document_id is not None:
        identity.append(ApplicationLog.document_id == document_id)

    stmt = (
        select(ApplicationLog)
        .where(
            or_(*identity),
            ApplicationLog.event_type.in_(REVIEW_ACTION_EVENT_TYPES),
        )
        .order_by(ApplicationLog.created_at.desc(), ApplicationLog.id.desc())
    )
    return list(db.execute(stmt).scalars().all())
