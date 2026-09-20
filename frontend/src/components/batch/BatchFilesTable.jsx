/**
 * The file table on a batch's details page: every file in the batch,
 * what happened to it, and the two things you can do about it — retry a
 * failure, or open a success for review.
 *
 * --- The row's action depends on its outcome -------------------------
 *
 * A succeeded file's next step is the review screen; a failed file's is
 * a retry; a file still running has no next step at all. Rendering all
 * three as a single always-present button (disabled two-thirds of the
 * time) would be less code and would tell the operator nothing. The
 * action cell therefore switches on status, and the one case that needs
 * explaining — a failure that has exhausted its retries — says so
 * instead of showing a dead control.
 *
 * --- The error message is the point ----------------------------------
 *
 * A failed row shows the backend's own sentence ("File exceeds the
 * maximum allowed size of 10 MB.", "Processing timed out…"), which the
 * exceptions in backend/core/exceptions.py are already written to be
 * read by a person. It is truncated to one line with the full text in a
 * tooltip: in a 500-row table a wrapped three-line error would push
 * every other row off the screen, and the first clause is almost always
 * the part that says what to do.
 *
 * Presentation only — it holds no state and fetches nothing. Paging,
 * filtering and the retry call all belong to the page above it.
 */
import { Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Button,
  CircularProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material'
import RateReviewIcon from '@mui/icons-material/RateReview'
import ReplayIcon from '@mui/icons-material/Replay'
import BatchStatusBadge from './BatchStatusBadge'
import DocumentTypeBadge from '../DocumentTypeBadge'
import { TableRowsSkeleton } from '../common/Skeletons'
import { BATCH_FILE_STATUS } from '../../utils/batchStatus'
import { formatDurationSeconds } from '../../utils/analyticsFormat'
import { MONO_FAMILY } from '../../theme/theme'

/** What this row lets you do next, given what happened to it. */
function FileActionCell({ file, maxRetries, onRetry, isRetrying, backTo }) {
  if (file.processing_status === BATCH_FILE_STATUS.SUCCESS) {
    // Only a file that produced extractable fields has a review screen
    // to open. One classified `Unknown` succeeded — it is not a failure
    // — but `GET /documents/{filename}/review` answers 409 for it, so
    // linking there would hand the reviewer a dead end.
    if (!file.document_type || file.document_type === 'Unknown') {
      return (
        <Tooltip title="Processed, but no document type was recognised, so there are no fields to review.">
          <Typography variant="caption" color="text.disabled" sx={{ whiteSpace: 'nowrap' }}>
            Not extracted
          </Typography>
        </Tooltip>
      )
    }
    return (
      <Button
        component={RouterLink}
        to={`/documents/${encodeURIComponent(file.filename)}/review`}
        state={{ backTo }}
        size="small"
        variant="outlined"
        startIcon={<RateReviewIcon />}
      >
        Review
      </Button>
    )
  }

  if (file.processing_status === BATCH_FILE_STATUS.FAILED) {
    const isExhausted = file.retry_count >= maxRetries
    if (isExhausted) {
      return (
        <Tooltip title={`This file has been retried ${file.retry_count} times, the maximum. Re-upload it if you think the problem is fixed.`}>
          <Typography variant="caption" color="text.disabled" sx={{ whiteSpace: 'nowrap' }}>
            No retries left
          </Typography>
        </Tooltip>
      )
    }
    return (
      <Button
        size="small"
        variant="outlined"
        color="warning"
        startIcon={isRetrying ? <CircularProgress size={14} color="inherit" /> : <ReplayIcon />}
        onClick={() => onRetry(file.id)}
        disabled={isRetrying}
      >
        Retry
      </Button>
    )
  }

  return (
    <Typography variant="caption" color="text.disabled" sx={{ whiteSpace: 'nowrap' }}>
      —
    </Typography>
  )
}

export default function BatchFilesTable({
  files,
  total,
  page,
  pageSize,
  pageSizes,
  onPageChange,
  onPageSizeChange,
  isLoading,
  maxRetries,
  pendingRetry,
  onRetryFile,
  backTo,
}) {
  return (
    <>
      <TableContainer>
        <Table size="small" sx={{ minWidth: 960 }}>
          <TableHead>
            <TableRow>
              <TableCell>File</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Type</TableCell>
              <TableCell sx={{ minWidth: 220 }}>Result</TableCell>
              <TableCell>Time</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <TableRowsSkeleton rows={Math.min(pageSize, 10)} columns={6} />
            ) : (
              files.map((file) => (
                <TableRow key={file.id} hover>
                  <TableCell sx={{ maxWidth: 260 }}>
                    <Typography variant="body2" noWrap title={file.original_filename}>
                      {file.original_filename}
                    </Typography>
                    {/* The stored name, which is what every other screen
                        and the filesystem know this document by — worth
                        having when cross-referencing, worth being small. */}
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      noWrap
                      sx={{ fontFamily: MONO_FAMILY, display: 'block' }}
                    >
                      {file.filename}
                    </Typography>
                  </TableCell>

                  <TableCell>
                    <Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
                      <BatchStatusBadge status={file.processing_status} showHint={false} />
                      {file.retry_count > 0 && (
                        <Typography variant="caption" color="text.secondary">
                          retried {file.retry_count}×
                        </Typography>
                      )}
                    </Stack>
                  </TableCell>

                  <TableCell>
                    {file.document_type ? (
                      <DocumentTypeBadge documentType={file.document_type} />
                    ) : (
                      <Typography variant="body2" color="text.disabled">
                        —
                      </Typography>
                    )}
                  </TableCell>

                  <TableCell sx={{ maxWidth: 340 }}>
                    {file.error_message ? (
                      <Tooltip title={file.error_message}>
                        <Typography variant="caption" color="error.main" noWrap sx={{ display: 'block' }}>
                          {file.error_message}
                        </Typography>
                      </Tooltip>
                    ) : file.processing_status === BATCH_FILE_STATUS.SUCCESS ? (
                      <Typography variant="caption" color="success.main">
                        Extracted
                      </Typography>
                    ) : (
                      <Typography variant="caption" color="text.disabled">
                        —
                      </Typography>
                    )}
                  </TableCell>

                  <TableCell>
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {formatDurationSeconds(file.processing_time_seconds) ?? '—'}
                    </Typography>
                  </TableCell>

                  <TableCell align="right">
                    <FileActionCell
                      file={file}
                      maxRetries={maxRetries}
                      onRetry={onRetryFile}
                      isRetrying={pendingRetry === file.id}
                      backTo={backTo}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}

            {!isLoading && files.length === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <Box sx={{ py: 3, textAlign: 'center' }}>
                    <Typography variant="body2" color="text.secondary">
                      No files in this batch match the current filter.
                    </Typography>
                  </Box>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <TablePagination
        component="div"
        count={total}
        page={page - 1}
        onPageChange={(_event, nextPage) => onPageChange(nextPage + 1)}
        rowsPerPage={pageSize}
        rowsPerPageOptions={pageSizes}
        onRowsPerPageChange={(event) => onPageSizeChange(Number(event.target.value))}
        labelRowsPerPage="Per page"
      />
    </>
  )
}
