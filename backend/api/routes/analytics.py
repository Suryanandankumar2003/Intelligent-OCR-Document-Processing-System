"""
Analytics dashboard endpoints: aggregate, read-only reporting over every
processed document and every recorded pipeline attempt.

Two endpoints rather than one per metric (total documents, by-type
breakdown, stage success rates, and average processing time are all
"as of right now" facts about the whole system, cheap to compute
together) — but the daily trend is its own call, since it's parameterized
by a date range a caller might reasonably want to vary independently of
everything else on the dashboard, and bundling it into the summary would
mean re-fetching totals/by-type/stage metrics every time someone just
widens the trend window.

Registered under `/analytics`, not nested under `/documents` like the
review and export endpoints — this isn't about any one document, it's
cross-cutting reporting over the whole table plus `processing_events`.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from database import analytics, batch_analytics
from database.session import get_db
from schemas.analytics import (
    AnalyticsSummaryResponse,
    BatchAnalyticsSummary,
    BatchStatusCount,
    BatchVolumePoint,
    BatchVolumeResponse,
    DailyTrendPoint,
    DailyTrendResponse,
    DocumentTypeCount,
    StageMetrics,
)

router = APIRouter(prefix="/analytics", tags=["Analytics"])


@router.get(
    "/summary",
    response_model=AnalyticsSummaryResponse,
    summary="Overall document and pipeline-health metrics",
)
def get_analytics_summary(db: Session = Depends(get_db)) -> AnalyticsSummaryResponse:
    """
    Total documents, the by-type breakdown, average end-to-end
    processing time, and per-stage (OCR / Classification / Extraction)
    attempt counts and success rates — everything computed fresh on
    every call directly from `documents` and `processing_events`
    (`database/analytics.py`), not cached or pre-aggregated. At this
    project's scale that's a deliberate simplicity choice, not an
    oversight: these are the same handful of GROUP BY/AVG queries either
    way, and a dashboard that can silently show stale numbers is a worse
    failure mode than one extra query per page load.
    """
    stage_metrics_by_stage = analytics.stage_metrics(db)

    return AnalyticsSummaryResponse(
        generated_at=datetime.now(timezone.utc),
        total_documents=analytics.total_documents(db),
        documents_by_type=[
            DocumentTypeCount(document_type=document_type, count=count)
            for document_type, count in analytics.documents_by_type(db)
        ],
        average_processing_time_seconds=analytics.average_processing_time_seconds(db),
        stage_metrics=[
            StageMetrics(
                stage=stage,
                attempts=metrics["attempts"],
                successes=metrics["successes"],
                failures=metrics["failures"],
                success_rate=(metrics["successes"] / metrics["attempts"]) if metrics["attempts"] > 0 else None,
                average_duration_ms=metrics["average_duration_ms"],
            )
            # Iterates `stage_metrics_by_stage` (a plain dict keyed by
            # `ProcessingStage`) rather than `ProcessingStage` itself, but
            # `database.analytics.stage_metrics` guarantees every stage
            # is a key regardless of whether it's ever been attempted —
            # so this always emits exactly one row per stage, in the
            # enum's declared order (OCR, Classification, Extraction),
            # same as a direct `for stage in ProcessingStage` would.
            for stage, metrics in stage_metrics_by_stage.items()
        ],
    )


@router.get(
    "/daily-trend",
    response_model=DailyTrendResponse,
    summary="Documents uploaded and successfully extracted, per day",
)
def get_daily_trend(
    days: int = Query(default=30, ge=1, le=365, description="Size of the trailing window, including today"),
    db: Session = Depends(get_db),
) -> DailyTrendResponse:
    """
    Defaults to the trailing 30 days; capped at 365 to keep this a quick
    "how are we trending lately" chart rather than an open-ended
    full-history export (that's what `GET /documents/export/xlsx` is
    for).
    """
    trend = analytics.daily_trend(db, days=days)
    return DailyTrendResponse(
        days=days, trend=[DailyTrendPoint(**point) for point in trend]
    )


@router.get(
    "/batches",
    response_model=BatchAnalyticsSummary,
    summary="Batch throughput, success rate, and sizing metrics",
)
def get_batch_analytics(db: Session = Depends(get_db)) -> BatchAnalyticsSummary:
    """
    The batch half of the dashboard.

    Its own endpoint rather than extra fields on `/summary`, so an
    install that has never used batch processing doesn't pay for these
    queries on every dashboard load — and so the two halves can be
    refreshed independently as the frontend already does for the trend.

    Like `/summary`, computed fresh on every call rather than cached: the
    same handful of GROUP BY/AVG queries either way, and a dashboard that
    can silently show stale numbers is a worse failure mode than one
    extra query per page load.
    """
    outcomes = batch_analytics.file_outcome_totals(db)
    return BatchAnalyticsSummary(
        generated_at=datetime.now(timezone.utc),
        total_batches=batch_analytics.total_batches(db),
        batches_by_status=[
            BatchStatusCount(status=status, count=count)
            for status, count in batch_analytics.batch_counts_by_status(db).items()
        ],
        total_files=outcomes["total_files"],
        successful_files=outcomes["successful_files"],
        failed_files=outcomes["failed_files"],
        processing_files=outcomes["processing_files"],
        success_rate=outcomes["success_rate"],
        failure_rate=outcomes["failure_rate"],
        average_file_processing_seconds=batch_analytics.average_file_processing_seconds(db),
        average_batch_size=batch_analytics.average_batch_size(db),
        average_batch_duration_seconds=batch_analytics.average_batch_duration_seconds(db),
    )


@router.get(
    "/batch-volume",
    response_model=BatchVolumeResponse,
    summary="Batches created and files completed, per day",
)
def get_batch_volume(
    days: int = Query(default=30, ge=1, le=365, description="Size of the trailing window, including today"),
    db: Session = Depends(get_db),
) -> BatchVolumeResponse:
    """
    Daily batch volume alongside the per-file outcomes that landed each
    day.

    Same windowing contract as `/daily-trend`: zero-filled, oldest day
    first, capped at 365 so this stays a "how are we trending lately"
    chart rather than an open-ended history export.
    """
    trend = batch_analytics.daily_batch_volume(db, days=days)
    return BatchVolumeResponse(days=days, trend=[BatchVolumePoint(**point) for point in trend])
