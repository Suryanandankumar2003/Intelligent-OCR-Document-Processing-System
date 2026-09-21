/**
 * One page of a PDF: the rasterized canvas, PDF.js's selectable text
 * layer on top of it, and the highlight boxes on top of that.
 *
 * --- One page, not all of them ---------------------------------------
 *
 * This component renders exactly the page it is given, and the viewer
 * above it mounts exactly one. That is the whole answer to "support
 * large PDFs": memory and render time are a function of the page being
 * looked at, not of how many pages the document has, so a 400-page file
 * opens as fast as a one-page one. A continuous-scroll viewer would be
 * nicer to use and would need virtualization to avoid rasterizing 400
 * pages into 400 canvases — a much larger piece of machinery for a
 * screen whose documents are overwhelmingly one to three pages.
 *
 * --- Three stacked layers --------------------------------------------
 *
 * The canvas is the picture. The text layer is PDF.js's invisible,
 * exactly-positioned copy of the page's text, which is what makes the
 * document selectable and searchable rather than a flat image. The
 * highlight layer is ours, and it is *separate* from the text layer
 * rather than wrapping its spans — see `highlightTerms.js:findMatches`
 * for why touching PDF.js's DOM is the wrong move.
 *
 * All three are absolutely positioned in one relative wrapper sized to
 * the viewport, so they cannot drift apart at any zoom.
 */
import { useEffect, useRef, useState } from 'react'
import { Box } from '@mui/material'
import { findMatches } from './highlightTerms'

export default function PdfPageView({
  page,
  scale,
  terms,
  highlightsEnabled,
  onHighlightsChange,
  onTextAvailabilityChange,
}) {
  const canvasRef = useRef(null)
  const textLayerRef = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [highlights, setHighlights] = useState([])

  // Rendering is asynchronous and re-triggered by zooming and by paging,
  // both of which a reviewer does faster than a page renders. Every
  // effect below therefore has to be able to abandon its own work when a
  // newer one starts — `cancelled` for our own bookkeeping, and PDF.js's
  // `RenderTask.cancel()` for the rasterization already in flight, which
  // would otherwise keep painting into a canvas that has moved on.
  useEffect(() => {
    if (!page) return undefined

    let cancelled = false
    let renderTask = null

    const viewport = page.getViewport({ scale })
    setSize({ width: viewport.width, height: viewport.height })

    const canvas = canvasRef.current
    if (!canvas) return undefined

    // The canvas is drawn at the device's real pixel density and then
    // scaled back down in CSS. Without this a PDF on a 2× display is
    // rasterized at half the resolution of everything around it, which
    // on a scanned document reads as the scan being blurry rather than
    // as the viewer being wrong — and the whole point of this pane is
    // judging whether a scanned character is a 5 or an S.
    const outputScale = window.devicePixelRatio || 1
    canvas.width = Math.floor(viewport.width * outputScale)
    canvas.height = Math.floor(viewport.height * outputScale)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`

    const context = canvas.getContext('2d')
    renderTask = page.render({
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    })

    renderTask.promise.catch((error) => {
      // A cancelled render is the expected outcome of zooming or paging,
      // not a failure — PDF.js signals it with a dedicated exception
      // name, and reporting it would put an error on screen every time
      // someone clicked the zoom button twice.
      if (!cancelled && error?.name !== 'RenderingCancelledException') {
        // eslint-disable-next-line no-console -- the viewer already shows a fallback; this is for diagnosis
        console.error('Could not render PDF page', error)
      }
    })

    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [page, scale])

  // The text layer is rebuilt alongside the canvas, because its span
  // positions are computed for one specific scale.
  useEffect(() => {
    if (!page) return undefined
    const container = textLayerRef.current
    if (!container) return undefined

    let cancelled = false
    const viewport = page.getViewport({ scale })

    container.replaceChildren()
    // PDF.js positions every span in units of this custom property
    // rather than in absolute pixels, so it has to be set on the
    // container or the whole layer collapses into the top-left corner.
    container.style.setProperty('--total-scale-factor', String(viewport.scale))

    ;(async () => {
      const { TextLayer } = await import('pdfjs-dist')
      if (cancelled) return

      const textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container,
        viewport,
      })
      await textLayer.render()
      if (cancelled) return

      // Whether this page has any text at all is not a detail — it is
      // the difference between "no extracted value appears on this page"
      // and "this page is a photograph and nothing can be matched on
      // it". The viewer says which, and can only do so because this
      // reports it.
      onTextAvailabilityChange?.(container.textContent.trim().length > 0)
      setHighlights(highlightsEnabled ? findMatches(container, terms) : [])
    })().catch((error) => {
      if (cancelled) return
      // eslint-disable-next-line no-console -- a missing text layer degrades to no highlights, which the UI reports
      console.error('Could not build the PDF text layer', error)
      onTextAvailabilityChange?.(false)
    })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `terms`/`highlightsEnabled` are handled by the effect below; rebuilding the text layer for them would re-parse the page for nothing
  }, [page, scale])

  // Toggling highlights, or arriving at a different field set, re-runs
  // only the search — the text layer it searches is already in the DOM
  // and costs nothing to reuse. Separating this from the effect above is
  // what keeps flipping the highlight switch instant rather than a
  // re-parse of the page.
  useEffect(() => {
    const container = textLayerRef.current
    if (!container || container.childElementCount === 0) return
    setHighlights(highlightsEnabled ? findMatches(container, terms) : [])
  }, [highlightsEnabled, terms])

  useEffect(() => {
    onHighlightsChange?.(highlights.length)
  }, [highlights, onHighlightsChange])

  return (
    <Box
      sx={{
        position: 'relative',
        width: size.width || 'auto',
        height: size.height || 'auto',
        // A white plate behind the page: a PDF with a transparent
        // background on a dark-mode surface renders as white text on
        // white, which looks like a failed render rather than a theme.
        bgcolor: '#fff',
        boxShadow: 3,
        borderRadius: 0.5,
        // `flex-shrink: 0` matters at zoom: the scroll container is a
        // flexbox, and without it a page wider than the pane is squashed
        // to fit instead of becoming scrollable — which is to say, zoom
        // would silently do nothing.
        flexShrink: 0,
      }}
    >
      <Box component="canvas" ref={canvasRef} sx={{ display: 'block', borderRadius: 0.5 }} />

      {/* PDF.js owns everything inside this node. The class name is what
          `theme/GlobalStyles.jsx` attaches the library's required layout
          rules to — without them every span stacks at the origin. */}
      <Box ref={textLayerRef} className="textLayer" aria-hidden={false} />

      {highlights.length > 0 && (
        <Box
          sx={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          aria-hidden="true"
        >
          {highlights.map((rect, index) => (
            <Box
              key={`${rect.term}-${index}`}
              sx={{
                position: 'absolute',
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                // Translucent and un-bordered, sitting *under* nothing:
                // the canvas text shows through it the way a marker pen
                // works on paper. A solid fill or an outline would
                // obscure or crowd the very characters the reviewer is
                // checking.
                bgcolor: 'warning.main',
                opacity: 0.32,
                borderRadius: '2px',
                mixBlendMode: 'multiply',
              }}
            />
          ))}
        </Box>
      )}
    </Box>
  )
}
