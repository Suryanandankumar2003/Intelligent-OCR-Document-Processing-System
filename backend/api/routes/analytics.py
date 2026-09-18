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

from database import analytics
from database.session import get_db
from schemas.analytics import (
    AnalyticsSummaryResponse,
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
