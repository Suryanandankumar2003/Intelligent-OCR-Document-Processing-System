/**
 * One log entry in full: what happened, when, how long it took, the
 * structured payload behind it, and links to the document and batch it
 * was about.
 *
 * --- Why it is a route and not a dialog ------------------------------
 *
 * `/logs/:logId` is a URL, so an entry can be bookmarked, sent to a
 * colleague, and reopened after a refresh. That is the entire reason a
 * log exists: someone is going to paste one of these links into a
 * ticket, and a modal over the list is not a thing that can be pasted.
 * It also means the screen loads its own data rather than reading a row
 * the list happened to be holding — see `useLogDetail`.
 *
 * `backTo` rides along in router state so Back returns to the exact
 * filtered page of the list the reader came from. It is optional by
 * construction: a refresh drops it and the screen falls back to the
 * plain list, which is the correct behaviour for a link that arrived by
 * email with no history behind it.
 *
 * --- Related records, and the fact that they may be gone -------------
 *
 * The backend resolves the document and the batch and reports whether
 * each still exists. Both are shown either way: "this referred to a
 * document that has since been deleted" is one of the more useful things
 * an audit trail can say, and hiding the reference when the record is
 * gone would silently turn a deletion into a blank space.
 */
import { Link as RouterLink, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  Box,
  Breadcrumbs,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Link,
  Stack,
  Typography,
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import DownloadIcon from '@mui/icons-material/Download'
import DescriptionIcon from '@mui/icons-material/Description'
import LayersIcon from '@mui/icons-material/Layers'
import ManageSearchIcon from '@mui/icons-material/ManageSearch'
import ErrorBanner from '../components/ErrorBanner'
import JsonBlock from '../components/logs/JsonBlock'
import LogStatusChip from '../components/logs/LogStatusChip'
import { ChartSkeleton } from '../components/common/Skeletons'
import { useLogDetail } from '../hooks/useLogDetail'
import { formatLogTimestamp, formatProcessingTime } from '../utils/logEvents'
import { saveBlob } from '../utils/download'
import { MONO_FAMILY } from '../theme/theme'

/** One label/value pair in the properties list. */
function Property({ label, children, mono = false }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Typography
        variant="body2"
        sx={{ fontFamily: mono ? MONO_FAMILY : undefined, wordBreak: 'break-word' }}
      >
        {children ?? '—'}
      </Typography>
    </Box>
  )
}

export default function LogDetailPage() {
  const { logId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { detail, isLoading, error } = useLogDetail(logId)

  const returnTo = location.state?.backTo ?? '/logs'
  const entry = detail?.log

  const handleDownload = () => {
    if (!detail) return
    saveBlob(
      new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json;charset=utf-8' }),
      `log-${entry.id}.json`,
    )
  }

  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto', py: { xs: 2, md: 3 } }}>
      <Breadcrumbs sx={{ mb: 1.5 }}>
        <Link component={RouterLink} to={returnTo} underline="hover" color="inherit" variant="body2">
          Logs
        </Link>
        <Typography variant="body2" color="text.primary">
          Entry {logId}
        </Typography>
      </Breadcrumbs>

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ alignItems: { sm: 'flex-start' }, justifyContent: 'space-between', mb: 3 }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h2" component="h2" sx={{ mb: 0.75 }}>
            {entry?.event_type ?? 'Log entry'}
          </Typography>
          {entry && (
            <Typography variant="body2" color="text.secondary">
              {formatLogTimestamp(entry.created_at)}
            </Typography>
          )}
        </Box>

        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          {entry && <LogStatusChip status={entry.status} />}
          <Button
            size="small"
            variant="outlined"
            color="inherit"
            startIcon={<DownloadIcon />}
            onClick={handleDownload}
            disabled={!detail}
          >
            Download entry
          </Button>
          <Button
            component={RouterLink}
            to={returnTo}
            size="small"
            color="inherit"
            startIcon={<ArrowBackIcon />}
          >
            Back
          </Button>
        </Stack>
      </Stack>

      {error && <ErrorBanner message={error} title="Could not load this log entry" />}

      {isLoading && !detail && <ChartSkeleton height={280} />}

      {detail && (
        <Stack spacing={2.5}>
          <Card>
            <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
              <Typography variant="h4" component="h3" sx={{ mb: 2 }}>
                What happened
              </Typography>

              <Typography variant="body1" sx={{ mb: 2.5 }}>
                {entry.message}
              </Typography>

              <Box
                sx={{
                  display: 'grid',
                  gap: 2,
                  gridTemplateColumns: {
                    xs: '1fr',
                    sm: 'repeat(2, 1fr)',
                    md: 'repeat(3, 1fr)',
                  },
                }}
              >
                <Property label="Event type">{entry.event_type}</Property>
                <Property label="Category">{entry.event_category}</Property>
                <Property label="Status">{entry.status}</Property>
                <Property label="Recorded at">{formatLogTimestamp(entry.created_at)}</Property>
                <Property label="Processing time">
                  {/* An em dash, not "0s": `null` here means this entry
                      records a moment rather than an operation — a
                      `Started` row, or an approval — and calling that
                      zero seconds would be a number nobody should read
                      as one. */}
                  {formatProcessingTime(entry.processing_time) ?? '— not a timed operation'}
                </Property>
                <Property label="Entry id" mono>
                  {entry.id}
                </Property>
              </Box>
            </CardContent>
          </Card>

          <Card>
            <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', mb: 2 }}
              >
                <Typography variant="h4" component="h3">
                  Related records
                </Typography>
                {detail.related_log_count > 0 && (
                  <Button
                    component={RouterLink}
                    // Scoped to whichever relation this entry actually
                    // has. A batch is the wider story where there is
                    // one; a filename is the right scope where there is
                    // not.
                    to={
                      entry.batch_id
                        ? `/logs?q=${encodeURIComponent(entry.batch_id)}`
                        : `/logs?q=${encodeURIComponent(entry.filename ?? '')}`
                    }
                    size="small"
                    variant="outlined"
                    color="inherit"
                    startIcon={<ManageSearchIcon />}
                  >
                    {detail.related_log_count} related{' '}
                    {detail.related_log_count === 1 ? 'entry' : 'entries'}
                  </Button>
                )}
              </Stack>

              <Stack
                divider={<Divider flexItem />}
                spacing={2}
                sx={{ '& > *': { pt: 0 } }}
              >
                <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
                  <DescriptionIcon fontSize="small" sx={{ color: 'text.secondary', mt: 0.25 }} />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="subtitle2">Document</Typography>
                    {entry.filename ? (
                      <>
                        <Typography
                          variant="caption"
                          sx={{ fontFamily: MONO_FAMILY, display: 'block', wordBreak: 'break-all' }}
                        >
                          {entry.filename}
                        </Typography>
                        <Stack
                          direction="row"
                          spacing={1}
                          useFlexGap
                          sx={{ alignItems: 'center', flexWrap: 'wrap', mt: 1 }}
                        >
                          {entry.document_type && (
                            <Chip label={entry.document_type} size="small" variant="outlined" />
                          )}
                          {detail.document_exists ? (
                            <>
                              {detail.document_review_status && (
                                <Chip
                                  label={detail.document_review_status}
                                  size="small"
                                  variant="outlined"
                                />
                              )}
                              <Button
                                size="small"
                                variant="outlined"
                                onClick={() =>
                                  navigate(
                                    `/documents/${encodeURIComponent(entry.filename)}/review`,
                                    { state: { backTo: `/logs/${entry.id}` } },
                                  )
                                }
                              >
                                Open review
                              </Button>
                            </>
                          ) : (
                            <Typography variant="caption" color="text.secondary">
                              This document record no longer exists. The entry describing it does.
                            </Typography>
                          )}
                        </Stack>
                      </>
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        This event was not about a specific document.
                      </Typography>
                    )}
                  </Box>
                </Stack>

                <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
                  <LayersIcon fontSize="small" sx={{ color: 'text.secondary', mt: 0.25 }} />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="subtitle2">Batch</Typography>
                    {entry.batch_id ? (
                      <>
                        <Typography
                          variant="caption"
                          sx={{ fontFamily: MONO_FAMILY, display: 'block', wordBreak: 'break-all' }}
                        >
                          {detail.batch_name ?? entry.batch_id}
                        </Typography>
                        <Box sx={{ mt: 1 }}>
                          {detail.batch_exists ? (
                            <Button
                              component={RouterLink}
                              to={`/batches/${entry.batch_id}`}
                              size="small"
                              variant="outlined"
                            >
                              Open batch
                            </Button>
                          ) : (
                            <Typography variant="caption" color="text.secondary">
                              This batch has been deleted. Its log entries were deliberately kept.
                            </Typography>
                          )}
                        </Box>
                      </>
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        This event was not part of a batch.
                      </Typography>
                    )}
                  </Box>
                </Stack>
              </Stack>
            </CardContent>
          </Card>

          <Card>
            <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
              <JsonBlock
                value={entry.details_json}
                title="JSON payload"
                downloadName={`log-${entry.id}-details.json`}
              />
            </CardContent>
          </Card>
        </Stack>
      )}
    </Box>
  )
}
