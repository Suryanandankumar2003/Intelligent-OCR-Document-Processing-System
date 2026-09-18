"""Pydantic schemas for the analytics dashboard API contract (see `api/routes/analytics.py`)."""
from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel, Field

from core.document_types import DocumentType
from core.processing_event import ProcessingStage


class DocumentTypeCount(BaseModel):
    """How many documents of one type exist, for the "documents by type" chart."""

    document_type: DocumentType
    count: int = Field(..., description="Number of documents currently classified as this type")


class StageMetrics(BaseModel):
    """
    Attempt/success/failure counts and average duration for one pipeline
    stage (OCR, Classification, or Extraction), over every attempt ever
    recorded — not scoped to a date range, since "what's our OCR success
    rate" is normally asked about the system as it stands today, not a
    specific historical window (`GET /analytics/daily-trend` is the
    endpoint for a time-scoped view).
    """

    stage: ProcessingStage
    attempts: int = Field(..., description="Every recorded attempt at this stage, successful or not")
    successes: int
    failures: int
    success_rate: Optional[float] = Field(
        default=None, description="successes / attempts, as a fraction 0-1; null if this stage has never been attempted"
    )
    average_duration_ms: Optional[float] = Field(
        default=None,
        description="Average wall-clock time of a successful attempt, in milliseconds; null if this stage has never succeeded",
    )


class AnalyticsSummaryResponse(BaseModel):
    """
    Everything the dashboard's top-level cards, by-type chart, and stage
    table need, in one response — a single request the dashboard fires
    on load rather than one per widget.
    """

    generated_at: datetime = Field(..., description="When this summary was computed (UTC); it is not cached")
    total_documents: int = Field(..., description="Every document ever uploaded, regardless of pipeline progress")
    documents_by_type: list[DocumentTypeCount]
    average_processing_time_seconds: Optional[float] = Field(
        default=None,
        description=(
            "Average time from upload to a successful extraction, across every successful extraction on "
            "record; null if none has ever succeeded"
        ),
    )
    stage_metrics: list[StageMetrics] = Field(
        ..., description="One entry per pipeline stage (OCR, Classification, Extraction)"
    )


class DailyTrendPoint(BaseModel):
    """One day's activity: how many documents were uploaded, and how many were successfully extracted."""

    date: date
    documents_uploaded: int = Field(..., description="Documents whose uploaded_at falls on this day (UTC)")
    documents_extracted: int = Field(
        ..., description="Documents with a successful extraction whose attempt started on this day (UTC)"
    )


class DailyTrendResponse(BaseModel):
    """A zero-filled, contiguous daily time series — every day in range appears, even ones with no activity."""

    days: int = Field(..., description="Size of the requested window, including today")
    trend: list[DailyTrendPoint] = Field(..., description="Oldest day first")
