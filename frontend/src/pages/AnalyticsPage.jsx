/**
 * The analytics dashboard: how many documents the system has processed,
 * broken down by type; how the pipeline is performing (average
 * end-to-end processing time, and OCR/classification/extraction success
 * rates); and the daily upload/extraction trend.
 *
 * All of it comes from `useAnalytics`, which fires both backend calls
 * (`GET /analytics/summary`, `GET /analytics/daily-trend`) together and
 * keeps the previous render on screen while a refresh is in flight — see
 * that hook's docstring for why. This file is purely presentational: it
 * decides what each of the four states (first load, loaded, loaded
 * mid-refresh, failed) looks like, and leaves every metric's meaning to
 * the backend (`backend/database/analytics.py`) and every chart's
 * rendering to its own component.
 *
 * --- The batch section ------------------------------------------------
 *
 * Rendered below the document metrics, and only once a batch has
 * actually been run. An install that only ever processes single
 * documents would otherwise carry four permanently-empty cards and a
 * blank chart explaining that nothing has happened — a dashboard should
 * not spend a third of its height on a feature this operator does not
 * use. The section appears the moment it has something to say.
 *
 * The mid-refresh state dims the content rather than replacing it with
 * the skeleton. Skeletons are for a first load, where there is genuinely
 * nothing to show; swapping real numbers for grey boxes every time
 * someone hits Refresh would destroy the one thing a monitoring
 * dashboard is for, which is watching a figure change.
 */
import { Box, Button, Stack, Typography } from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import DescriptionIcon from '@mui/icons-material/Description'
import TimerIcon from '@mui/icons-material/Timer'
import TextSnippetIcon from '@mui/icons-material/TextSnippet'
import DataObjectIcon from '@mui/icons-material/DataObject'
import LayersIcon from '@mui/icons-material/Layers'
import TaskAltIcon from '@mui/icons-material/TaskAlt'
import SpeedIcon from '@mui/icons-material/Speed'
import ScheduleIcon from '@mui/icons-material/Schedule'
import ErrorBanner from '../components/ErrorBanner'
import PageHeader from '../components/common/PageHeader'
import { AnalyticsSkeleton } from '../components/common/Skeletons'
import StatCard from '../components/analytics/StatCard'
import DocumentsByTypeChart from '../components/analytics/DocumentsByTypeChart'
import DailyTrendChart from '../components/analytics/DailyTrendChart'
import BatchVolumeChart from '../components/analytics/BatchVolumeChart'
import StageMetricsTable from '../components/analytics/StageMetricsTable'
import { useAnalytics } from '../hooks/useAnalytics'
import { formatCount, formatDurationSeconds, formatPercent } from '../utils/analyticsFormat'

/** `success_rate` -> which tone its stat card's icon takes. Same bands as the stage table. */
function rateTone(successRate) {
  if (successRate === null || successRate === undefined) return 'primary'
  if (successRate >= 0.95) return 'success'
  if (successRate >= 0.8) return 'warning'
  return 'error'
}

export default function AnalyticsPage() {
  const {
    summary,
    trend,
    batchSummary,
    batchVolume,
    days,
    dayRangePresets,
    setDays,
    isLoading,
    isRefreshing,
    error,
    refresh,
  } = useAnalytics()

  if (isLoading) {
    return (
      <Box sx={{ maxWidth: 1500, mx: 'auto', py: { xs: 2, md: 3 } }}>
        <PageHeader title="Analytics" description="Pipeline throughput, accuracy, and health." />
        <AnalyticsSkeleton />
      </Box>
    )
  }

  // Only when there is nothing to fall back to. A refresh that fails
  // while a previous render is on screen keeps the numbers and shows the
  // message above them (below), because stale data plus a warning beats
  // a blank page.
  if (error && !summary) {
    return (
      <Box sx={{ maxWidth: 1500, mx: 'auto', py: { xs: 2, md: 3 } }}>
        <PageHeader
          title="Analytics"
          description="Pipeline throughput, accuracy, and health."
          actions={
            <Button
              variant="outlined"
              color="inherit"
              startIcon={<RefreshIcon />}
              onClick={refresh}
            >
              Try again
            </Button>
          }
        />
        <ErrorBanner message={error} title="Could not load analytics" />
      </Box>
    )
  }

  const ocrMetrics = summary.stage_metrics.find((row) => row.stage === 'OCR')
  const extractionMetrics = summary.stage_metrics.find((row) => row.stage === 'Extraction')

  return (
    <Box sx={{ maxWidth: 1500, mx: 'auto', py: { xs: 2, md: 3 } }}>
      <PageHeader
        title="Analytics"
        description="Pipeline throughput, accuracy, and health."
        actions={
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
              Updated {new Date(summary.generated_at).toLocaleTimeString()}
            </Typography>
            <Button
              variant="outlined"
              color="inherit"
              startIcon={<RefreshIcon />}
              onClick={refresh}
              disabled={isRefreshing}
            >
              {isRefreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          </Stack>
        }
      />

      {error && <ErrorBanner message={error} severity="warning" sx={{ mb: 2.5 }} />}

      <Stack
        spacing={2.5}
        sx={{
          // Dimmed and inert while a refresh is in flight: the numbers
          // on screen are a moment out of date, and clicking a chart
          // that's about to be replaced is a click that goes nowhere.
          opacity: isRefreshing ? 0.6 : 1,
          pointerEvents: isRefreshing ? 'none' : 'auto',
          transition: 'opacity 150ms ease',
        }}
        aria-busy={isRefreshing}
      >
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' },
          }}
        >
          <StatCard
            label="Total documents processed"
            value={formatCount(summary.total_documents)}
            icon={DescriptionIcon}
          />
          <StatCard
            label="Average processing time"
            value={formatDurationSeconds(summary.average_processing_time_seconds)}
            hint="Upload to successful extraction"
            icon={TimerIcon}
          />
          <StatCard
            label="OCR success rate"
            value={formatPercent(ocrMetrics?.success_rate ?? null)}
            hint={
              ocrMetrics
                ? `${ocrMetrics.successes.toLocaleString()} of ${ocrMetrics.attempts.toLocaleString()} attempts`
                : undefined
            }
            icon={TextSnippetIcon}
            tone={rateTone(ocrMetrics?.success_rate)}
          />
          <StatCard
            label="Extraction success rate"
            value={formatPercent(extractionMetrics?.success_rate ?? null)}
            hint={
              extractionMetrics
                ? `${extractionMetrics.successes.toLocaleString()} of ${extractionMetrics.attempts.toLocaleString()} attempts`
                : undefined
            }
            icon={DataObjectIcon}
            tone={rateTone(extractionMetrics?.success_rate)}
          />
        </Box>

        <Box
          sx={{
            display: 'grid',
            gap: 2.5,
            // The trend chart gets the wider column: it carries up to 90
            // points across the x-axis, where the by-type chart carries
            // at most six bars.
            gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 5fr) minmax(0, 7fr)' },
          }}
        >
          <DocumentsByTypeChart data={summary.documents_by_type} />
          <DailyTrendChart
            data={trend.trend}
            days={days}
            dayRangePresets={dayRangePresets}
            onDaysChange={setDays}
          />
        </Box>

        <StageMetricsTable stageMetrics={summary.stage_metrics} />

        {/* Only once batching has been used at all — see the module
            docstring. `batchSummary` is null both when nothing has been
            batched and when that endpoint failed while the rest
            succeeded, and "don't show the section" is the right answer
            to both. */}
        {batchSummary && batchSummary.total_batches > 0 && (
          <>
            <Box sx={{ pt: 1 }}>
              <Typography variant="h3" component="h2" sx={{ mb: 0.5 }}>
                Batch processing
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Throughput and reliability of bulk runs. Rates are over files that finished —
                a file still in flight counts towards neither.
              </Typography>
            </Box>

            <Box
              sx={{
                display: 'grid',
                gap: 2,
                gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' },
              }}
            >
              <StatCard
                label="Batches run"
                value={formatCount(batchSummary.total_batches)}
                hint={
                  batchSummary.average_batch_size
                    ? `${Math.round(batchSummary.average_batch_size).toLocaleString()} files each on average`
                    : undefined
                }
                icon={LayersIcon}
              />
              <StatCard
                label="Files processed in batches"
                value={formatCount(batchSummary.total_files)}
                hint={
                  batchSummary.processing_files > 0
                    ? `${batchSummary.processing_files.toLocaleString()} still in flight`
                    : `${batchSummary.failed_files.toLocaleString()} failed`
                }
                icon={TaskAltIcon}
              />
              <StatCard
                label="Batch success rate"
                value={formatPercent(batchSummary.success_rate)}
                hint={
                  batchSummary.total_files > 0
                    ? `${batchSummary.successful_files.toLocaleString()} of ${(batchSummary.successful_files + batchSummary.failed_files).toLocaleString()} finished files`
                    : undefined
                }
                icon={SpeedIcon}
                tone={rateTone(batchSummary.success_rate)}
              />
              <StatCard
                label="Average batch duration"
                value={formatDurationSeconds(batchSummary.average_batch_duration_seconds)}
                hint={
                  batchSummary.average_file_processing_seconds
                    ? `${formatDurationSeconds(batchSummary.average_file_processing_seconds)} per file`
                    : undefined
                }
                icon={ScheduleIcon}
              />
            </Box>

            {batchVolume && <BatchVolumeChart data={batchVolume.trend} days={batchVolume.days} />}
          </>
        )}
      </Stack>
    </Box>
  )
}
