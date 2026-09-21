"""
The Logs module's HTTP surface: a searchable, filterable, sortable,
paged view of `application_logs`, one entry in full, the analytics
behind the dashboard, and the xlsx export.

  GET /logs                one page of entries, with filters and sorting
  GET /logs/filters        the values the filter dropdowns offer
  GET /logs/analytics      cards and charts for the logs dashboard
  GET /logs/export/xlsx    the matching entries as a downloadable workbook
  GET /logs/{log_id}       one entry, with its related document and batch

Same layering as every other route module: this file does HTTP concerns
only. `database/log_crud.py` decides which rows and in what order,
`services/log_export_service.py` decides what the spreadsheet looks like,
`core/log_events.py` owns the vocabulary. None of the three knows this
module exists.

--- Route order is load-bearing ---------------------------------------

`/logs/filters`, `/logs/analytics` and `/logs/export/xlsx` are declared
*before* `/logs/{log_id}`. Starlette matches in registration order, and
`log_id` is typed `int` — which does not save us, because FastAPI
matches the path first and validates the parameter second, so a request
for `/logs/analytics` reaching `/logs/{log_id}` is a 422 complaining
that "analytics" is not an integer, not a fall-through to the next
route. The same trap `api/routes/export.py` documents for
`/documents/export/xlsx`, and the same fix.

--- One filter vocabulary for three endpoints -------------------------

The list, the export and (partly) the analytics all take the same
filters, declared once in `LogFilters` below and depended on rather than
repeated. That is what makes "Export filtered logs" true by
construction: the export cannot drift from the list, because there is
only one definition of what a filter is and `log_crud._apply_filters` is
the only thing that turns it into SQL. The five export buttons the brief
asks for — all, filtered, a date range, errors only, OCR only — are then
not five endpoints but five sets of values for the same one.
"""
import logging
import os
import tempfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask

from core.document_types import DocumentType
from core.log_events import (
    FAILURE_SPOTLIGHT_CATEGORIES,
    LogCategory,
    LogEventType,
    LogStatus,
)
from database import log_crud
from database.models import Batch, Document
from database.session import get_db
from schemas.logs import (
    LogAnalyticsResponse,
    LogCategoryCount,
    LogDetailResponse,
    LogEntry,
    LogErrorTrendPoint,
    LogFilterOptions,
    LogListResponse,
    LogProcessingTimePoint,
)
from services.event_log import track_event

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/logs", tags=["Logs"])

_XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@dataclass
class LogFilters:
    """
    Every filter the logs screen offers, as one dependency.

    A dataclass behind `Depends` rather than six repeated `Query`
    parameters on three endpoints: the alternative is three copies of the
    same list that have to be kept identical by hand, and the first one
    to fall behind is the export — which then quietly downloads a
    different set of rows than the table it was launched from.

    Every field is optional and they compose, which is what lets the one
    export endpoint serve all five buttons the brief asks for. "Errors
    only" is `status=Failure`; "OCR only" is `event_category=OCR`; a date
    range is the two timestamps; "what I'm looking at" is whatever the
    screen currently has; and "everything" is no parameters at all.
    """

    search: Optional[str] = None
    event_type: Optional[LogEventType] = None
    event_category: Optional[LogCategory] = None
    status: Optional[LogStatus] = None
    document_type: Optional[DocumentType] = None
    batch_id: Optional[str] = None
    filename: Optional[str] = None
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None

    def as_kwargs(self) -> dict:
        """The keyword arguments `database.log_crud`'s query builders take."""
        return asdict(self)


def log_filters(
    search: Optional[str] = Query(
        default=None, description="Case-insensitive match on the message, stored filename, or batch id"
    ),
    event_type: Optional[LogEventType] = Query(default=None, description="Only this event type"),
    event_category: Optional[LogCategory] = Query(default=None, description="Only this category"),
    log_status: Optional[LogStatus] = Query(
        default=None,
        alias="status",
        description="Only entries with this outcome (Started, Success, Failure, Warning)",
    ),
    document_type: Optional[DocumentType] = Query(
        default=None, description="Only entries about a document of this type"
    ),
    batch_id: Optional[str] = Query(default=None, description="Only entries belonging to this batch"),
    filename: Optional[str] = Query(default=None, description="Only entries about this stored filename"),
    date_from: Optional[datetime] = Query(default=None, description="Entries logged at or after this moment"),
    date_to: Optional[datetime] = Query(default=None, description="Entries logged at or before this moment"),
) -> LogFilters:
    """
    Bind the query string to `LogFilters`.

    `status` is aliased rather than named directly because `status` is
    also FastAPI's own imported module name in most route files here, and
    the parameter that shadows it has bitten this codebase before — see
    `api/routes/batches.py`, which spells the same parameter
    `status_filter` for the same reason.
    """
    return LogFilters(
        search=search,
        event_type=event_type,
        event_category=event_category,
        status=log_status,
        document_type=document_type,
        batch_id=batch_id,
        filename=filename,
        date_from=date_from,
        date_to=date_to,
    )


@router.get("", response_model=LogListResponse, summary="Search, filter, sort and page the application log")
def list_logs(
    filters: LogFilters = Depends(log_filters),
    skip: int = Query(default=0, ge=0, description="Number of entries to skip"),
    limit: int = Query(default=50, ge=1, le=500, description="Maximum number of entries to return"),
    sort_by: str = Query(
        default=log_crud.DEFAULT_SORT,
        description=f"One of: {', '.join(sorted(log_crud.SORTABLE_COLUMNS))}",
    ),
    sort_dir: str = Query(default="desc", pattern="^(asc|desc)$", description="Sort direction"),
    db: Session = Depends(get_db),
) -> LogListResponse:
    """
    Newest first by default, because the question asked of a log screen
    on arrival is always "what just happened".

    An unknown `sort_by` falls back to the default rather than answering
    422. A sort order is a display preference, not a request for data:
    refusing the whole page because a stale bookmark names a column that
    has since been renamed would hide the logs over a detail the reader
    did not choose and cannot see. The accepted values are listed in the
    parameter's description and in `GET /logs/filters`, so a client that
    wants to get it right has what it needs.
    """
    logs, total = log_crud.list_logs(
        db,
        skip=skip,
        limit=limit,
        sort_by=sort_by,
        descending=sort_dir == "desc",
        **filters.as_kwargs(),
    )
    return LogListResponse(
        total=total,
        skip=skip,
        limit=limit,
        logs=[LogEntry.model_validate(entry) for entry in logs],
    )


@router.get("/filters", response_model=LogFilterOptions, summary="The values the log filters accept")
def get_log_filter_options() -> LogFilterOptions:
    """
    Every value each filter dropdown can offer, straight from the enums.

    From the enums rather than from `SELECT DISTINCT` over the table on
    purpose. A distinct query would only ever offer values that have
    already occurred, so on a fresh install the "Failure" option would
    not exist until something had failed — and the first person to look
    for errors would conclude the filter was broken. The full vocabulary
    is a fact about the system, not about its history.

    Takes no database session for the same reason.
    """
    return LogFilterOptions(
        event_types=list(LogEventType),
        event_categories=list(LogCategory),
        statuses=list(LogStatus),
        document_types=list(DocumentType),
    )


@router.get("/analytics", response_model=LogAnalyticsResponse, summary="Cards and charts for the logs dashboard")
def get_log_analytics(
    days: int = Query(default=30, ge=1, le=365, description="Size of the trailing window, including today"),
    db: Session = Depends(get_db),
) -> LogAnalyticsResponse:
    """
    The five cards and three charts, in one call.

    Computed fresh on every request rather than cached, the same choice
    `GET /analytics/summary` makes and for the same reason recorded
    there: these are a handful of grouped counts either way, and a
    dashboard that can silently show stale numbers is a worse failure
    mode than one extra query per page load.

    `total_logs` is deliberately *not* windowed while everything else is.
    It answers "how much history is there", which is the one number on
    the screen that a 30-day window would make meaningless — the card
    would read the same as the trend chart's sum and tell nobody
    anything.
    """
    spotlight = log_crud.failure_counts_by_category(db, FAILURE_SPOTLIGHT_CATEGORIES, days=days)

    return LogAnalyticsResponse(
        generated_at=datetime.now(timezone.utc),
        days=days,
        total_logs=log_crud.total_logs(db),
        errors_today=log_crud.errors_today(db),
        ocr_failures=spotlight.get(LogCategory.OCR, 0),
        extraction_failures=spotlight.get(LogCategory.EXTRACTION, 0),
        batch_failures=spotlight.get(LogCategory.BATCH, 0),
        events_by_category=[
            LogCategoryCount(event_category=category, count=count)
            for category, count in log_crud.events_by_category(db, days=days)
        ],
        error_trend=[LogErrorTrendPoint(**point) for point in log_crud.error_trend(db, days=days)],
        processing_time_trend=[
            LogProcessingTimePoint(**point) for point in log_crud.processing_time_trend(db, days=days)
        ],
    )


def _download_name(filters: LogFilters) -> str:
    """
    A filename that says what is in the file.

    This is the name the browser saves the download under (through
    `Content-Disposition`, which the frontend reads — see `app.py`'s
    `expose_headers`), so someone who exports "OCR failures" twice a week
    ends up with a folder they can read rather than a pile of identical
    `logs.xlsx`.

    The free-text `search` is deliberately left out, exactly as
    `api/routes/export.py` leaves it out: it is arbitrary user input, and
    sanitizing it into something safe on every filesystem is more risk
    than the extra word is worth.
    """
    parts = ["logs"]
    if filters.status is not None:
        parts.append(filters.status.value)
    if filters.event_category is not None:
        parts.append(filters.event_category.value)
    if filters.event_type is not None:
        parts.append(filters.event_type.value)
    parts.append(f"{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}")
    # Spaces land in the header's quoted filename legally but survive the
    # round-trip badly across browsers and shells.
    return "_".join(part.replace(" ", "-") for part in parts) + ".xlsx"


def _loggable_filters(filters: LogFilters) -> dict:
    """
    The filters an export ran with, as a payload safe to keep forever.

    Enum members become their values so the payload is plain JSON, and
    the free-text `search` becomes a boolean. That last one is not
    laziness: a log of what people typed into a search box accumulates
    into a record of what they were looking for, which is a different
    and more sensitive thing than a record of what the system did. The
    same reasoning keeps `search` out of the download filename.
    """
    return {
        "event_type": filters.event_type.value if filters.event_type else None,
        "event_category": filters.event_category.value if filters.event_category else None,
        "status": filters.status.value if filters.status else None,
        "document_type": filters.document_type.value if filters.document_type else None,
        "batch_id": filters.batch_id,
        "filename": filters.filename,
        "date_from": filters.date_from.isoformat() if filters.date_from else None,
        "date_to": filters.date_to.isoformat() if filters.date_to else None,
        "search_applied": bool(filters.search and filters.search.strip()),
    }


@router.get(
    "/export/xlsx",
    response_class=FileResponse,
    summary="Download the matching log entries as an xlsx workbook",
)
def export_logs_xlsx(
    filters: LogFilters = Depends(log_filters),
    db: Session = Depends(get_db),
) -> FileResponse:
    """
    Builds the workbook to a temporary file and streams that file back,
    never an in-memory buffer — the same end-to-end streaming contract
    `api/routes/export.py` documents: `write_logs_xlsx` bounds the
    writing side, and `FileResponse` over a real path bounds the sending
    side, since Starlette streams a file in chunks rather than holding
    the whole body in memory the way returning `bytes` would.

    The temp file is removed once the response has been sent
    (`BackgroundTask`, which Starlette runs after the last chunk goes
    out), so an abandoned download does not leak a file and a download
    still in progress does not have its file deleted underneath it.

    No parameters at all exports every log. That is intentional and is
    the "Export all logs" button; it is also why this endpoint streams
    rather than materializing, since "every log" on a system that has run
    a few large batches is the largest table in the database.
    """
    entries = log_crud.iter_logs_for_export(db, **filters.as_kwargs())

    fd, tmp_path = tempfile.mkstemp(suffix=".xlsx", prefix="logs_export_")
    os.close(fd)  # Only the path is needed; openpyxl opens and writes the file itself.
    destination = Path(tmp_path)

    # Imported here rather than at module import so that a missing or
    # broken openpyxl cannot stop the whole Logs screen from loading —
    # the list, the detail and the analytics endpoints have no use for
    # it, and an import error at module scope would take all three down
    # with the export.
    from services.log_export_service import write_logs_xlsx

    # Yes, exporting the log writes to the log. That is deliberate and
    # not a loop: the pair of rows is written once per request and
    # nothing reads them back, so there is no recursion to bound. The
    # start row is committed before the iterator is consumed and will
    # therefore appear *inside* its own export, which is the honest
    # answer — the export did happen during the window it covers, and a
    # log that hid its own reads would be the one thing an audit trail
    # must not be.
    with track_event(
        db,
        started=LogEventType.EXPORT_STARTED,
        completed=LogEventType.EXPORT_COMPLETED,
        start_message="Log export started.",
        success_message="Log export completed.",
    ) as details:
        details.update({"format": "xlsx", "target": "logs", "filters": _loggable_filters(filters)})
        details["row_count"] = write_logs_xlsx(entries, destination)

    return FileResponse(
        destination,
        media_type=_XLSX_MEDIA_TYPE,
        filename=_download_name(filters),
        background=BackgroundTask(destination.unlink, missing_ok=True),
    )


@router.get("/{log_id}", response_model=LogDetailResponse, summary="One log entry, with its related records")
def get_log_detail(log_id: int, db: Session = Depends(get_db)) -> LogDetailResponse:
    """
    One entry plus enough context to act on it.

    The related document and batch are resolved here rather than left to
    the client, because the reason to open a log entry is to find out
    what it was about and a screen showing a bare `document_id` has
    answered that with another question.

    Both lookups tolerate the record being gone, and say so
    (`document_exists` / `batch_exists`) rather than 404-ing the log
    entry. A log deliberately outlives its subject — see
    `database/models.py:ApplicationLog` — and "the document this refers
    to has since been deleted" is one of the more useful things an audit
    trail can tell you, not an error.
    """
    entry = log_crud.get_log(db, log_id)
    if entry is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"No log entry found with id {log_id}."
        )

    document = db.get(Document, entry.document_id) if entry.document_id is not None else None
    batch = db.get(Batch, entry.batch_id) if entry.batch_id is not None else None

    return LogDetailResponse(
        log=LogEntry.model_validate(entry),
        document_exists=document is not None,
        document_review_status=document.review_status.value if document is not None else None,
        batch_exists=batch is not None,
        batch_name=batch.batch_name if batch is not None else None,
        related_log_count=log_crud.count_related_logs(
            db, document_id=entry.document_id, batch_id=entry.batch_id, exclude_id=entry.id
        ),
    )
