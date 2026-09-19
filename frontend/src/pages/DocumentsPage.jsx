/**
 * The documents list: every document the system has ever stored, with
 * search, two filters, pagination, and a Review action per row.
 *
 * This is the screen that makes reviewing a real workflow rather than a
 * step that only exists in the seconds after an upload. Before it, the
 * review screen was reachable only from the pipeline's in-memory state,
 * so a document processed yesterday — or five minutes ago, before a page
 * refresh — had no path back to it even though the backend could serve it
 * the whole time.
 *
 * --- Why the controls live in the URL --------------------------------
 *
 * Search, both filters, the page, and the page size are held in the query
 * string (`useSearchParams`), not in `useState`. Three things fall out of
 * that for free: a filtered view is a link you can share or bookmark; a
 * refresh doesn't dump you back at page 1 of everything; and coming back
 * from a review lands on the same page of the same filtered list you left
 * (the Review link carries this URL along, see `backTo` below).
 *
 * --- Where the filtering happens -------------------------------------
 *
 * In memory, over the full list `useDocuments` loads — see that hook for
 * why, and for what to change if this table ever gets big enough for it
 * to matter.
 *
 * --- Where the exporting happens -------------------------------------
 *
 * On the server, which is the one part of this screen that deliberately
 * does *not* reuse the in-memory list above. Building a workbook from the
 * rows already loaded here would be less code, but it would cap the
 * export at whatever this screen happens to be holding and would
 * reimplement the column layout the backend already owns. So the filters
 * are sent as query params and the backend re-runs them against the
 * table (`backend/api/routes/export.py`), which is why its search
 * matching is written to mirror `searchTextFor` exactly — the two have to
 * agree on "matches" or "export what I'm looking at" quietly isn't.
 */
import { useMemo } from 'react'
import { Link as RouterLink, useLocation, useSearchParams } from 'react-router-dom'
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
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import RefreshIcon from '@mui/icons-material/Refresh'
import ClearIcon from '@mui/icons-material/Clear'
import DescriptionIcon from '@mui/icons-material/Description'
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff'
import RateReviewIcon from '@mui/icons-material/RateReview'
import DocumentTypeBadge from '../components/DocumentTypeBadge'
import ErrorBanner from '../components/ErrorBanner'
import ExportButton from '../components/ExportButton'
import ReviewStatusBadge from '../components/ReviewStatusBadge'
import EmptyState from '../components/common/EmptyState'
import PageHeader from '../components/common/PageHeader'
import { TableRowsSkeleton } from '../components/common/Skeletons'
import { useNotify } from '../components/feedback/snackbarContext'
import { useDocuments } from '../hooks/useDocuments'
import { useDocumentExport } from '../hooks/useDocumentExport'
import { isReviewable, searchTextFor, summarizeFields } from '../utils/documentRecords'
import { REVIEW_STATUS, REVIEW_STATUSES } from '../utils/reviewStatus'
import { MONO_FAMILY } from '../theme/theme'

const PAGE_SIZES = [10, 25, 50]
const DEFAULT_PAGE_SIZE = 10

/** A row's Review action, or the reason there isn't one. */
function ReviewCell({ document, backTo }) {
  if (!isReviewable(document)) {
    // `GET /documents/{filename}/review` answers 409 for a document that
    // was never extracted (usually because it classified as Unknown), so
    // offering the button here would hand the reviewer a dead end. The
    // row still lists the document — it exists, it just has no fields.
    return (
      <Tooltip title="This document has no extracted fields to review yet.">
        <Typography variant="caption" color="text.disabled" sx={{ whiteSpace: 'nowrap' }}>
          Not extracted
        </Typography>
      </Tooltip>
    )
  }

  return (
    <Button
      component={RouterLink}
      to={`/documents/${encodeURIComponent(document.filename)}/review`}
      // Router state, and therefore optional by construction: the review
      // screen works without it (a refresh drops it and the screen falls
      // back to a plain "All documents" link). It exists only so Back
      // returns to this exact filtered page.
      state={{ backTo }}
      size="small"
      variant="outlined"
      startIcon={<RateReviewIcon />}
    >
      Review
    </Button>
  )
}

export default function DocumentsPage() {
  const { documents, isLoading, error, reload } = useDocuments()
  const { runExport, pendingExport } = useDocumentExport()
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const notify = useNotify()

  const search = searchParams.get('q') ?? ''
  const typeFilter = searchParams.get('type') ?? ''
  const statusFilter = searchParams.get('status') ?? ''
  const pageSize = Number(searchParams.get('size')) || DEFAULT_PAGE_SIZE
  const requestedPage = Number(searchParams.get('page')) || 1

  /**
   * Writes a patch into the query string. Any key set to `''` is dropped
   * so a cleared filter leaves a clean URL instead of `?type=&status=`,
   * and `replace` keeps typing in the search box out of history — Back
   * should leave the list, not replay keystrokes.
   */
  const updateParams = (patch) => {
    const next = new URLSearchParams(searchParams)
    Object.entries(patch).forEach(([key, value]) => {
      if (value === '' || value === null || value === undefined) next.delete(key)
      else next.set(key, String(value))
    })
    setSearchParams(next, { replace: true })
  }

  // Any change to what's being filtered invalidates the current page
  // number, so every filter control resets it in the same update.
  const setFilter = (patch) => updateParams({ ...patch, page: null })

  // Derived from the fetched list, so the type dropdown can't drift from
  // the backend's DocumentType enum the way a hardcoded copy would — and
  // can't offer a type that would filter the table down to nothing.
  const typeOptions = useMemo(
    () => [...new Set(documents.map((document) => document.document_type))].sort(),
    [documents],
  )

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return documents.filter((document) => {
      if (typeFilter && document.document_type !== typeFilter) return false
      if (statusFilter && document.review_status !== statusFilter) return false
      if (needle && !searchTextFor(document).includes(needle)) return false
      return true
    })
  }, [documents, search, typeFilter, statusFilter])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  // Clamped rather than corrected in state: a `?page=9` that no longer
  // has results (because a filter narrowed the list) renders the last
  // real page instead of an empty table, without a render-time write to
  // the URL that would fight the user's own navigation.
  const page = Math.min(Math.max(requestedPage, 1), pageCount)
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize)

  const backTo = `${location.pathname}${location.search}`
  const hasFilters = Boolean(search || typeFilter || statusFilter)

  // Counted from the loaded list purely to label and enable the approved
  // export — the export itself re-derives the set server-side. An
  // "Export approved" button that hands back an empty spreadsheet is a
  // worse answer than one that says up front there's nothing to export.
  const approvedCount = useMemo(
    () => documents.filter((document) => document.review_status === REVIEW_STATUS.REVIEWED).length,
    [documents],
  )

  const handleExport = async (key, filters, description) => {
    const result = await runExport(key, filters)
    if (result.ok) notify.success(`${description} downloaded as ${result.filename}.`)
    else if (result.error) notify.error(result.error)
  }

  // The screen's own filters, in the shape the export API takes. The
  // free-text search goes along with them: the backend applies it the
  // same way this screen does, so the download matches the table rather
  // than quietly containing rows the user filtered out.
  const exportFiltered = () =>
    handleExport(
      'filtered',
      { documentType: typeFilter, reviewStatus: statusFilter, search },
      hasFilters ? `${filtered.length} filtered documents` : 'All documents',
    )

  // Deliberately ignores the filters above and exports every reviewed
  // document. "The approved set" is a fixed, meaningful thing to hand
  // someone; intersecting it with whatever happens to be typed in the
  // search box would make what you get depend on screen state nobody
  // reading the file can see. The tooltip says so on hover.
  const exportApproved = () =>
    handleExport('approved', { reviewStatus: REVIEW_STATUS.REVIEWED }, 'Approved documents')

  const showEmptyState = !isLoading && !error && filtered.length === 0

  return (
    <Box sx={{ maxWidth: 1500, mx: 'auto', py: { xs: 2, md: 3 } }}>
      <PageHeader
        title="Documents"
        description="Every document processed so far. Open one to check the extracted fields and correct anything the model got wrong."
        actions={
          <>
            <Button
              variant="outlined"
              color="inherit"
              startIcon={<RefreshIcon />}
              onClick={reload}
              disabled={isLoading}
            >
              {isLoading ? 'Loading…' : 'Refresh'}
            </Button>

            <ExportButton
              label="Export approved"
              onClick={exportApproved}
              isLoading={pendingExport === 'approved'}
              disabled={isLoading || approvedCount === 0}
              title={
                approvedCount === 0
                  ? 'No documents have been reviewed yet.'
                  : `Download the ${approvedCount} reviewed document${approvedCount === 1 ? '' : 's'} as .xlsx, ignoring the filters below.`
              }
            />

            <ExportButton
              variant="contained"
              color="primary"
              // The label carries the count precisely because this
              // button's meaning changes with the filters: "Export to
              // Excel" next to a filtered table is ambiguous about
              // whether it respects them, and a number is the shortest
              // way to say that it does.
              label={hasFilters ? `Export ${filtered.length} filtered` : 'Export to Excel'}
              onClick={exportFiltered}
              isLoading={pendingExport === 'filtered'}
              disabled={isLoading || filtered.length === 0}
              title={
                hasFilters
                  ? 'Download the documents matching the filters below as .xlsx.'
                  : 'Download every stored document as .xlsx.'
              }
            />
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
            placeholder="Filename or any extracted value…"
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
            label="Document type"
            value={typeFilter}
            onChange={(event) => setFilter({ type: event.target.value })}
            sx={{ minWidth: 190 }}
          >
            <MenuItem value="">All types</MenuItem>
            {typeOptions.map((option) => (
              <MenuItem key={option} value={option}>
                {option}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            label="Review status"
            value={statusFilter}
            onChange={(event) => setFilter({ status: event.target.value })}
            sx={{ minWidth: 175 }}
          >
            <MenuItem value="">Any status</MenuItem>
            {REVIEW_STATUSES.map((option) => (
              <MenuItem key={option} value={option}>
                {option}
              </MenuItem>
            ))}
          </TextField>

          {hasFilters && (
            <Button
              color="inherit"
              startIcon={<FilterAltOffIcon />}
              onClick={() => setFilter({ q: '', type: '', status: '' })}
            >
              Clear
            </Button>
          )}
        </Stack>

        {error && <ErrorBanner message={error} sx={{ m: 2 }} />}

        {showEmptyState ? (
          documents.length === 0 ? (
            <EmptyState
              icon={DescriptionIcon}
              title="No documents yet"
              description="Process your first document and it will appear here, ready to review."
              action={
                <Button component={RouterLink} to="/" variant="contained">
                  Process a document
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={FilterAltOffIcon}
              title="No documents match these filters"
              description={`${documents.length} documents are stored, but none of them match what you're filtering on.`}
              action={
                <Button
                  variant="outlined"
                  onClick={() => setFilter({ q: '', type: '', status: '' })}
                >
                  Clear filters
                </Button>
              }
            />
          )
        ) : (
          <>
            <TableContainer>
              <Table size="small" sx={{ minWidth: 880 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Document</TableCell>
                    <TableCell>Type</TableCell>
                    <TableCell>Extracted</TableCell>
                    <TableCell>Review status</TableCell>
                    <TableCell>Uploaded</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {isLoading ? (
                    <TableRowsSkeleton rows={pageSize > 10 ? 10 : pageSize} columns={6} />
                  ) : (
                    visible.map((document) => {
                      const summary = summarizeFields(document)
                      return (
                        <TableRow key={document.filename} hover>
                          <TableCell sx={{ maxWidth: 220 }}>
                            <Tooltip title={document.filename}>
                              <Typography
                                variant="caption"
                                noWrap
                                sx={{ fontFamily: MONO_FAMILY, display: 'block' }}
                              >
                                {document.filename}
                              </Typography>
                            </Tooltip>
                          </TableCell>
                          <TableCell>
                            <DocumentTypeBadge documentType={document.document_type} />
                          </TableCell>
                          <TableCell sx={{ maxWidth: 320 }}>
                            {summary.length === 0 ? (
                              <Typography variant="body2" color="text.disabled">
                                —
                              </Typography>
                            ) : (
                              <Stack spacing={0.25}>
                                {summary.map((field) => (
                                  <Typography key={field.label} variant="caption" noWrap>
                                    <Box component="span" sx={{ color: 'text.secondary' }}>
                                      {field.label}:
                                    </Box>{' '}
                                    {field.value}
                                  </Typography>
                                ))}
                              </Stack>
                            )}
                          </TableCell>
                          <TableCell>
                            <ReviewStatusBadge
                              status={document.review_status}
                              reviewedAt={document.reviewed_at}
                            />
                          </TableCell>
                          <TableCell>
                            <Typography variant="caption" color="text.secondary" noWrap>
                              {new Date(document.uploaded_at).toLocaleString()}
                            </Typography>
                          </TableCell>
                          <TableCell align="right">
                            <ReviewCell document={document} backTo={backTo} />
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
              count={filtered.length}
              // MUI counts pages from 0, the URL from 1 — a reader-facing
              // `?page=1` is the first page, not the second.
              page={page - 1}
              onPageChange={(_event, nextPage) => updateParams({ page: nextPage + 1 })}
              rowsPerPage={pageSize}
              rowsPerPageOptions={PAGE_SIZES}
              onRowsPerPageChange={(event) =>
                updateParams({ size: event.target.value, page: null })
              }
              labelRowsPerPage="Per page"
            />
          </>
        )}
      </Card>
    </Box>
  )
}
