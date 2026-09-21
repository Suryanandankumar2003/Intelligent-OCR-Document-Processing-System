/**
 * The original uploaded document, rendered in place with the controls a
 * reviewer needs to actually read it: zoom, fit to width, page
 * navigation, download, and highlighting of the values extracted from
 * it.
 *
 * Replaces the earlier `DocumentPreview`, which showed an image in an
 * `<img>` and a PDF in an `<iframe>`. That was the right first answer —
 * it cost nothing and the browser's built-in PDF viewer is good — and it
 * could not be extended, because an iframe is opaque to the page
 * containing it: its zoom cannot be set, its current page cannot be
 * read, and its text cannot be reached, which is three of the five
 * features this component exists to provide. See `viewer/pdfjs.js`.
 *
 * --- One component, two renderers ------------------------------------
 *
 * A PDF and a JPEG stay different problems underneath — one is paged and
 * has a text layer, the other is a single bitmap with neither — but the
 * *controls* are the same controls, and a reviewer switching between an
 * invoice PDF and a photographed PAN card should not find the toolbar
 * rearranged. So the toolbar is shared and driven by one `scale`,
 * with the controls a given file cannot support disabled and explained
 * rather than hidden: a "Page 1 of 1" that is greyed out says "this
 * document has one page", where an absent control says nothing at all.
 *
 * --- Fit to width is the default -------------------------------------
 *
 * Because the reviewer's first act is always to see the whole document,
 * and a pane at an arbitrary fixed zoom starts them by scrolling. It is
 * also re-applied when the pane itself changes size (the `ResizeObserver`
 * below), so dragging the window narrower keeps the document fitting
 * instead of quietly clipping it — until the reviewer takes manual
 * control by zooming, at which point their choice is respected and the
 * automatic fit stops.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Button,
  CircularProgress,
  Divider,
  IconButton,
  Paper,
  Stack,
  ToggleButton,
  Tooltip,
  Typography,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import RemoveIcon from '@mui/icons-material/Remove'
import FitScreenIcon from '@mui/icons-material/FitScreen'
import NavigateBeforeIcon from '@mui/icons-material/NavigateBefore'
import NavigateNextIcon from '@mui/icons-material/NavigateNext'
import DownloadIcon from '@mui/icons-material/Download'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import HighlightIcon from '@mui/icons-material/Highlight'
import BrokenImageIcon from '@mui/icons-material/BrokenImage'
import { documentFileUrl, downloadDocumentFile } from '../api/documents'
import { extractBlobErrorMessage } from '../api/errorMessage'
import { saveBlob } from '../utils/download'
import { useNotify } from './feedback/snackbarContext'
import PdfPageView from './viewer/PdfPageView'
import {
  PDF_ASSET_OPTIONS,
  ZOOM_STEPS,
  fitWidthScale,
  loadPdfjs,
  nearestZoomIndex,
} from './viewer/pdfjs'
import { termsForFields } from './viewer/highlightTerms'

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg']

// The gutter the scroll container keeps around the page, in CSS pixels.
// Subtracted before computing a fit, so fit-to-width leaves the document
// breathing room instead of pressing it against both edges — and, more
// practically, so the fit does not itself introduce a horizontal
// scrollbar whose width then breaks the fit.
const VIEWPORT_PADDING = 32

/** Whether this filename is something an `<img>` can render. */
function isImage(filename) {
  const lower = (filename ?? '').toLowerCase()
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

export default function DocumentViewer({
  filename,
  fields,
  fill = false,
  minHeight = 320,
}) {
  const notify = useNotify()
  const scrollRef = useRef(null)

  const showsImage = isImage(filename)
  const url = useMemo(() => documentFileUrl(filename), [filename])

  const [pdf, setPdf] = useState(null)
  const [page, setPage] = useState(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [scale, setScale] = useState(1)
  // `true` until the reviewer zooms. Held separately from `scale`
  // because "fit" is a rule that must survive a resize, while a scale is
  // a number that must not be overwritten by one.
  const [isFitToWidth, setIsFitToWidth] = useState(true)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)
  const [isDownloading, setIsDownloading] = useState(false)

  const [highlightsEnabled, setHighlightsEnabled] = useState(true)
  const [highlightCount, setHighlightCount] = useState(0)
  const [hasTextLayer, setHasTextLayer] = useState(true)
  const [imageSize, setImageSize] = useState(null)

  const terms = useMemo(() => termsForFields(fields), [fields])

  // A new document is a fresh view in every sense: a previous file's
  // zoom means nothing on this one, a previous page number may not
  // exist in it, and a previous failure must not persist onto a file
  // that may load perfectly well.
  //
  // Adjusted during render rather than in an effect — React's documented
  // way to reset state when a prop changes, and the idiom
  // `hooks/useReviewDraft.js` already uses. An effect would render once
  // with the *old* zoom and page number applied to the *new* document
  // before correcting itself, which is a visible flash of the previous
  // document's framing.
  const [renderedUrl, setRenderedUrl] = useState(url)
  if (renderedUrl !== url) {
    setRenderedUrl(url)
    setPageNumber(1)
    setIsFitToWidth(true)
    setIsLoading(true)
    setError(null)
    setHighlightCount(0)
    setHasTextLayer(true)
    setImageSize(null)
    setPdf(null)
    setPage(null)
  }

  // --- Loading ---------------------------------------------------------

  useEffect(() => {
    if (showsImage) return undefined

    let cancelled = false
    let loadingTask = null

    loadPdfjs()
      .then((pdfjs) => {
        if (cancelled) return null
        loadingTask = pdfjs.getDocument({ ...PDF_ASSET_OPTIONS, url })
        return loadingTask.promise
      })
      .then((document) => {
        if (cancelled || !document) return
        setPdf(document)
        setIsLoading(false)
      })
      .catch((loadError) => {
        if (cancelled) return
        setIsLoading(false)
        setError(
          loadError?.name === 'MissingPDFException'
            ? 'The original file could not be found. It may have been removed from the uploads folder.'
            : 'This PDF could not be opened. You can still download it or open it in a new tab.',
        )
      })

    return () => {
      cancelled = true
      // Frees the worker's copy of the document, on a `url` change and
      // on unmount alike. Without it, paging between a dozen documents
      // in a review session leaks a parsed PDF each time — on a worker
      // thread, where nothing in the React tree would ever collect it.
      //
      // This closure holds *its own* run's task, so it always destroys
      // the document that run created and never one a newer run has
      // since put in its place.
      loadingTask?.destroy()
    }
  }, [url, showsImage])

  // The current page proxy, re-fetched whenever the reviewer pages.
  useEffect(() => {
    if (!pdf) return undefined

    let cancelled = false
    pdf
      .getPage(pageNumber)
      .then((loaded) => {
        if (!cancelled) setPage(loaded)
      })
      .catch(() => {
        if (!cancelled) setError('That page could not be read from this PDF.')
      })
    return () => {
      cancelled = true
    }
  }, [pdf, pageNumber])

  // --- Fitting ---------------------------------------------------------

  /** The scale that makes the current page fill the pane, or `null` if that is not computable yet. */
  const computeFitScale = useCallback(() => {
    const container = scrollRef.current
    if (!container) return null
    const available = container.clientWidth - VIEWPORT_PADDING
    if (available <= 0) return null

    if (showsImage) {
      if (!imageSize?.width) return null
      return Math.min(
        Math.max(available / imageSize.width, ZOOM_STEPS[0]),
        ZOOM_STEPS[ZOOM_STEPS.length - 1],
      )
    }
    return page ? fitWidthScale(page, available) : null
  }, [showsImage, imageSize, page])

  const applyFit = useCallback(() => {
    const next = computeFitScale()
    if (next !== null) setScale(next)
  }, [computeFitScale])

  // Re-fit when the thing being fitted changes (a new page, a loaded
  // image) and when the pane it is fitted to changes size — but only
  // while the reviewer has not taken over. `ResizeObserver` rather than
  // a window resize listener, because this pane also changes width when
  // the *layout* changes around it, which a window event never fires
  // for.
  useEffect(() => {
    if (!isFitToWidth) return undefined
    // The one setState-in-an-effect here that is genuinely right: the
    // scale is a function of the pane's *measured* width, which does
    // not exist until after layout and cannot be derived during render.
    // eslint-disable-next-line react/set-state-in-effect -- the external system being synchronized with is the element's measured size
    applyFit()

    const container = scrollRef.current
    if (!container || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => applyFit())
    observer.observe(container)
    return () => observer.disconnect()
  }, [isFitToWidth, applyFit])

  // --- Controls --------------------------------------------------------

  const zoomBy = (direction) => {
    const currentIndex = nearestZoomIndex(scale)
    const nextIndex = Math.min(Math.max(currentIndex + direction, 0), ZOOM_STEPS.length - 1)
    // Taking manual control cancels the automatic fit — otherwise the
    // next resize would silently undo the zoom the reviewer just chose.
    setIsFitToWidth(false)
    setScale(ZOOM_STEPS[nextIndex])
  }

  const canZoomIn = scale < ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.001
  const canZoomOut = scale > ZOOM_STEPS[0] + 0.001

  const pageCount = showsImage ? 1 : (pdf?.numPages ?? 0)
  const canGoBack = pageNumber > 1
  const canGoForward = pageNumber < pageCount

  const handleDownload = async () => {
    if (isDownloading) return
    setIsDownloading(true)
    try {
      const { blob, filename: savedAs } = await downloadDocumentFile(filename)
      saveBlob(blob, savedAs)
    } catch (downloadError) {
      notify.error(
        await extractBlobErrorMessage(
          downloadError,
          'Could not download the original document.',
        ),
      )
    } finally {
      setIsDownloading(false)
    }
  }

  // Two different reasons highlighting is unavailable, and the
  // difference matters to the reviewer: an image has no text to search,
  // while a text-bearing page with no matches means the extracted values
  // are not on *this* page. Collapsing them into one greyed-out button
  // would leave them guessing which.
  const highlightReason = showsImage
    ? 'Highlighting needs a text layer, which a scanned image does not have.'
    : !hasTextLayer
      ? 'This page has no text layer — it is a scanned image inside a PDF.'
      : terms.length === 0
        ? 'There are no extracted values long enough to search for.'
        : highlightsEnabled
          ? `${highlightCount} highlight${highlightCount === 1 ? '' : 's'} on this page.`
          : 'Highlight the extracted values on this page.'

  const canHighlight = !showsImage && hasTextLayer && terms.length > 0

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
        spacing={0.5}
        useFlexGap
        sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 1.5 }}
      >
        <Tooltip title="Previous page">
          <span>
            <IconButton
              size="small"
              onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
              disabled={!canGoBack}
              aria-label="Previous page"
            >
              <NavigateBeforeIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ minWidth: 68, textAlign: 'center', whiteSpace: 'nowrap' }}
          aria-live="polite"
        >
          {pageCount > 0 ? `${pageNumber} / ${pageCount}` : '—'}
        </Typography>

        <Tooltip title="Next page">
          <span>
            <IconButton
              size="small"
              onClick={() => setPageNumber((current) => Math.min(pageCount, current + 1))}
              disabled={!canGoForward}
              aria-label="Next page"
            >
              <NavigateNextIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />

        <Tooltip title="Zoom out">
          <span>
            <IconButton
              size="small"
              onClick={() => zoomBy(-1)}
              disabled={!canZoomOut}
              aria-label="Zoom out"
            >
              <RemoveIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ minWidth: 46, textAlign: 'center' }}
        >
          {Math.round(scale * 100)}%
        </Typography>

        <Tooltip title="Zoom in">
          <span>
            <IconButton
              size="small"
              onClick={() => zoomBy(1)}
              disabled={!canZoomIn}
              aria-label="Zoom in"
            >
              <AddIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title="Fit the document to the width of this pane">
          <span>
            <ToggleButton
              value="fit"
              size="small"
              selected={isFitToWidth}
              onChange={() => {
                setIsFitToWidth(true)
                applyFit()
              }}
              sx={{ px: 1, py: 0.25, border: 0 }}
              aria-label="Fit to width"
            >
              <FitScreenIcon fontSize="small" />
            </ToggleButton>
          </span>
        </Tooltip>

        <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />

        <Tooltip title={highlightReason}>
          <span>
            <ToggleButton
              value="highlight"
              size="small"
              selected={highlightsEnabled && canHighlight}
              disabled={!canHighlight}
              onChange={() => setHighlightsEnabled((enabled) => !enabled)}
              sx={{ px: 1, py: 0.25, border: 0 }}
              aria-label="Highlight extracted values"
            >
              <HighlightIcon fontSize="small" />
            </ToggleButton>
          </span>
        </Tooltip>

        {/* Pushes the file actions to the right edge, so the controls
            that change the view and the ones that leave it are visibly
            two groups rather than one long row. */}
        <Box sx={{ flexGrow: 1 }} />

        <Tooltip title="Download the original document">
          <span>
            <Button
              size="small"
              color="inherit"
              startIcon={
                isDownloading ? (
                  <CircularProgress size={14} color="inherit" />
                ) : (
                  <DownloadIcon />
                )
              }
              onClick={handleDownload}
              disabled={isDownloading}
              aria-busy={isDownloading}
            >
              {isDownloading ? 'Saving…' : 'Download'}
            </Button>
          </span>
        </Tooltip>

        {/* Always present, not only on failure: this viewer cannot
            detect every way a file can fail to render, and an escape
            hatch that appears only when we notice a problem is missing
            exactly when it is needed. */}
        <Tooltip title="Open the full document in a new tab">
          <Button
            size="small"
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

      <Paper
        ref={scrollRef}
        variant="outlined"
        sx={{
          // The same recessed surface the transcript uses: both are
          // source material the reviewer reads against, not the app's
          // own content, and they should read as the same kind of thing.
          bgcolor: 'sunken',
          flex: fill ? 1 : 'none',
          minHeight,
          maxHeight: fill ? 'none' : 620,
          overflow: 'auto',
          display: 'flex',
          // Centred while it fits; `flex-start` once it does not, which
          // is what keeps a zoomed page scrollable to its own edges
          // rather than clipped by the centring.
          alignItems: 'flex-start',
          justifyContent: 'center',
          p: `${VIEWPORT_PADDING / 2}px`,
        }}
      >
        {error ? (
          <Stack spacing={1.5} sx={{ alignItems: 'center', textAlign: 'center', p: 3, m: 'auto' }}>
            <BrokenImageIcon color="disabled" />
            <Typography variant="body2" color="text.secondary" sx={{ maxWidth: '44ch' }}>
              {error} The extracted fields beside this are unaffected.
            </Typography>
            <Button
              size="small"
              variant="outlined"
              startIcon={<OpenInNewIcon />}
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
            onLoad={(event) => {
              setImageSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
              setIsLoading(false)
            }}
            onError={() =>
              setError('The original file could not be loaded. It may have been removed.')
            }
            sx={{
              display: 'block',
              // Driven by width alone, with the height following: the
              // same rule the PDF renderer uses, so the zoom percentage
              // means the same thing for both kinds of file.
              width: imageSize ? imageSize.width * scale : 'auto',
              maxWidth: imageSize ? 'none' : '100%',
              height: 'auto',
              flexShrink: 0,
              bgcolor: '#fff',
              borderRadius: 1,
              boxShadow: 3,
            }}
          />
        ) : isLoading || !page ? (
          <Stack spacing={1.5} sx={{ alignItems: 'center', m: 'auto', p: 4 }}>
            <CircularProgress size={28} />
            <Typography variant="caption" color="text.secondary">
              Opening document…
            </Typography>
          </Stack>
        ) : (
          <PdfPageView
            page={page}
            scale={scale}
            terms={terms}
            highlightsEnabled={highlightsEnabled}
            onHighlightsChange={setHighlightCount}
            onTextAvailabilityChange={setHasTextLayer}
          />
        )}
      </Paper>

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ mt: 1, display: 'block', minHeight: 18 }}
      >
        {showsImage
          ? 'Scanned image'
          : pageCount > 0
            ? `PDF · ${pageCount} page${pageCount === 1 ? '' : 's'}`
            : 'PDF'}
        {canHighlight && highlightsEnabled
          ? ` · ${highlightCount} highlighted value${highlightCount === 1 ? '' : 's'} on this page`
          : ''}
      </Typography>
    </Box>
  )
}
