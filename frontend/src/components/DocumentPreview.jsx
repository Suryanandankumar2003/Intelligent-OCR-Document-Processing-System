/**
 * The original uploaded file, rendered in place — the scan or PDF the
 * extracted fields actually came from.
 *
 * Served by `GET /documents/{filename}/file`, which returns the stored
 * bytes with `Content-Disposition: inline` so the browser renders rather
 * than downloads them.
 *
 * --- Why two renderers and not one -----------------------------------
 *
 * A PDF and a JPEG are different problems. An image is an `<img>`: the
 * browser decodes it, it scales to the pane, and zooming is something
 * this component has to provide. A PDF needs a viewer, and every browser
 * this app targets already ships one — pointing an `<iframe>` at the URL
 * gets page navigation, text selection, its own zoom and a print button
 * for free. Rendering PDFs ourselves would mean pdf.js, roughly half a
 * megabyte of bundle, to reimplement what is already installed.
 *
 * The cost of the iframe is that it is opaque: a PDF that fails to load
 * shows the browser's own error inside the frame, not ours, and no
 * `onError` fires. That is why **Open in new tab** is always present
 * rather than only on failure — it is the escape hatch for the case this
 * component cannot detect.
 *
 * --- Zoom, for images only -------------------------------------------
 *
 * Fit-to-width is the right default: the reviewer's first act is to see
 * the whole document. But the entire reason this pane exists is checking
 * a PAN number against a photograph of a card, and at fit-to-width in
 * half a screen that number can be a dozen pixels tall. So images get a
 * zoom control and pan by scrolling. PDFs do not, because their viewer
 * already has one and a second zoom stacked on top of it would fight it.
 */
import { useRef, useState } from 'react'
import { Box, Button, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import RemoveIcon from '@mui/icons-material/Remove'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import DownloadIcon from '@mui/icons-material/Download'
import BrokenImageIcon from '@mui/icons-material/BrokenImage'
import { documentFileUrl } from '../api/documents'

const ZOOM_STEPS = [1, 1.5, 2, 3, 4]
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg']

/** Whether this filename is something an `<img>` can render. */
function isImage(filename) {
  const lower = (filename ?? '').toLowerCase()
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

export default function DocumentPreview({ filename, fill = false, minHeight = 320 }) {
  const [zoomIndex, setZoomIndex] = useState(0)
  const [hasFailed, setHasFailed] = useState(false)
  const scrollRef = useRef(null)

  const url = documentFileUrl(filename)
  const showsImage = isImage(filename)
  const zoom = ZOOM_STEPS[zoomIndex]

  // A new document means a fresh view: zoom from a previous scan is
  // meaningless on this one, and a previous failure must not persist
  // onto a file that may load perfectly well.
  //
  // Adjusted during render rather than in an effect — React's documented
  // way to reset state when a prop changes. An effect would render once
  // with the *old* zoom applied to the *new* document before correcting
  // itself, which is a visible flash of the previous scan's framing.
  const [renderedFilename, setRenderedFilename] = useState(filename)
  if (renderedFilename !== filename) {
    setRenderedFilename(filename)
    setZoomIndex(0)
    setHasFailed(false)
  }

  // Zooming from the top-left corner would walk the document off-screen;
  // re-centring keeps whatever was in the middle of the pane in the
  // middle of it after the step.
  const applyZoom = (nextIndex) => {
    const container = scrollRef.current
    const previous = ZOOM_STEPS[zoomIndex]
    const next = ZOOM_STEPS[nextIndex]
    setZoomIndex(nextIndex)

    if (!container || previous === next) return
    const ratio = next / previous
    // Deferred to the frame after the new size is laid out; reading
    // scroll metrics before that gives the pre-zoom geometry.
    requestAnimationFrame(() => {
      container.scrollLeft =
        (container.scrollLeft + container.clientWidth / 2) * ratio - container.clientWidth / 2
      container.scrollTop =
        (container.scrollTop + container.clientHeight / 2) * ratio - container.clientHeight / 2
    })
  }

  const canZoomIn = showsImage && zoomIndex < ZOOM_STEPS.length - 1
  const canZoomOut = showsImage && zoomIndex > 0

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
            Original document
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {showsImage ? 'Scanned image' : 'PDF'}
            {showsImage && zoom > 1 ? ` · ${zoom}×` : ''}
          </Typography>
        </Box>

        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {showsImage && (
            <>
              <Tooltip title="Zoom out">
                <span>
                  <IconButton
                    size="small"
                    onClick={() => applyZoom(zoomIndex - 1)}
                    disabled={!canZoomOut}
                    aria-label="Zoom out"
                  >
                    <RemoveIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Zoom in">
                <span>
                  <IconButton
                    size="small"
                    onClick={() => applyZoom(zoomIndex + 1)}
                    disabled={!canZoomIn}
                    aria-label="Zoom in"
                  >
                    <AddIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              {zoom > 1 && (
                <Tooltip title="Fit to pane">
                  <IconButton size="small" onClick={() => applyZoom(0)} aria-label="Reset zoom">
                    <RestartAltIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
            </>
          )}

          {/* Always present, never conditional on a failure this
              component often cannot detect — see the file docstring. */}
          <Tooltip title="Open the full document in a new tab">
            <Button
              size="small"
              variant="outlined"
              color="inherit"
              startIcon={<OpenInNewIcon />}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open
            </Button>
          </Tooltip>
        </Stack>
      </Stack>

      <Paper
        ref={showsImage ? scrollRef : undefined}
        variant="outlined"
        sx={{
          // Same recessed surface the transcript uses: both are source
          // material the reviewer reads against, not the app's own
          // content, and they should read as the same kind of thing.
          bgcolor: 'sunken',
          flex: fill ? 1 : 'none',
          minHeight,
          maxHeight: fill ? 'none' : 560,
          overflow: 'auto',
          display: 'flex',
          // Centred while it fits; the flex-start override below is what
          // keeps a zoomed image scrollable to its own edges rather than
          // clipped by the centring.
          alignItems: zoom > 1 ? 'flex-start' : 'center',
          justifyContent: zoom > 1 ? 'flex-start' : 'center',
          p: showsImage ? 1 : 0,
        }}
      >
        {hasFailed ? (
          <Stack spacing={1.5} sx={{ alignItems: 'center', textAlign: 'center', p: 3 }}>
            <BrokenImageIcon color="disabled" />
            <Typography variant="body2" color="text.secondary" sx={{ maxWidth: '40ch' }}>
              The original file could not be loaded. It may have been removed from the uploads
              folder — the extracted fields beside this are unaffected.
            </Typography>
            <Button
              size="small"
              variant="outlined"
              startIcon={<DownloadIcon />}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Try opening it directly
            </Button>
          </Stack>
        ) : showsImage ? (
          <Box
            component="img"
            src={url}
            alt={`Original scanned document ${filename}`}
            onError={() => setHasFailed(true)}
            sx={{
              display: 'block',
              // At 1× the image fits the pane; beyond it the width drives
              // the size and the container scrolls.
              width: zoom > 1 ? `${zoom * 100}%` : 'auto',
              maxWidth: zoom > 1 ? 'none' : '100%',
              maxHeight: zoom > 1 ? 'none' : '100%',
              objectFit: 'contain',
              // A white plate behind the scan: a dark-mode surface behind
              // a document photographed on white paper makes the page
              // edges vanish.
              bgcolor: '#fff',
              borderRadius: 1,
            }}
          />
        ) : (
          <Box
            component="iframe"
            src={url}
            title={`Original document ${filename}`}
            sx={{ width: '100%', height: '100%', minHeight, border: 0, display: 'block' }}
          />
        )}
      </Paper>
    </Box>
  )
}
