/**
 * The Logs screen: everything the platform has done, searchable,
 * filterable, sortable, paged — with an analytics panel above it and an
 * xlsx export beside it.
 *
 * --- Why the controls live in the URL --------------------------------
 *
 * Search, all five filters, the sort, the page and the page size are
 * held in the query string (`useSearchParams`) rather than in
 * `useState`, the same choice `DocumentsPage` makes. Three things fall
 * out for free: a filtered view is a link you can send someone, a
 * refresh does not dump you back at page 1 of everything, and coming
 * back from a log's detail page lands on the page you left.
 *
 * It matters more here than on the documents list. The reason to share
 * a log view is almost always "look at this specific failure", and a URL
 * that carried none of the filters could not express that at all.
 *
 * --- Why the filtering happens on the server -------------------------
 *
 * The opposite of `DocumentsPage`, which loads the whole table and
 * filters in the browser — and the difference follows the data rather
 * than being an inconsistency. That table is bounded by what one
 * operator has processed and its search runs over values inside a JSON
 * column, which has no SQL equivalent. This one gains several rows per
 * file per batch, so it grows without bound, and every filter it offers
 * is a plain indexed predicate. Pushing it all into the query is less
 * code, not more (see `backend/database/log_crud.py`).
 *
 * --- Why "export filtered" is trustworthy ----------------------------
 *
 * Because the export sends the *same* filter values to the *same*
 * backend filter builder that produced the table. There is no second
 * definition of what a filter means on either side, which is what makes
 * "export what I'm looking at" true by construction rather than by two
 * implementations being kept in step by hand.
 */
import { useMemo, useState } from 'react'
import { Link as RouterLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import {
  Box,
  Button,
  Card,
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
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import ClearIcon from '@mui/icons-material/Clear'
import RefreshIcon from '@mui/icons-material/Refresh'
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff'
import InsightsIcon from '@mui/icons-material/Insights'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import VisibilityIcon from '@mui/icons-material/Visibility'
import DownloadIcon from '@mui/icons-material/Download'
import ErrorBanner from '../components/ErrorBanner'
import ExportButton from '../components/ExportButton'
import EmptyState from '../components/common/EmptyState'
import PageHeader from '../components/common/PageHeader'
import { TableRowsSkeleton } from '../components/common/Skeletons'
import { useNotify } from '../components/feedback/snackbarContext'
import LogStatusChip from '../components/logs/LogStatusChip'
import LogAnalyticsPanel from '../components/logs/LogAnalyticsPanel'
import { useLogs } from '../hooks/useLogs'
import { useLogAnalytics } from '../hooks/useLogAnalytics'
import { useLogExport } from '../hooks/useLogExport'
import { useLogFilterOptions } from '../hooks/useLogFilterOptions'
import { LOG_STATUS, dayBoundaryIso, formatProcessingTime, splitLogTimestamp } from '../utils/logEvents'
import { saveBlob } from '../utils/download'
import { MONO_FAMILY } from '../theme/theme'

const PAGE_SIZES = [25, 50, 100]
const DEFAULT_PAGE_SIZE = 25

/**
 * The table's columns, and which of them the backend will sort on.
 *
 * A single list rather than a header row written out by hand plus a
 * separate set of sortable keys: the two would drift, and the symptom is
 * a column header that looks clickable and silently does nothing.
 * `sortKey: null` marks a column the backend has no index for — Category
 * and Message are both derivable or free-text, and offering a sort the
 * server would have to table-scan for is worse than not offering one.
 */
const COLUMNS = [
  { id: 'timestamp', label: 'Timestamp', sortKey: 'created_at', width: 150 },
  { id: 'event', label: 'Event type', sortKey: 'event_type', width: 180 },
  { id: 'category', label: 'Category', sortKey: 'event_category', width: 120 },
  { id: 'filename', label: 'Filename', sortKey: 'filename', width: 190 },
  { id: 'status', label: 'Status', sortKey: 'status', width: 120 },
  { id: 'message', label: 'Message', sortKey: null },
  { id: 'duration', label: 'Duration', sortKey: 'processing_time', width: 90, align: 'right' },
  { id: 'actions', label: 'Actions', sortKey: null, width: 96, align: 'right' },
]

export default function LogsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [isAnalyticsOpen, setIsAnalyticsOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const notify = useNotify()

  const options = useLogFilterOptions()
  const { runExport, pendingExport } = useLogExport()

  const search = searchParams.get('q') ?? ''
  const eventType = searchParams.get('type') ?? ''
  const eventCategory = searchParams.get('category') ?? ''
  const status = searchParams.get('status') ?? ''
  const documentType = searchParams.get('doctype') ?? ''
  const dateFrom = searchParams.get('from') ?? ''
  const dateTo = searchParams.get('to') ?? ''
  const sortBy = searchParams.get('sort') ?? 'created_at'
  const sortDir = searchParams.get('dir') === 'asc' ? 'asc' : 'desc'
  const pageSize = Number(searchParams.get('size')) || DEFAULT_PAGE_SIZE
  const page = Math.max(Number(searchParams.get('page')) || 1, 1)

  /**
   * Writes a patch into the query string. A key set to `''` is dropped,
   * so a cleared filter leaves a clean URL instead of `?type=&status=`,
   * and `replace` keeps typing in the search box out of history — Back
   * should leave the screen, not replay keystrokes.
   */
  const updateParams = (patch) => {
    const next = new URLSearchParams(searchParams)
    Object.entries(patch).forEach(([key, value]) => {
      if (value === '' || value === null || value === undefined) next.delete(key)
      else next.set(key, String(value))
    })
    setSearchParams(next, { replace: true })
  }

  // Any change to *what* is being filtered invalidates the page number,
  // so every filter control resets it in the same update. Sorting does
  // too: page 4 of a differently-ordered list is a different set of rows
  // and lands the reader somewhere arbitrary.
  const setFilter = (patch) => updateParams({ ...patch, page: null })

  // The filters in the shape both the list call and the export call
  // take. One object, built once, so the table and the download cannot
  // be looking at different things.
  const filters = useMemo(
    () => ({
      search,
      eventType,
      eventCategory,
      status,
      documentType,
      // Converted at the edge rather than stored as ISO in the URL: a
      // `<input type="date">` speaks `YYYY-MM-DD`, and `to` has to mean
      // the *end* of that day or the range silently excludes everything
      // that happened on the day the user just asked for.
      dateFrom: dayBoundaryIso(dateFrom),
      dateTo: dayBoundaryIso(dateTo, { end: true }),
    }),
    [search, eventType, eventCategory, status, documentType, dateFrom, dateTo],
  )

  const query = useMemo(
    () => ({ ...filters, skip: (page - 1) * pageSize, limit: pageSize, sortBy, sortDir }),
    [filters, page, pageSize, sortBy, sortDir],
  )

  const { logs, total, isLoading, isRefreshing, error, reload } = useLogs(query)
  const analytics = useLogAnalytics({ enabled: isAnalyticsOpen })

  const hasFilters = Boolean(
    search || eventType || eventCategory || status || documentType || dateFrom || dateTo,
  )

  const clearFilters = () =>
    setFilter({ q: '', type: '', category: '', status: '', doctype: '', from: '', to: '' })

  const toggleSort = (key) => {
    if (!key) return
    // Clicking the active column flips direction; clicking a new one
    // starts it descending, because every column here is read
    // most-recent/largest-first by default.
    updateParams({
      sort: key,
      dir: sortBy === key && sortDir === 'desc' ? 'asc' : 'desc',
      page: null,
    })
  }

  /** Apply a set of analytics-card filters, replacing whatever is set. */
  const applyCardFilters = (next) => {
    setFilter({
      q: '',
      type: '',
      category: next.eventCategory ?? '',
      status: next.status ?? '',
      doctype: '',
      from: '',
      to: '',
    })
  }

  const handleExport = async (key, exportFilters, description) => {
    const result = await runExport(key, exportFilters)
    if (result.ok) notify.success(`${description} downloaded as ${result.filename}.`)
    else if (result.error) notify.error(result.error)
  }

  /**
   * Saves one entry as JSON, client-side.
   *
   * No round trip, because the list response already carries every
   * field the file would contain — including `details_json`, which the
   * table does not show and which is the main reason to take an entry
   * away with you. A download endpoint would add a request per click and
   * a second place for the filename convention to live.
   */
  const downloadEntry = (entry) => {
    saveBlob(
      new Blob([JSON.stringify(entry, null, 2)], { type: 'application/json;charset=utf-8' }),
      `log-${entry.id}.json`,
    )
  }

  const backTo = `${location.pathname}${location.search}`
  const showEmptyState = !isLoading && !error && logs.length === 0

  return (
    <Box sx={{ maxWidth: 1600, mx: 'auto', py: { xs: 2, md: 3 } }}>
      <PageHeader
        title="Logs"
        description="Every upload, OCR call, classification, extraction, review, batch, retry and export the platform has recorded — with the failures among them."
        actions={
          <>
            <Button
              variant="outlined"
              color="inherit"
              startIcon={<InsightsIcon />}
              onClick={() => setIsAnalyticsOpen((open) => !open)}
              aria-expanded={isAnalyticsOpen}
            >
              {isAnalyticsOpen ? 'Hide analytics' : 'Analytics'}
            </Button>

            <Button
              variant="outlined"
              color="inherit"
              startIcon={<RefreshIcon />}
              onClick={reload}
              disabled={isRefreshing}
            >
              {isRefreshing ? 'Loading…' : 'Refresh'}
            </Button>

            <ExportButton
              label="Export all logs"
              onClick={() => handleExport('all', {}, 'All logs')}
              isLoading={pendingExport === 'all'}
              disabled={pendingExport !== null}
              title="Download every recorded log entry as .xlsx, ignoring the filters below."
            />

            <ExportButton
              variant="contained"
              color="primary"
              // The label carries the count precisely because this
              // button's meaning changes with the filters: "Export" next
              // to a filtered table is ambiguous about whether it
              // respects them, and a number is the shortest way to say
              // that it does.
              label={hasFilters ? `Export ${total.toLocaleString()} filtered` : 'Export to Excel'}
              onClick={() =>
                handleExport(
                  'filtered',
                  filters,
                  hasFilters ? `${total.toLocaleString()} filtered logs` : 'All logs',
                )
              }
              isLoading={pendingExport === 'filtered'}
              disabled={pendingExport !== null || total === 0}
              title={
                hasFilters
                  ? 'Download the entries matching the filters below as .xlsx.'
                  : 'Download every recorded log entry as .xlsx.'
              }
            />
          </>
        }
      />

      <LogAnalyticsPanel
        analytics={analytics.analytics}
        days={analytics.days}
        dayRangePresets={analytics.dayRangePresets}
        onDaysChange={analytics.setDays}
        isLoading={analytics.isLoading}
        error={analytics.error}
        isOpen={isAnalyticsOpen}
        onApplyFilters={applyCardFilters}
      />

      <Card>
        <Stack
          direction="row"
          spacing={1.5}
          useFlexGap
          sx={{ alignItems: 'center', flexWrap: 'wrap', p: 2, borderBottom: 1, borderColor: 'divider' }}
        >
          <TextField
            type="search"
            placeholder="Message, filename or batch id…"
            value={search}
            onChange={(event) => setFilter({ q: event.target.value })}
            sx={{ flex: '1 1 240px' }}
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
            label="Category"
            value={eventCategory}
            onChange={(event) => setFilter({ category: event.target.value })}
            sx={{ minWidth: 160 }}
          >
            <MenuItem value="">All categories</MenuItem>
            {options.event_categories.map((option) => (
              <MenuItem key={option} value={option}>
                {option}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            label="Event type"
            value={eventType}
            onChange={(event) => setFilter({ type: event.target.value })}
            sx={{ minWidth: 190 }}
          >
            <MenuItem value="">All event types</MenuItem>
            {options.event_types.map((option) => (
              <MenuItem key={option} value={option}>
                {option}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            label="Status"
            value={status}
            onChange={(event) => setFilter({ status: event.target.value })}
            sx={{ minWidth: 140 }}
          >
            <MenuItem value="">Any status</MenuItem>
            {options.statuses.map((option) => (
              <MenuItem key={option} value={option}>
                {option}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            label="Document type"
            value={documentType}
            onChange={(event) => setFilter({ doctype: event.target.value })}
            sx={{ minWidth: 170 }}
          >
            <MenuItem value="">All types</MenuItem>
            {options.document_types.map((option) => (
              <MenuItem key={option} value={option}>
                {option}
              </MenuItem>
            ))}
          </TextField>

          {/* `shrink` is forced on both date fields: a date input always
              renders its own placeholder text, so without this the label
              sits on top of "dd/mm/yyyy". */}
          <TextField
            type="date"
            label="From"
            value={dateFrom}
            onChange={(event) => setFilter({ from: event.target.value })}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ minWidth: 150 }}
          />
          <TextField
            type="date"
            label="To"
            value={dateTo}
            onChange={(event) => setFilter({ to: event.target.value })}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ minWidth: 150 }}
          />

          {hasFilters && (
            <Button color="inherit" startIcon={<FilterAltOffIcon />} onClick={clearFilters}>
              Clear
            </Button>
          )}
        </Stack>

        {error && <ErrorBanner message={error} sx={{ m: 2 }} />}

        {showEmptyState ? (
          hasFilters ? (
            <EmptyState
              icon={FilterAltOffIcon}
              title="No log entries match these filters"
              description="Nothing recorded so far matches what you're filtering on. Widen the date range or clear a filter."
              action={
                <Button variant="outlined" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={ReceiptLongIcon}
              title="Nothing logged yet"
              description="Process a document or run a batch, and every step it takes will be recorded here."
              action={
                <Button component={RouterLink} to="/" variant="contained">
                  Process a document
                </Button>
              }
            />
          )
        ) : (
          <>
            <TableContainer
              sx={{
                // Dimmed and inert while a newer page is in flight: the
                // rows on screen are a moment out of date, and clicking
                // into a row that is about to be replaced lands
                // somewhere the reader did not aim.
                opacity: isRefreshing && !isLoading ? 0.6 : 1,
                pointerEvents: isRefreshing && !isLoading ? 'none' : 'auto',
                transition: 'opacity 150ms ease',
              }}
              aria-busy={isRefreshing}
            >
              <Table size="small" sx={{ minWidth: 1100 }}>
                <TableHead>
                  <TableRow>
                    {COLUMNS.map((column) => (
                      <TableCell
                        key={column.id}
                        align={column.align}
                        sx={{ width: column.width }}
                        sortDirection={sortBy === column.sortKey ? sortDir : false}
                      >
                        {column.sortKey ? (
                          <TableSortLabel
                            active={sortBy === column.sortKey}
                            direction={sortBy === column.sortKey ? sortDir : 'desc'}
                            onClick={() => toggleSort(column.sortKey)}
                          >
                            {column.label}
                          </TableSortLabel>
                        ) : (
                          column.label
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                </TableHead>

                <TableBody>
                  {isLoading ? (
                    <TableRowsSkeleton rows={10} columns={COLUMNS.length} />
                  ) : (
                    logs.map((entry) => {
                      const timestamp = splitLogTimestamp(entry.created_at)
                      const duration = formatProcessingTime(entry.processing_time)

                      return (
                        <TableRow
                          key={entry.id}
                          hover
                          sx={{
                            // A failing row is tinted end to end rather
                            // than only in its status cell. A log table
                            // is scanned vertically at speed, and a
                            // single coloured chip in column five is
                            // easy to scroll straight past.
                            bgcolor:
                              entry.status === LOG_STATUS.FAILURE
                                ? (theme) => `${theme.palette.error.main}0f`
                                : undefined,
                          }}
                        >
                          <TableCell>
                            <Typography variant="caption" noWrap sx={{ display: 'block' }}>
                              {timestamp.date}
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              noWrap
                              sx={{ display: 'block', fontFamily: MONO_FAMILY }}
                            >
                              {timestamp.time}
                            </Typography>
                          </TableCell>

                          <TableCell>
                            <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                              {entry.event_type}
                            </Typography>
                          </TableCell>

                          <TableCell>
                            <Typography variant="caption" color="text.secondary" noWrap>
                              {entry.event_category}
                            </Typography>
                          </TableCell>

                          <TableCell sx={{ maxWidth: 190 }}>
                            {entry.filename ? (
                              <Tooltip title={entry.filename}>
                                <Typography
                                  variant="caption"
                                  noWrap
                                  sx={{ fontFamily: MONO_FAMILY, display: 'block' }}
                                >
                                  {entry.filename}
                                </Typography>
                              </Tooltip>
                            ) : (
                              <Typography variant="caption" color="text.disabled">
                                —
                              </Typography>
                            )}
                          </TableCell>

                          <TableCell>
                            <LogStatusChip status={entry.status} />
                          </TableCell>

                          <TableCell sx={{ maxWidth: 420 }}>
                            <Tooltip title={entry.message}>
                              {/* Clamped to two lines rather than one:
                                  a failure message is the row's whole
                                  content, and truncating it to a single
                                  line usually cuts off the part that
                                  says what failed. */}
                              <Typography
                                variant="body2"
                                sx={{
                                  display: '-webkit-box',
                                  WebkitLineClamp: 2,
                                  WebkitBoxOrient: 'vertical',
                                  overflow: 'hidden',
                                }}
                              >
                                {entry.message}
                              </Typography>
                            </Tooltip>
                          </TableCell>

                          <TableCell align="right">
                            <Typography
                              variant="caption"
                              color={duration ? 'text.secondary' : 'text.disabled'}
                              noWrap
                              sx={{ fontFamily: MONO_FAMILY }}
                            >
                              {duration ?? '—'}
                            </Typography>
                          </TableCell>

                          <TableCell align="right">
                            <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end' }}>
                              <Tooltip title="View full details">
                                <IconButton
                                  size="small"
                                  onClick={() => navigate(`/logs/${entry.id}`, { state: { backTo } })}
                                  aria-label={`View details of log entry ${entry.id}`}
                                >
                                  <VisibilityIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                              <Tooltip title="Download this entry as .json">
                                <IconButton
                                  size="small"
                                  onClick={() => downloadEntry(entry)}
                                  aria-label={`Download log entry ${entry.id}`}
                                >
                                  <DownloadIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                            </Stack>
                          </TableCell>
                        </TableRow>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </TableContainer>

            <TablePagination
              component="div"
              count={total}
              // MUI counts pages from 0, the URL from 1 — a
              // reader-facing `?page=1` is the first page, not the
              // second.
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
