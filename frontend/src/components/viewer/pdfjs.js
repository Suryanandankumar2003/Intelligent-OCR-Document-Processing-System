/**
 * The one place PDF.js is configured, and the one place it is imported
 * from.
 *
 * --- Why the library is loaded at all --------------------------------
 *
 * The review screen used to show a PDF by pointing an `<iframe>` at the
 * file and letting the browser's built-in viewer handle it. That is a
 * genuinely good trade when all you need is "show me the document": it
 * costs nothing, and page navigation, text selection and printing come
 * for free.
 *
 * It stops being the right trade the moment the *application* needs to
 * drive the viewer. An iframe is opaque — its zoom cannot be read or
 * set, its current page cannot be asked for or changed, and its text
 * cannot be reached, which rules out highlighting an extracted value on
 * the page it came from. Those are four of the features this screen
 * exists to provide, so the viewer has to be ours.
 *
 * What it costs is honest: PDF.js is a large dependency, and it is
 * dynamically imported (see `loadPdfjs` below) so that cost falls on
 * the reviewer who opens a PDF rather than on every page load of the
 * app.
 *
 * --- The worker ------------------------------------------------------
 *
 * PDF.js parses and rasterizes on a Web Worker, which is not an
 * optimization to be traded away: parsing a large PDF on the main
 * thread freezes the entire UI, including the form the reviewer is
 * typing in beside it. `?url` asks Vite for the built worker file's
 * URL, so the worker is emitted as its own asset and versioned with the
 * bundle — hardcoding a CDN path would mean the viewer breaks offline,
 * which this project (a local Windows install) cannot accept.
 */

/**
 * The options every `getDocument` call in this app passes.
 *
 * PDF.js fetches four kinds of side file at runtime rather than
 * bundling them, and it only fetches them for a document that needs
 * one. Leaving these unset means those documents silently degrade:
 *
 *   * a scan compressed with JBIG2 or JPEG 2000 — the two formats
 *     scanners actually produce — renders as a blank page without
 *     `wasmUrl`;
 *   * a page using a Base-14 font falls back to whatever the browser
 *     guesses without `standardFontDataUrl`, which shifts the text
 *     layer the highlight boxes are measured against;
 *   * a CJK page renders as blanks without `cMapUrl`.
 *
 * The files are served from this app's own origin by the Vite plugin in
 * `vite.config.js`, never from a CDN: this project is a local Windows
 * install that has to work with no internet connection at all.
 */
export const PDF_ASSET_OPTIONS = {
  standardFontDataUrl: `${__PDFJS_ASSET_BASE__}/standard_fonts/`,
  cMapUrl: `${__PDFJS_ASSET_BASE__}/cmaps/`,
  cMapPacked: true,
  wasmUrl: `${__PDFJS_ASSET_BASE__}/wasm/`,
  iccUrl: `${__PDFJS_ASSET_BASE__}/iccs/`,
}

let pdfjsPromise = null

/**
 * The PDF.js module, loaded and configured once.
 *
 * Memoized on the promise rather than on the resolved module, so two
 * components mounting in the same tick share one download instead of
 * racing to start two.
 */
export function loadPdfjs() {
  if (pdfjsPromise === null) {
    pdfjsPromise = (async () => {
      const [pdfjs, workerUrl] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.mjs?url'),
      ])
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default
      return pdfjs
    })().catch((error) => {
      // Cleared on failure so a later attempt can retry. Leaving a
      // rejected promise memoized would make one transient chunk-load
      // error permanent for the life of the tab.
      pdfjsPromise = null
      throw error
    })
  }
  return pdfjsPromise
}

/** The zoom steps the viewer's +/- buttons walk through, as scale multipliers. */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]

/**
 * The step nearest `scale`, for handing control back to the +/- buttons
 * after a fit-to-width has set an arbitrary scale like 1.37.
 *
 * Without this, the first click of "zoom in" after a fit would jump to
 * whatever step the index happened to be left on, which from the
 * reviewer's side looks like the button doing something random.
 */
export function nearestZoomIndex(scale) {
  let best = 0
  for (let index = 1; index < ZOOM_STEPS.length; index += 1) {
    if (Math.abs(ZOOM_STEPS[index] - scale) < Math.abs(ZOOM_STEPS[best] - scale)) best = index
  }
  return best
}

/**
 * How far a PDF.js page must be scaled to fill `availableWidth`.
 *
 * `page.getViewport({ scale: 1 })` is the page at 72dpi, which is the
 * only fixed reference a PDF gives — a "page width" in pixels does not
 * exist until a scale is chosen. Clamped to the outer zoom range so a
 * very narrow pane cannot fit-to-width its way down to an unreadable
 * 0.1×, and a very wide one cannot blow a small page up past 4×.
 */
export function fitWidthScale(page, availableWidth) {
  const unscaled = page.getViewport({ scale: 1 })
  const raw = availableWidth / unscaled.width
  return Math.min(Math.max(raw, ZOOM_STEPS[0]), ZOOM_STEPS[ZOOM_STEPS.length - 1])
}
