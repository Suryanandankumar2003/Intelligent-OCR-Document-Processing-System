/**
 * Batch history: every bulk run there has ever been, with search, a
 * status filter, and a live-updating progress column.
 *
 * --- Why there is no upload form here --------------------------------
 *
 * There used to be. Starting a batch now lives on the Process screen
 * next to the single-document form, because those two are one choice
 * ("one file or a folder?") and splitting them across screens made the
 * user pick a sidebar entry before they could pick a way of working.
 * What is left here is the other half of the job — looking at what
 * happened — which is a genuinely different task, done at a different
 * time, and which deserves a screen that is only a table.
 *
 * This page is reached from the Process screen and from a batch's own
 * details page rather than from the sidebar, for the same reason.
 *
 * --- Why the controls live in the URL --------------------------------
 *
 * Same reasoning as `DocumentsPage`: a filtered view is a link you can
 * share, a refresh doesn't dump you back at page 1, and returning from a
 * batch's details page lands on the page of the list you left. The
 * difference is where the filtering happens — here it is server-side,
 * because `GET /batches` pages, filters and counts, and the batch table
 * grows without bound (see `useBatches`).
 */
import { Link as RouterLink, useLocation, useSearchParams } from 'react-router-dom'
import {
  Box,
  Button,
  Card,
  Chip,
  IconButton,
  InputAdornment,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import ClearIcon from '@mui/icons-material/Clear'
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff'
import LayersIcon from '@mui/icons-material/Layers'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import RefreshIcon from '@mui/icons-material/Refresh'
import SearchIcon from '@mui/icons-material/Search'
import BatchProgressBar from '../components/batch/BatchProgressBar'
import BatchStatusBadge from '../components/batch/BatchStatusBadge'
import ErrorBanner from '../components/ErrorBanner'
import EmptyState from '../components/common/EmptyState'
import PageHeader from '../components/common/PageHeader'
import { TableRowsSkeleton } from '../components/common/Skeletons'
import { useBatches } from '../hooks/useBatches'
import { BATCH_STATUSES, formatFileCount } from '../utils/batchStatus'

const PAGE_SIZES = [10, 25, 50]
const DEFAULT_PAGE_SIZE = 10

/** The executor a batch ran on, as a chip — "celery" or "inline". */
function ExecutorChip({ executor }) {
  if (!executor) return null
  const isQueued = executor === 'celery'
  return (
    <Tooltip
      title={
        isQueued
          ? 'Processed by a Celery worker over Redis — the normal path.'
          : 'Processed in the API process, because no Redis broker was reachable. Work is identical, but it does not survive an API restart.'
      }
    >
      <Chip
        size="small"
        variant="outlined"
        color={isQueued ? 'default' : 'warning'}
        label={isQueued ? 'Worker' : 'In-process'}
      />
    </Tooltip>
  )
}

export default function BatchesPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()

  const status = searchParams.get('status') ?? ''
  const search = searchParams.get('q') ?? ''
  const pageSize = Number(searchParams.get('size')) || DEFAULT_PAGE_SIZE
  const page = Math.max(1, Number(searchParams.get('page')) || 1)

  const { batches, total, isLoading, isRefreshing, error, reload } = useBatches({
    page,
    pageSize,
    status,
    search,
  })

  /** Writes a patch into the query string, dropping empties so a cleared filter leaves a clean URL. */
  const updateParams = (patch) => {
    const next = new URLSearchParams(searchParams)
    Object.entries(patch).forEach(([key, value]) => {
      if (value === '' || value === null || value === undefined) next.delete(key)
      else next.set(key, String(value))
    })
    setSearchParams(next, { replace: true })
  }

  // Changing what is filtered invalidates the page number, so every
  // filter control resets it in the same update.
  const setFilter = (patch) => updateParams({ ...patch, page: null })

  const hasFilters = Boolean(status || search)
  const backTo = `${location.pathname}${location.search}`
  const showEmptyState = !isLoading && !error && batches.length === 0

  return (
    <Box sx={{ maxWidth: 1500, mx: 'auto', py: { xs: 2, md: 3 } }}>
      <PageHeader
        title="Batch history"
        description="Every bulk run, newest first. Open one to watch it live, see what each file did, and retry any that failed."
        actions={
          <>
            <Button component={RouterLink} to="/" variant="contained" startIcon={<AddIcon />}>
              New batch
            </Button>
            <Button
              variant="outlined"
              color="inherit"
              startIcon={<RefreshIcon />}
              onClick={reload}
              disabled={isLoading}
            >
              {isRefreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          </>
        }
      />

      <Card>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={1.5}
          sx={{ alignItems: { md: 'center' }, p: 2, borderBottom: 1, borderColor: 'divider' }}
        >
          <TextField
            type="search"
            placeholder="Batch name…"
            value={search}
            onChange={(event) => setFilter({ q: event.target.value })}
            sx={{ flex: '1 1 260px' }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
                endAdornment: search ? (
                  <InputAdornment position="end">
                    <IconButton
                      size="small"
                      onClick={() => setFilter({ q: '' })}
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
            label="Status"
            value={status}
            onChange={(event) => setFilter({ status: event.target.value })}
            sx={{ minWidth: 210 }}
          >
            <MenuItem value="">Any status</MenuItem>
            {BATCH_STATUSES.map((option) => (
              <MenuItem key={option} value={option}>
                {option}
              </MenuItem>
            ))}
          </TextField>

          {hasFilters && (
            <Button
              color="inherit"
              startIcon={<FilterAltOffIcon />}
              onClick={() => setFilter({ q: '', status: '' })}
            >
              Clear
            </Button>
          )}
        </Stack>

        {error && <ErrorBanner message={error} sx={{ m: 2 }} />}

        {showEmptyState ? (
          hasFilters ? (
            <EmptyState
              icon={FilterAltOffIcon}
              title="No batches match these filters"
              description="Nothing in the batch history matches what you're filtering on."
              action={
                <Button variant="outlined" onClick={() => setFilter({ q: '', status: '' })}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={LayersIcon}
              title="No batches yet"
              description="Upload a set of documents from the Process screen and they'll appear here as they run."
              action={
                <Button component={RouterLink} to="/" variant="contained">
                  Start a batch
                </Button>
              }
            />
          )
        ) : (
          <>
            <TableContainer>
              <Table size="small" sx={{ minWidth: 900 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Batch</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell sx={{ minWidth: 240 }}>Progress</TableCell>
                    <TableCell>Files</TableCell>
                    <TableCell>Started</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {isLoading ? (
                    <TableRowsSkeleton rows={Math.min(pageSize, 10)} columns={6} />
                  ) : (
                    batches.map((batch) => (
                      <TableRow key={batch.batch_id} hover>
                        <TableCell sx={{ maxWidth: 260 }}>
                          <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                            {batch.batch_name}
                          </Typography>
                          <Stack direction="row" spacing={0.75} sx={{ mt: 0.5 }}>
                            <ExecutorChip executor={batch.executor} />
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <BatchStatusBadge status={batch.status} />
                        </TableCell>
                        <TableCell>
                          {/* The list row reuses the details page's bar
                              without its legend — the counts are in the
                              next column, and repeating them here would
                              make every row three lines tall. */}
                          <BatchProgressBar progress={batch} showLegend={false} height={6} />
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>
                            {batch.successful_files.toLocaleString()} ok
                            {batch.failed_files > 0 && (
                              <Box component="span" sx={{ color: 'error.main', fontWeight: 700 }}>
                                {' '}
                                · {batch.failed_files.toLocaleString()} failed
                              </Box>
                            )}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: 'block' }}
                          >
                            of {formatFileCount(batch.total_files)}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption" color="text.secondary" noWrap>
                            {new Date(batch.started_at ?? batch.created_at).toLocaleString()}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">
                          <Button
                            component={RouterLink}
                            to={`/batches/${encodeURIComponent(batch.batch_id)}`}
                            state={{ backTo }}
                            size="small"
                            variant="outlined"
                            startIcon={<OpenInNewIcon />}
                          >
                            Open
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>

            <TablePagination
              component="div"
              count={total}
              // MUI counts from 0, the URL from 1 — `?page=1` should be
              // the first page, not the second.
              page={page - 1}
              onPageChange={(_event, nextPage) => updateParams({ page: nextPage + 1 })}
              rowsPerPage={pageSize}
              rowsPerPageOptions={PAGE_SIZES}
              onRowsPerPageChange={(event) => updateParams({ size: event.target.value, page: null })}
              labelRowsPerPage="Per page"
            />
          </>
        )}
      </Card>
    </Box>
  )
}
