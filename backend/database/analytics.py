"""
Read-only aggregation queries backing the analytics dashboard
(`api/routes/analytics.py`).

Kept separate from `database/crud.py` on purpose: `crud.py` is one row's
worth of get/create/update/delete against the `documents` table — this
module is GROUP BY / AVG / date-bucketing reporting, often spanning both
`documents` and `processing_events`. Mixing the two would make crud.py
harder to scan for the question every other module in this codebase
actually asks of it: "how does one Document get written or read".

Every function here takes a plain `Session` and returns plain Python
data (dicts/tuples/floats) — the same framework-agnostic rule the rest
of the data-access layer follows.

Date-range and day-bucketing arithmetic is done in Python rather than
with a database-specific date-truncation function (SQLite's `date()`,
Postgres's `date_trunc`). `database/session.py` already notes this
project wants to stay portable to a networked database later, and a
dashboard's query volume — read once per page load, over however many
documents/events actually exist — is small enough that grouping in
Python costs nothing worth trading that portability for.
"""
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from core.document_types import DocumentType
from core.processing_event import ProcessingStage, ProcessingStatus
from database.models import Document, ProcessingEvent


def _as_utc_date(value: datetime) -> date:
    """
    SQLite hands back a naive `datetime` for a value that was always
    stored as UTC — the same fact `schemas/review.py`'s `_as_utc` works
    around at the API boundary. Treated as UTC here too, so "which day"
    a timestamp falls on means the same thing everywhere in this module.
    """
    return value.date()


def total_documents(db: Session) -> int:
    """Every row in `documents`, regardless of how far through the pipeline it's gotten."""
    return db.execute(select(func.count()).select_from(Document)).scalar_one()


def documents_by_type(db: Session) -> list[tuple[DocumentType, int]]:
    """Document count grouped by type, most common first."""
    stmt = (
        select(Document.document_type, func.count())
        .group_by(Document.document_type)
        .order_by(func.count().desc())
    )
    return list(db.execute(stmt).all())


def stage_metrics(db: Session) -> dict[ProcessingStage, dict]:
    """
    Per-stage attempt/success/failure counts, plus average duration
    among successful attempts — the data behind "OCR success rate" and
    "extraction success rate", generalized to every pipeline stage
    rather than hardcoding just those two. Classification is exactly the
    same kind of measurement; leaving it out of a dashboard that already
    has the data for it would make the dashboard less honest about the
    pipeline, not simpler.

    Always returns one entry per `ProcessingStage`, even one with zero
    recorded attempts (e.g. right after this feature is first deployed,
    before any instrumented route has run) — the caller decides how to
    render "no data yet" rather than this function omitting the stage.
    """
    counts_stmt = select(ProcessingEvent.stage, ProcessingEvent.status, func.count()).group_by(
        ProcessingEvent.stage, ProcessingEvent.status
    )
    durations_stmt = (
        select(ProcessingEvent.stage, func.avg(ProcessingEvent.duration_ms))
        .where(ProcessingEvent.status == ProcessingStatus.SUCCESS)
        .group_by(ProcessingEvent.stage)
    )

    results = {
        stage: {"attempts": 0, "successes": 0, "failures": 0, "average_duration_ms": None} for stage in ProcessingStage
    }
    for stage, status, count in db.execute(counts_stmt).all():
        entry = results[stage]
        entry["attempts"] += count
        if status == ProcessingStatus.SUCCESS:
            entry["successes"] = count
        else:
            entry["failures"] = count
    for stage, avg_duration in db.execute(durations_stmt).all():
        results[stage]["average_duration_ms"] = float(avg_duration) if avg_duration is not None else None

    return results


def average_processing_time_seconds(db: Session) -> Optional[float]:
    """
    Average time from a document's upload to a *successful* extraction
    of it, across every successful extraction event on record — not just
    the first per document, since a later successful re-extraction
    reflects current system performance at least as well as a stale
    first attempt would.

    Computed in Python: fetch every successful extraction event's
    `(filename, started_at, duration_ms)`, batch-look-up each filename's
    `Document.uploaded_at`, and average
    `(event.started_at + event.duration_ms) - document.uploaded_at`.

    A filename with no matching `Document` is skipped — the document was
    deleted after the event was recorded (`processing_events`
    deliberately outlives the document it describes; see
    `database/models.py:ProcessingEvent`), so there's no upload
    timestamp left to measure from.

    Returns `None` when there's nothing to average — no successful
    extraction has ever been recorded — rather than `0.0`, which would
    misleadingly read as "processing is instantaneous".
    """
    events_stmt = select(ProcessingEvent.filename, ProcessingEvent.started_at, ProcessingEvent.duration_ms).where(
        ProcessingEvent.stage == ProcessingStage.EXTRACTION, ProcessingEvent.status == ProcessingStatus.SUCCESS
    )
    events = list(db.execute(events_stmt).all())
    if not events:
        return None

    filenames = {filename for filename, _, _ in events}
    uploaded_at_by_filename = dict(
        db.execute(select(Document.filename, Document.uploaded_at).where(Document.filename.in_(filenames))).all()
    )

    durations_seconds = []
    for filename, started_at, duration_ms in events:
        uploaded_at = uploaded_at_by_filename.get(filename)
        if uploaded_at is None:
            continue
        completed_at = started_at + timedelta(milliseconds=duration_ms)
        durations_seconds.append((completed_at - uploaded_at).total_seconds())

    if not durations_seconds:
        return None
    return sum(durations_seconds) / len(durations_seconds)


def daily_trend(db: Session, *, days: int) -> list[dict]:
    """
    One entry per day for the last `days` days including today, oldest
    first: `{"date": date, "documents_uploaded": int, "documents_extracted": int}`.

    Zero-filled for a day with no activity at all, so a trend chart never
    has to guess whether a missing day means "nothing happened" or "no
    data came back".

    "Uploaded" buckets by `Document.uploaded_at`; "extracted" buckets by
    the `started_at` of a *successful* extraction `ProcessingEvent` —
    two different, deliberately unlinked counts (a document uploaded
    near midnight can easily be extracted the next day), not "uploaded
    but not yet extracted" split out of one total.
    """
    today = datetime.now(timezone.utc).date()
    start_date = today - timedelta(days=days - 1)
    range_start = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)

    uploaded_counts: dict[date, int] = defaultdict(int)
    for (uploaded_at,) in db.execute(select(Document.uploaded_at).where(Document.uploaded_at >= range_start)).all():
        uploaded_counts[_as_utc_date(uploaded_at)] += 1

    extracted_counts: dict[date, int] = defaultdict(int)
    extraction_events_stmt = select(ProcessingEvent.started_at).where(
        ProcessingEvent.stage == ProcessingStage.EXTRACTION,
        ProcessingEvent.status == ProcessingStatus.SUCCESS,
        ProcessingEvent.started_at >= range_start,
    )
    for (started_at,) in db.execute(extraction_events_stmt).all():
        extracted_counts[_as_utc_date(started_at)] += 1

    return [
        {
            "date": start_date + timedelta(days=offset),
            "documents_uploaded": uploaded_counts[start_date + timedelta(days=offset)],
            "documents_extracted": extracted_counts[start_date + timedelta(days=offset)],
        }
        for offset in range(days)
    ]
