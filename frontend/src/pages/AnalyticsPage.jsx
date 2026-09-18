/**
 * The analytics dashboard: how many documents the system has processed,
 * broken down by type; how the pipeline is performing (average
 * end-to-end processing time, and OCR/classification/extraction success
 * rates); and the daily upload/extraction trend.
 *
 * All of it comes from `useAnalytics`, which fires both backend calls
 * (`GET /analytics/summary`, `GET /analytics/daily-trend`) together and
 * keeps the previous render on screen while a refresh is in flight — see
 * that hook's docstring for why. This file is purely presentational:
 * it decides what each of the four states (first load, loaded, loaded
 * mid-refresh, failed) looks like, and leaves every metric's meaning to
 * the backend (`backend/database/analytics.py`) and every chart's
 * rendering to its own component.
 */
import ErrorBanner from '../components/ErrorBanner'
import StatCard from '../components/analytics/StatCard'
import DocumentsByTypeChart from '../components/analytics/DocumentsByTypeChart'
import DailyTrendChart from '../components/analytics/DailyTrendChart'
import StageMetricsTable from '../components/analytics/StageMetricsTable'
import { useAnalytics } from '../hooks/useAnalytics'
import { formatCount, formatDurationSeconds, formatPercent } from '../utils/analyticsFormat'
import './AnalyticsPage.css'

export default function AnalyticsPage() {
  const { summary, trend, days, dayRangePresets, setDays, isLoading, isRefreshing, error, refresh } = useAnalytics()

  if (isLoading) {
    return (
      <div className="analytics-page">
        <p className="analytics-page__loading">Loading analytics…</p>
      </div>
    )
  }

  if (error && !summary) {
    return (
      <div className="analytics-page">
        <ErrorBanner message={error} />
      </div>
    )
  }

  const ocrMetrics = summary.stage_metrics.find((row) => row.stage === 'OCR')
  const extractionMetrics = summary.stage_metrics.find((row) => row.stage === 'Extraction')

  return (
    <div className={`analytics-page${isRefreshing ? ' analytics-page--refreshing' : ''}`}>
      <div className="analytics-page__toolbar">
        <p className="analytics-page__generated-at">
          Last updated {new Date(summary.generated_at).toLocaleTimeString()}
        </p>
        <button type="button" className="analytics-page__refresh" onClick={refresh} disabled={isRefreshing}>
          {isRefreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="analytics-page__cards">
        <StatCard label="Total documents processed" value={formatCount(summary.total_documents)} />
        <StatCard
          label="Average processing time"
          value={formatDurationSeconds(summary.average_processing_time_seconds)}
          hint="Upload to successful extraction"
        />
        <StatCard
          label="OCR success rate"
          value={formatPercent(ocrMetrics?.success_rate ?? null)}
          hint={ocrMetrics ? `${ocrMetrics.successes.toLocaleString()} of ${ocrMetrics.attempts.toLocaleString()} attempts` : undefined}
        />
        <StatCard
          label="Extraction success rate"
          value={formatPercent(extractionMetrics?.success_rate ?? null)}
          hint={
            extractionMetrics
              ? `${extractionMetrics.successes.toLocaleString()} of ${extractionMetrics.attempts.toLocaleString()} attempts`
              : undefined
          }
        />
      </div>

      <div className="analytics-page__charts">
        <DocumentsByTypeChart data={summary.documents_by_type} />
        <DailyTrendChart data={trend.trend} days={days} dayRangePresets={dayRangePresets} onDaysChange={setDays} />
      </div>

      <StageMetricsTable stageMetrics={summary.stage_metrics} />
    </div>
  )
}
