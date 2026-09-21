"""
Pydantic schemas for the logs API contract (see `api/routes/logs.py`).

Three groups, matching the three things the Logs module does: list and
search entries, open one entry in full, and report on them in aggregate.

Timestamps go through `schemas/timestamps.py:as_utc` for the reason that
module records — SQLite hands a UTC value back naive, and a naive ISO
string is read by `new Date(...)` as local time, silently shifting every
row in the table by the viewer's offset. On a log screen whose entire
purpose is "when did this happen", that is not a cosmetic bug.
"""
from datetime import date, datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from core.document_types import DocumentType
from core.log_events import LogCategory, LogEventType, LogStatus
from schemas.timestamps import as_utc


class LogEntry(BaseModel):
    """
    One `database.models.ApplicationLog` row as the list screen renders
    it.

    Carries `details_json` even in the list response, where nothing shows
    it. That is deliberate: the payload is small (a handful of keys), the
    list is already paged, and including it is what lets "Download log
    entry" on a row be a client-side save of data already in hand rather
    than a second round trip per row — the same reasoning
    `OcrTextPanel`'s download follows on the frontend.
    """

    id: int
    event_type: LogEventType
    event_category: LogCategory
    status: LogStatus
    message: str
    document_id: Optional[int] = Field(
        default=None, description="The document this event was about, if it had one; not a foreign key"
    )
    batch_id: Optional[str] = Field(default=None, description="The batch this event belongs to, if any")
    filename: Optional[str] = Field(default=None, description="Stored filename, kept readable after deletion")
    document_type: Optional[DocumentType] = None
    details_json: Optional[dict[str, Any]] = Field(
        default=None, description="Structured detail whose keys depend on the event type"
    )
    processing_time: Optional[float] = Field(
        default=None, description="How long the operation took, in seconds; null on a Started row"
    )
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)

    @field_validator("created_at")
    @classmethod
    def _stamp_utc(cls, value: datetime) -> datetime:
        return as_utc(value)


class LogListResponse(BaseModel):
    """
    One page of log entries plus the total the filters matched.

    Server-side paging with a real total, unlike `GET /documents` which
    returns a bare array — the same split `GET /batches` already makes,
    and for the same reason. This table grows without bound (every stage
    of every file of every batch writes to it), and every filter it
    offers is a plain indexed predicate, so pushing all of it into SQL is
    less code than loading the table and filtering in the browser, not
    more.
    """

    total: int = Field(..., description="Rows matching the filters, ignoring paging")
    skip: int
    limit: int
    logs: list[LogEntry]


class LogDetailResponse(BaseModel):
    """
    One log entry with the context needed to make sense of it.

    The related document and batch are resolved here rather than left to
    the client to fetch, because the whole reason to open a log entry is
    to find out what it was about, and a details screen that shows an
    opaque `document_id` has answered the question with another question.
    Both are `None` when the event had no such relation *and* when the
    row it named has since been deleted — the log survives its subject,
    see `database/models.py:ApplicationLog`.
    """

    log: LogEntry
    document_exists: bool = Field(
        ...,
        description="Whether the referenced document record is still present; false for a deleted or absent one",
    )
    document_review_status: Optional[str] = Field(
        default=None, description="Where the related document currently sits in the review workflow"
    )
    batch_exists: bool = Field(..., description="Whether the referenced batch record is still present")
    batch_name: Optional[str] = Field(default=None, description="Human-facing name of the related batch")
    related_log_count: int = Field(
        ...,
        description=(
            "How many other entries share this event's document or batch — the size of the story this "
            "entry is one line of"
        ),
    )


class LogFilterOptions(BaseModel):
    """
    The values the logs screen's filter dropdowns offer.

    Served rather than hardcoded in the frontend for the same reason
    `GET /document-types` is: a dropdown built from a copy of a backend
    enum eventually offers a value the backend no longer has, and the
    resulting empty table looks like a bug in the data rather than in
    the list of options.
    """

    event_types: list[LogEventType]
    event_categories: list[LogCategory]
    statuses: list[LogStatus]
    document_types: list[DocumentType]


class LogCategoryCount(BaseModel):
    """How many events one category has, for the event-distribution chart."""

    event_category: LogCategory
    count: int


class LogErrorTrendPoint(BaseModel):
    """One day's failure counts, for the error-trend chart."""

    date: date
    errors: int = Field(..., description="Entries with status Failure logged on this day (UTC)")
    warnings: int
    total: int = Field(..., description="Every entry logged on this day, whatever its status")


class LogProcessingTimePoint(BaseModel):
    """One day's average operation duration, over the entries that recorded one."""

    date: date
    average_seconds: Optional[float] = Field(
        default=None, description="Mean processing_time that day; null on a day with no timed operation"
    )
    timed_events: int = Field(..., description="How many entries that average was computed from")


class LogAnalyticsResponse(BaseModel):
    """
    Everything the logs dashboard's five cards and three charts need, in
    one call.

    Bundled rather than split per widget — unlike the document analytics
    endpoints, which separate the date-scoped trend from the "as of now"
    summary — because every number here is date-scoped by the *same*
    window. There is no control that moves one chart without moving the
    others, so there is nothing for a second endpoint to serve.
    """

    generated_at: datetime
    days: int = Field(..., description="Size of the trailing window the trends cover, including today")
    total_logs: int = Field(..., description="Every entry ever recorded, not scoped to the window")
    errors_today: int = Field(..., description="Failure entries logged since midnight UTC")
    ocr_failures: int = Field(..., description="Failure entries in the OCR category, over the window")
    extraction_failures: int
    batch_failures: int
    events_by_category: list[LogCategoryCount]
    error_trend: list[LogErrorTrendPoint] = Field(..., description="Oldest day first, zero-filled")
    processing_time_trend: list[LogProcessingTimePoint] = Field(..., description="Oldest day first")


class DocumentAuditEntry(BaseModel):
    """
    One entry in a document's audit history — what a reviewer did, when.

    Deliberately one shape for two underlying sources. A field
    correction (`field_corrections`) and a review action (an approval, a
    rejection, a save, in `application_logs`) are stored separately,
    because they are genuinely different things: one is a value that
    changed, the other is a decision somebody made. But a reviewer asking
    "what has happened to this document?" wants them interleaved in one
    chronological list, not two panels they have to merge by eye.

    `field_name`, `original_value` and `updated_value` are populated only
    for a field change; `changed_fields` only for a save that touched
    several at once. A consumer renders whichever is present rather than
    branching on `kind` — though `kind` is there for the one thing the
    payload alone cannot say, which is what icon the row deserves.
    """

    kind: str = Field(..., description="'field_change' or 'action'")
    occurred_at: datetime
    event_type: Optional[LogEventType] = Field(
        default=None, description="For an action: which one. Null for a field change."
    )
    summary: str = Field(..., description="One line describing the entry, ready to render")
    field_name: Optional[str] = None
    original_value: Optional[Any] = Field(
        default=None, description="What AI extraction produced for this field, never a prior correction"
    )
    updated_value: Optional[Any] = None
    changed_fields: Optional[list[str]] = Field(
        default=None, description="Field names touched by one save, for an action entry"
    )

    @field_validator("occurred_at")
    @classmethod
    def _stamp_utc(cls, value: datetime) -> datetime:
        return as_utc(value)


class DocumentAuditResponse(BaseModel):
    """
    A document's full audit history, newest first.

    Newest first, unlike `corrections` on the review response, which is
    oldest first. The two orders answer different questions and both are
    right for theirs: the correction list is read as the story of how a
    field's value got where it is, which only makes sense forwards,
    while the audit panel is opened to find out what happened *last*.
    """

    filename: str
    total_entries: int
    entries: list[DocumentAuditEntry]
