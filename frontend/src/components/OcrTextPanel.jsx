/**
 * Displays the raw OCR text Vertex AI extracted, in a scrollable
 * monospace block — a multi-page document's text can run to thousands
 * of characters, and this keeps that from pushing the rest of the page
 * far down.
 *
 * Includes copy-to-clipboard and download, since the practical reason to
 * show raw OCR text at all is usually to take a piece of it (an ID
 * number, an address) or keep the whole thing — most of all for a
 * document the pipeline couldn't classify, where this transcript is the
 * only machine-readable output that document produced.
 *
 * `fill` switches it from "a block on a page" to "a pane that takes the
 * height its container gives it", which is what the review screen's
 * side-by-side layout needs so the transcript scrolls next to the form
 * rather than making the whole page long.
 */
import { useState } from 'react'
import { Box, Button, Paper, Stack, Tooltip, Typography } from '@mui/material'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import DownloadIcon from '@mui/icons-material/Download'
import CheckIcon from '@mui/icons-material/Check'
import { MONO_FAMILY } from '../theme/theme'
import { saveBlob } from '../utils/download'

export default function OcrTextPanel({
  text,
  downloadName = 'ocr-text.txt',
  title = 'OCR text',
  fill = false,
  minHeight = 220,
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text ?? '')
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied by the browser or OS sandbox;
      // the button simply not flipping to "Copied" is an acceptable
      // degraded state here, not worth an error banner over.
    }
  }

  /**
   * Saves the transcript as a .txt file.
   *
   * Built client-side from a Blob rather than fetched from an endpoint:
   * the text is already here, so a download endpoint would only add a
   * round trip (and a second place for the filename convention to live).
   * Reuses the same `saveBlob` the xlsx export uses, so both downloads
   * in this app go through one implementation.
   */
  const handleDownload = () => {
    saveBlob(new Blob([text ?? ''], { type: 'text/plain;charset=utf-8' }), downloadName)
  }

  const characterCount = text?.length ?? 0

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        height: fill ? '100%' : 'auto',
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', mb: 1.5 }}
      >
        <Box>
          <Typography variant="h4" component="h3">
            {title}
          </Typography>
          {characterCount > 0 && (
            <Typography variant="caption" color="text.secondary">
              {characterCount.toLocaleString()} characters
            </Typography>
          )}
        </Box>

        <Stack direction="row" spacing={1}>
          <Tooltip title="Copy the full transcript">
            <span>
              <Button
                size="small"
                variant="outlined"
                color={copied ? 'success' : 'inherit'}
                startIcon={copied ? <CheckIcon /> : <ContentCopyIcon />}
                onClick={handleCopy}
                disabled={!text}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </span>
          </Tooltip>
          <Tooltip title="Download as a .txt file">
            <span>
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                startIcon={<DownloadIcon />}
                onClick={handleDownload}
                disabled={!text}
              >
                Download
              </Button>
            </span>
          </Tooltip>
        </Stack>
      </Stack>

      <Paper
        variant="outlined"
        sx={{
          // `sunken` rather than `paper`: the transcript is raw source
          // material the reviewer reads against, not another card of the
          // app's own content, and recessing it says so without a label.
          bgcolor: 'sunken',
          p: 2,
          flex: fill ? 1 : 'none',
          minHeight,
          maxHeight: fill ? 'none' : 420,
          overflow: 'auto',
        }}
      >
        <Typography
          component="pre"
          sx={{
            m: 0,
            fontFamily: MONO_FAMILY,
            fontSize: '0.8125rem',
            lineHeight: 1.65,
            // OCR output has no line-length discipline of its own, so it
            // wraps here rather than forcing a horizontal scrollbar
            // across the whole pane.
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: text ? 'text.primary' : 'text.secondary',
          }}
        >
          {text || 'No text extracted.'}
        </Typography>
      </Paper>
    </Box>
  )
}
