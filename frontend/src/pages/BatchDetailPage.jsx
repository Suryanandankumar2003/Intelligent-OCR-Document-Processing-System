/**
 * One batch, watched live: how far it has got, what each file did, and
 * the retry controls for the ones that failed.
 *
 * This is the only screen in the app that holds an open connection. It
 * consumes `GET /batches/{id}/stream` through `useBatchProgress`, which
 * falls back to polling if the stream can't be established — see that
 * hook for why the fallback is not optional.
 *
 * --- Two data sources, on purpose ------------------------------------
 *
 * The progress bar is driven by the stream; the summary cards and the
 * file table are driven by `useBatchDetail`'s ordinary reads. The stream
 * carries only the counters that change every second, so the table
 * underneath does not reload while someone is reading it — and when the
 * stream reports the batch finished, it prods a single full refresh so
 * the table shows final outcomes. Driving everything from one of the two
 * would mean either a table that flickers once a second or a progress
 * bar that only moves when you press Refresh.
 *
 * --- Why retrying is offered twice -----------------------------------
 *
 * "Retry all failed" is the header action, and every failed row also has
 * its own Retry. They are not redundant. After a 500-file run with 40
 * failures caused by one expired credential, the header button is the
 * whole job; after one corrupt scan among 40 genuine failures, the row
 * button is. The backend enforces the per-file retry cap for both
 * (`MAX_FILE_RETRIES`), so neither can offer work it would then refuse.
 */
import { useCallback } from 'react'
import { Link as RouterLink, useLocation, useParams, useSearchParams } from 'react-router-dom'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  IconButton,
  InputAdornment,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import ClearIcon from '@mui/icons-material/Clear'
import RefreshIcon from '@mui/icons-material/Refresh'
import ReplayIcon from '@mui/icons-material/Replay'
import SearchIcon from '@mui/icons-material/Search'
import SensorsIcon from '@mui/icons-material/Sensors'
import UpdateIcon from '@mui/icons-material/Update'
import BatchFilesTable from '../components/batch/BatchFilesTable'
import BatchProgressBar from '../components/batch/BatchProgressBar'
import BatchStatusBadge from '../components/batch/BatchStatusBadge'
import ErrorBanner from '../components/ErrorBanner'
import PageHeader from '../components/common/PageHeader'
import StatCard from '../components/analytics/StatCard'
import { useNotify } from '../components/feedback/snackbarContext'
import { useBatchDetail } from '../hooks/useBatchDetail'
import { PROGRESS_TRANSPORT, useBatchProgress } from '../hooks/useBatchProgress'
import { BATCH_FILE_STATUS, BATCH_FILE_STATUSES, isBatchActive } from '../utils/batchStatus'
import { formatDurationSeconds } from '../utils/analyticsFormat'

const FILE_PAGE_SIZES = [25, 50, 100]
const DEFAULT_FILE_PAGE_SIZE = 25

/** How the live feed is arriving, so a stalled bar is explicable rather than mysterious. */
function TransportChip({ transport }) {
  if (transport === PROGRESS_TRANSPORT.IDLE) return null

  const isStream = transport === PROGRESS_TRANSPORT.STREAM
  return (
    <Tooltip
      title={
        isStream
          ? 'Live updates over a Server-Sent Events stream.'
          : 'The live stream was unavailable, so progress is being polled every 2 seconds instead.'
      }
    >
      <Chip
        size="small"
        variant="outlined"
        color={isStream ? 'success' : 'default'}
        icon={isStream ? <SensorsIcon /> : <UpdateIcon />}
        label={isStream ? 'Live' : 'Polling'}
      />
    </Tooltip>
  )
}

export default function BatchDetailPage() {
  const { batchId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const notify = useNotify()

  const fileStatus = searchParams.get('status') ?? ''
  const fileSearch = searchParams.get('q') ?? ''
  const filePageSize = Number(searchParams.get('size')) || DEFAULT_FILE_PAGE_SIZE
  const filePage = Math.max(1, Number(searchParams.get('page')) || 1)

  const {
    batch,
    statusCounts,
    retryableFileCount,
    maxRetries,
    files,
    fileTotal,
    isLoading,
    isFilesLoading,
    error,
    actionError,
    dismissActionError,
    pendingRetry,
    refresh,
    retryAll,
    retryOne,
  } = useBatchDetail(batchId, { filePage, filePageSize, fileStatus, fileSearch })

  // When the stream says the batch is done, re-read everything: the
  // stream knows the counters, but only a real read knows what each file
  // ended up as, which is what the table below is showing.
  const handleComplete = useCallback(() => {
    refresh()
  }, [refresh])

  const { progress, transport, seed } = useBatchProgress(batchId, {
    // Parked for a batch that is already finished. Opening a stream for
    // a completed run would connect, immediately receive its final
    // frame, and close — a connection spent to learn what the page load
    // already told us.
    enabled: Boolean(batch) && isBatchActive(batch.status),
    onComplete: handleComplete,
  })

  // Seeds the bar from the loaded batch so it renders immediately rather
  // than staying blank until the first frame arrives (or for ever, on a
  // batch that finished before the page opened).
  if (batch && !progress) seed(batch)

  const updateParams = (patch) => {
    const next = new URLSearchParams(searchParams)
    Object.entries(patch).forEach(([key, value]) => {
      if (value === '' || value === null || value === undefined) next.delete(key)
      else next.set(key, String(value))
    })
    setSearchParams(next, { replace: true })
  }

  const setFileFilter = (patch) => updateParams({ ...patch, page: null })

  const handleRetryAll = async () => {
    const result = await retryAll()
    if (result.ok) notify.success(result.message)
    else notify.error(result.message)
  }

  const handleRetryOne = async (fileId) => {
    const result = await retryOne(fileId)
    if (result.ok) notify.success(result.message)
    else notify.error(result.message)
  }

  // Back to wherever this page was opened from — the batch list, on the
  // page and filters it was showing. Router state, so a refresh that
  // drops it falls back to the plain list rather than breaking.
  const backTo = location.state?.backTo ?? '/batches'
  const selfUrl = `${location.pathname}${location.search}`

  if (error && !batch) {
    return (
      <Box sx={{ maxWidth: 1500, mx: 'auto', py: { xs: 2, md: 3 } }}>
        <PageHeader
          title="Batch"
          actions={
            <Button
              component={RouterLink}
              to="/batches"
              variant="outlined"
              color="inherit"
              startIcon={<ArrowBackIcon />}
            >
              All batches
            </Button>
          }
        />
        <ErrorBanner message={error} title="Could not load this batch" />
      </Box>
    )
  }

  const displayProgress = progress ?? batch
  const isActive = batch ? isBatchActive(batch.status) : false

  return (
    <Box sx={{ maxWidth: 1500, mx: 'auto', py: { xs: 2, md: 3 } }}>
      <PageHeader
        title={batch?.batch_name ?? 'Batch'}
        description={
          batch
            ? `Created ${new Date(batch.created_at).toLocaleString()}${
                batch.completed_at
                  ? ` · finished ${new Date(batch.completed_at).toLocaleString()}`
                  : ''
              }`
            : 'Loading…'
        }
        actions={
          <>
            <Button
              component={RouterLink}
              to={backTo}
              variant="outlined"
              color="inherit"
              startIcon={<ArrowBackIcon />}
            >
              Back
            </Button>
            <Button
              variant="outlined"
              color="inherit"
              startIcon={<RefreshIcon />}
              onClick={refresh}
              disabled={isLoading}
            >
              Refresh
            </Button>
            <Tooltip
              title={
                retryableFileCount === 0
                  ? `Nothing to retry — there are no failures, or every failed file has reached the ${maxRetries}-retry limit.`
                  : `Re-queue ${retryableFileCount} failed file${retryableFileCount === 1 ? '' : 's'}, and release anything stuck mid-processing.`
              }
            >
              {/* Wrapped: MUI suppresses a tooltip on a disabled button,
                  and the disabled case is exactly the one that needs
                  explaining. */}
              <span>
                <Button
                  variant="contained"
                  color="warning"
                  startIcon={
                    pendingRetry === 'batch' ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      <ReplayIcon />
                    )
                  }
                  onClick={handleRetryAll}
                  disabled={retryableFileCount === 0 || pendingRetry !== null}
                >
                  Retry failed
                  {retryableFileCount > 0 ? ` (${retryableFileCount})` : ''}
                </Button>
              </span>
            </Tooltip>
          </>
        }
      />

      <Stack spacing={2.5}>
        {actionError && (
          <ErrorBanner message={actionError} title="Retry failed" onDismiss={dismissActionError} />
        )}

        <Card>
          <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
            <Stack
              direction="row"
              spacing={1.5}
              useFlexGap
              sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 2 }}
            >
              {batch && <BatchStatusBadge status={batch.status} />}
              {isActive && <TransportChip transport={transport} />}
              {batch?.executor === 'inline' && (
                <Chip
                  size="small"
                  variant="outlined"
                  color="warning"
                  label="Processed in the API process"
                />
              )}
            </Stack>

            {displayProgress && <BatchProgressBar progress={displayProgress} />}
          </CardContent>
        </Card>

        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' },
          }}
        >
          <StatCard
            label="Succeeded"
            value={(statusCounts[BATCH_FILE_STATUS.SUCCESS] ?? 0).toLocaleString()}
            tone="success"
          />
          <StatCard
            label="Failed"
            value={(statusCounts[BATCH_FILE_STATUS.FAILED] ?? 0).toLocaleString()}
            hint={retryableFileCount > 0 ? `${retryableFileCount} can still be retried` : undefined}
            tone="error"
          />
          {/* Processing and Pending are shown as separate numbers because
              they are separate facts — "a worker has this file open" and
              "nothing has touched this file yet" call for different
              reactions when a batch appears stuck. */}
          <StatCard
            label="Processing"
            value={(statusCounts[BATCH_FILE_STATUS.PROCESSING] ?? 0).toLocaleString()}
            tone="info"
          />
          <StatCard
            label="Pending"
            value={(statusCounts[BATCH_FILE_STATUS.PENDING] ?? 0).toLocaleString()}
            hint={
              batch?.started_at && batch?.completed_at
                ? `Ran for ${formatDurationSeconds(
                    (new Date(batch.completed_at) - new Date(batch.started_at)) / 1000,
                  )}`
                : undefined
            }
            tone="primary"
          />
        </Box>

        {batch?.status === 'Partially Completed' && retryableFileCount > 0 && (
          <Alert severity="warning">
            {retryableFileCount} file{retryableFileCount === 1 ? '' : 's'} failed and can be
            retried. The documents that succeeded are already available in Documents — retrying
            only reprocesses the failures.
          </Alert>
        )}

        <Card>
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={1.5}
            sx={{ alignItems: { md: 'center' }, p: 2, borderBottom: 1, borderColor: 'divider' }}
          >
            <Typography variant="h4" component="h2" sx={{ flexShrink: 0 }}>
              Files
            </Typography>

            <TextField
              type="search"
              placeholder="Filename…"
              value={fileSearch}
              onChange={(event) => setFileFilter({ q: event.target.value })}
              sx={{ flex: '1 1 220px' }}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                  endAdornment: fileSearch ? (
                    <InputAdornment position="end">
                      <IconButton
                        size="small"
                        onClick={() => setFileFilter({ q: '' })}
                        aria-label="Clear search"
                      >
                        <ClearIcon fontSize="small" />
                      </IconButton>
                    </InputAdornment>
                  ) : null,
                },
              }}
            />

            <TextField
              select
              label="File status"
              value={fileStatus}
              onChange={(event) => setFileFilter({ status: event.target.value })}
              sx={{ minWidth: 175 }}
            >
              <MenuItem value="">Any status</MenuItem>
              {BATCH_FILE_STATUSES.map((option) => (
                <MenuItem key={option} value={option}>
                  {option}
                </MenuItem>
              ))}
            </TextField>

            {/* The shortcut that matters on a 500-file batch: the reason
                to open this page is almost always to find the failures. */}
            {fileStatus !== BATCH_FILE_STATUS.FAILED &&
              (statusCounts[BATCH_FILE_STATUS.FAILED] ?? 0) > 0 && (
                <Button
                  color="warning"
                  variant="outlined"
                  onClick={() => setFileFilter({ status: BATCH_FILE_STATUS.FAILED })}
                >
                  Show {statusCounts[BATCH_FILE_STATUS.FAILED]} failed
                </Button>
              )}
          </Stack>

          <BatchFilesTable
            files={files}
            total={fileTotal}
            page={filePage}
            pageSize={filePageSize}
            pageSizes={FILE_PAGE_SIZES}
            onPageChange={(nextPage) => updateParams({ page: nextPage })}
            onPageSizeChange={(nextSize) => updateParams({ size: nextSize, page: null })}
            isLoading={isFilesLoading}
            maxRetries={maxRetries}
            pendingRetry={pendingRetry}
            onRetryFile={handleRetryOne}
            // Review links carry this page back with them, so Back from a
            // review returns to the batch rather than to the document list.
            backTo={selfUrl}
          />
        </Card>
      </Stack>
    </Box>
  )
}
