/**
 * The batch half of the Process screen: pick many files, name the run,
 * upload, and go.
 *
 * Its own component rather than markup inside `UploadPage`, because the
 * Process screen's job is to lay out two ways of starting work side by
 * side, and it should not also own the state machine for one of them.
 * Everything about the transfer lives in `useBatchUpload`; everything
 * about what happens afterwards lives on the batch's own screen.
 *
 * --- Where it hands off ----------------------------------------------
 *
 * `onUploaded(batch)` fires once the server has the files. The parent
 * decides what that means — today it navigates to the new batch's page,
 * which is the only screen with a live progress feed. This component
 * deliberately does not navigate itself: a panel that yanks the page out
 * from under you is hard to reuse and harder to test.
 */
import { useState } from 'react'
import {
  Box,
  Button,
  Card,
  CardContent,
  LinearProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import MultiFileSelect from './MultiFileSelect'
import ErrorBanner from '../ErrorBanner'
import { useBatchUpload } from '../../hooks/useBatchUpload'
import { formatFileCount } from '../../utils/batchStatus'

// Mirrors the backend's `MAX_BATCH_FILES` default. A client-side copy of
// a server limit is normally a smell, and is right here: its only job is
// to stop a selection the server would reject *before* the operator
// spends several minutes uploading it. The server still enforces the
// real cap with a 413 — this is an early warning, never the authority.
const MAX_BATCH_FILES = 500

export default function BatchUploadPanel({ onUploaded, sx }) {
  const [files, setFiles] = useState([])
  const [batchName, setBatchName] = useState('')
  const upload = useBatchUpload()

  const handleUpload = async () => {
    const response = await upload.run(files, batchName)
    if (!response) return
    setFiles([])
    setBatchName('')
    upload.reset()
    onUploaded?.(response)
  }

  return (
    <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column', ...sx }}>
      <CardContent
        sx={{ p: { xs: 2, sm: 3 }, flex: 1, display: 'flex', flexDirection: 'column' }}
      >
        <Typography variant="h4" component="h2" sx={{ mb: 0.5 }}>
          Many documents
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Upload up to {MAX_BATCH_FILES.toLocaleString()} files at once. They process in the
          background — you can close this page while they run.
        </Typography>

        <Stack spacing={2} sx={{ flex: 1 }}>
          <MultiFileSelect
            files={files}
            onChange={setFiles}
            disabled={upload.isUploading}
            maxFiles={MAX_BATCH_FILES}
          />

          <TextField
            label="Batch name"
            placeholder="Optional — defaults to a timestamp"
            value={batchName}
            onChange={(event) => setBatchName(event.target.value)}
            disabled={upload.isUploading}
            helperText="A label to recognise this run by later, e.g. &ldquo;March invoices&rdquo;."
            fullWidth
          />

          {upload.isUploading && (
            <Box>
              <Stack
                direction="row"
                spacing={1}
                sx={{ alignItems: 'baseline', justifyContent: 'space-between', mb: 0.5 }}
              >
                <Typography variant="body2" color="text.secondary">
                  Uploading {formatFileCount(files.length)}&hellip;
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
                >
                  {upload.progress}%
                </Typography>
              </Stack>
              {/* Real bytes sent, not a timer — see `useBatchUpload`. */}
              <LinearProgress
                variant="determinate"
                value={upload.progress}
                sx={{ height: 8, borderRadius: 4 }}
              />
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: 'block' }}>
                This is the transfer only. Processing starts as soon as the files land.
              </Typography>
            </Box>
          )}

          {upload.error && (
            <ErrorBanner message={upload.error} title="Upload failed" onDismiss={upload.reset} />
          )}

          {/* Pinned to the bottom so the two panels' primary buttons line
              up even though their contents are different heights. */}
          <Stack direction="row" spacing={1.5} sx={{ mt: 'auto', pt: 1 }}>
            <Button
              variant="contained"
              size="large"
              startIcon={<PlayArrowIcon />}
              onClick={handleUpload}
              disabled={files.length === 0 || upload.isUploading}
            >
              {upload.isUploading
                ? 'Uploading…'
                : `Upload & process${files.length > 0 ? ` ${files.length.toLocaleString()}` : ''}`}
            </Button>
            {upload.isUploading && (
              <Button color="inherit" onClick={upload.cancel}>
                Cancel
              </Button>
            )}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  )
}
