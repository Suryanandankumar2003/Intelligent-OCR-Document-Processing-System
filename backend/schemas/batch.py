"""
Pydantic schemas for the batch-processing API contract (see
`api/routes/batches.py`).

Every timestamp goes through `schemas/timestamps.py:as_utc`, the same
validator the review schemas use: SQLite hands back naive datetimes for
values that were always stored as UTC, and without the stamp the
frontend's `new Date(...)` would read them as local time and display a
batch as having completed hours before it started.
"""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from core.batch_status import BatchFileStatus, BatchStatus
from core.document_types import DocumentType
from schemas.timestamps import as_utc


class RejectedFileInfo(BaseModel):
    """One file that was not accepted into the batch, and why."""

    original_filename: str
    reason: str = Field(..., description="Why this file was rejected, as a sentence to show the user")


class BatchCreatedResponse(BaseModel):
    """
    The response to `POST /batches/upload`.

    Returned as soon as the files are on disk and the rows are committed
    — *not* when processing finishes. That is the entire point of the
    endpoint: a 500-file upload answers in the time it takes to write 500
    files, and everything after that is observed through the batch's
    status rather than by holding the request open.

    `rejected` is part of the success response rather than an error,
    because a batch where 3 of 200 files were the wrong type is a
    successful upload of 197 documents. Reporting the 3 in the response
    is what lets the UI say so without failing the other 197.
    """

    batch_id: str
    batch_name: str
    total_files: int = Field(..., description="Files accepted into the batch — rejected files are not counted")
    status: BatchStatus
    executor: str = Field(..., description='Which executor took the batch: "celery" or "inline"')
    rejected: list[RejectedFileInfo] = Field(
        default_factory=list, description="Files that were not accepted, with the reason for each"
    )


class BatchSummary(BaseModel):
    """
    One batch as the list page and the progress stream see it.

    Counters come straight from the stored columns rather than being
    recomputed per request — see `database/models.py:Batch` for why they
    are stored, and `batch_crud.recompute_batch_progress` for why storing
    them is safe.
    """

    model_config = ConfigDict(from_attributes=True)

    batch_id: str = Field(..., validation_alias="id", serialization_alias="batch_id")
    batch_name: str
    status: BatchStatus
    total_files: int
    processed_files: int = Field(..., description="Files in a terminal state: successes plus failures")
    successful_files: int
    failed_files: int
    progress_percentage: float = Field(..., ge=0, le=100)
    executor: Optional[str] = None
    created_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    @field_validator("created_at", "started_at", "completed_at")
    @classmethod
    def _stamp_utc(cls, value: Optional[datetime]) -> Optional[datetime]:
        return as_utc(value)


class BatchListResponse(BaseModel):
    """
    One page of batches, plus the total matching the same filters.

    The total is returned alongside the page — unlike `GET /documents`,
    which returns a bare array and leaves the client to page until it
    gets a short batch. That worked for a table the frontend loads
    entirely into memory; a DataGrid doing server-side pagination cannot
    render "1–25 of 340" without being told there are 340.
    """

    total: int
    skip: int
    limit: int
    batches: list[BatchSummary]


class BatchFileSummary(BaseModel):
    """One file inside a batch, as the details page sees it."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    filename: str = Field(..., description="The unique stored name — use this to open the document's review screen")
    original_filename: str = Field(..., description="The name the client uploaded, for display only")
    document_id: Optional[int] = None
    processing_status: BatchFileStatus
    document_type: Optional[DocumentType] = None
    error_message: Optional[str] = None
    retry_count: int
    last_retry_at: Optional[datetime] = None
    processing_time_seconds: Optional[float] = None
    created_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    @field_validator("created_at", "started_at", "completed_at", "last_retry_at")
    @classmethod
    def _stamp_utc(cls, value: Optional[datetime]) -> Optional[datetime]:
        return as_utc(value)


class BatchFileListResponse(BaseModel):
    """One page of a batch's files, plus the matching total."""

    total: int
    skip: int
    limit: int
    files: list[BatchFileSummary]


class BatchDetailResponse(BaseModel):
    """
    Everything the batch details page needs above its file table, in one
    call: the batch itself, its per-status file counts, and whether a
    retry would do anything.

    `status_counts` duplicates information derivable from the batch's own
    counters for two of its four keys, and is sent anyway: the summary
    cards show Processing and Pending as first-class numbers, and those
    are *not* derivable from `processed`/`successful`/`failed` — a file
    that is pending and one that is mid-flight are both "not processed".

    `retryable_file_count` is computed server-side because the rule
    ("failed, and under `MAX_FILE_RETRIES`") belongs with the limit it
    enforces. Sending the raw failure count and letting the client guess
    would make the Retry button offer work the backend then refuses.
    """

    batch: BatchSummary
    status_counts: dict[BatchFileStatus, int]
    retryable_file_count: int
    max_retries: int = Field(..., description="Per-file retry cap, so the UI can explain why a retry is unavailable")


class RetryResponse(BaseModel):
    """The result of a retry request."""

    batch_id: str
    retried_file_ids: list[int]
    retried_count: int
    executor: str
    message: str = Field(..., description="A sentence describing what was queued, for a snackbar")


class BatchProgressEvent(BaseModel):
    """
    One frame of the SSE progress stream (`GET /batches/{id}/stream`).

    Deliberately smaller than `BatchSummary`: this is pushed repeatedly
    for the lifetime of a batch, and the fields it omits — the name, the
    executor, `created_at` — cannot change while it runs. Sending them
    every second would be bytes spent restating what the client already
    has.
    """

    batch_id: str
    status: BatchStatus
    total_files: int
    processed_files: int
    successful_files: int
    failed_files: int
    progress_percentage: float
    is_final: bool = Field(
        ..., description="True on the last frame — the batch reached a terminal status and the stream is closing"
    )
