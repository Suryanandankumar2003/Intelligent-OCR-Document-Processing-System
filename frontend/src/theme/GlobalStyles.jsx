/**
 * The small amount of styling that can't live in `sx`: the SVG chart
 * internals.
 *
 * Everything else in this app is now styled through MUI, and the old
 * per-component `.css` files are gone. These rules survive because the
 * analytics charts are hand-drawn SVG, and SVG presentation attributes
 * (`stroke`, `fill` on a `<line>`, a `<text>` element's size) aren't
 * something `sx` on a React component can reach into. Rendering them as
 * CSS custom properties is what lets the chart components stay plain
 * SVG markup while still following the theme — including flipping to
 * the dark-mode chart palette, which they'd otherwise have no way to
 * know about.
 *
 * Emitted through MUI's `<GlobalStyles>` (not a static stylesheet) for
 * exactly that reason: this is a function of the theme, re-run whenever
 * the mode changes.
 */
import { GlobalStyles } from '@mui/material'
import { chartColors, MONO_FAMILY } from './theme'

export default function AppGlobalStyles() {
  return (
    <GlobalStyles
      styles={(theme) => {
        const chart = chartColors(theme.palette.mode)
        return {
          ':root': {
            // Consumed by the chart components' SVG attributes. One
            // fixed hue per document type, so a type is the same color
            // on every chart and in both modes.
            '--chart-pan': chart.pan,
            '--chart-aadhaar': chart.aadhaar,
            '--chart-invoice': chart.invoice,
            '--chart-prescription': chart.prescription,
            '--chart-trf': chart.trf,
            // "Not yet classified" is not a peer category, so it gets
            // the muted text tone rather than a sixth vivid hue.
            '--chart-unknown': theme.palette.text.secondary,
            '--chart-grid': chart.grid,
            '--chart-axis': chart.axis,
            '--color-surface': theme.palette.background.paper,
            '--color-primary': theme.palette.primary.main,
            '--color-success': theme.palette.success.main,
            // Added for the batch volume chart's failure series. Defined
            // here with the others so a failed file is the same red in a
            // chart, a status chip, and a progress bar.
            '--color-error': theme.palette.error.main,
            // The logs error-trend chart's second series. A warning is a
            // status, not a category, so it takes the theme's status
            // colour rather than a categorical slot — the same rule that
            // keeps `--color-error` out of the `--chart-*` family.
            '--color-warning': theme.palette.warning.main,
          },

          '.chart-svg': {
            width: '100%',
            height: 'auto',
            display: 'block',
            overflow: 'visible',
          },

          // `<text>` doesn't inherit font settings from a parent div the
          // way HTML does, so each class sets its own.
          '.chart-svg__tick, .chart-svg__category-label': {
            fontFamily: theme.typography.fontFamily,
            fontSize: 11,
            fill: theme.palette.text.secondary,
          },
          '.chart-svg__value-label': {
            fontFamily: theme.typography.fontFamily,
            fontSize: 11,
            fontWeight: 650,
            fill: theme.palette.text.primary,
          },

          '.chart-bar': {
            transition: 'opacity 120ms ease',
            cursor: 'default',
            outline: 'none',
          },
          '.chart-bar:hover': { opacity: 0.82 },
          // Keyboard focus has to be drawn explicitly: the bars are
          // focusable (`tabIndex={0}`) so the tooltip is reachable
          // without a pointer, and `outline` on an SVG shape is
          // unreliable across browsers.
          '.chart-bar:focus-visible': {
            stroke: theme.palette.text.primary,
            strokeWidth: 2,
          },

          '.chart-tooltip': {
            position: 'absolute',
            // Offset off the cursor so the pointer never covers the
            // reading, and `pointer-events: none` so the tooltip can't
            // intercept the pointermove that is driving it — without
            // that it fires its own mouseleave and flickers.
            transform: 'translate(12px, -50%)',
            pointerEvents: 'none',
            zIndex: 3,
            minWidth: 120,
            padding: '8px 10px',
            borderRadius: 8,
            border: `1px solid ${theme.palette.divider}`,
            background: theme.palette.background.paper,
            boxShadow: theme.shadows[6],
            fontFamily: theme.typography.fontFamily,
            fontSize: '0.75rem',
            color: theme.palette.text.primary,
            whiteSpace: 'nowrap',
          },
          '.chart-tooltip__title': {
            fontWeight: 650,
            marginBottom: 4,
            color: theme.palette.text.primary,
          },
          '.chart-tooltip__row': {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 2,
          },
          '.chart-tooltip__key': {
            width: 8,
            height: 8,
            borderRadius: 2,
            flexShrink: 0,
          },
          '.chart-tooltip__series': { color: theme.palette.text.secondary, marginRight: 'auto' },
          '.chart-tooltip__value': {
            // Tabular figures: a tooltip's numbers change as the pointer
            // moves, and proportional digits make the whole row shift
            // width on every step.
            fontFamily: MONO_FAMILY,
            fontWeight: 600,
            color: theme.palette.text.primary,
          },

          // --- PDF.js text layer -------------------------------------
          //
          // The invisible, exactly-positioned copy of a PDF page's text
          // that `components/viewer/PdfPageView.jsx` renders over the
          // canvas. It is what makes the document selectable and
          // searchable instead of a flat picture, and what the
          // highlight search reads.
          //
          // These rules are *required*, not decorative: PDF.js positions
          // every span with `left`/`top` and sizes it in units of
          // `--total-scale-factor`, and with no stylesheet at all the
          // whole layer collapses into a pile of visible black text in
          // the page's top-left corner.
          //
          // Written here rather than by importing `pdfjs-dist/web/pdf_viewer.css`
          // — that file is six thousand lines of full-viewer chrome
          // (toolbars, sidebars, the annotation editor) for the handful
          // of rules below, and it styles class names this app never
          // renders.
          '.textLayer': {
            position: 'absolute',
            inset: 0,
            overflow: 'clip',
            textAlign: 'initial',
            lineHeight: 1,
            letterSpacing: 'normal',
            wordSpacing: 'normal',
            textSizeAdjust: 'none',
            forcedColorAdjust: 'none',
            transformOrigin: '0 0',
            // The text is drawn transparently on top of the canvas that
            // already shows it, so a selection has to be visible some
            // other way — this is the caret, and `::selection` below is
            // the highlight.
            caretColor: 'CanvasText',
            zIndex: 0,
            '--min-font-size': 1,
            '--text-scale-factor': 'calc(var(--total-scale-factor) * var(--min-font-size))',
            '--min-font-size-inv': 'calc(1 / var(--min-font-size))',
          },
          '.textLayer span, .textLayer br': {
            color: 'transparent',
            position: 'absolute',
            whiteSpace: 'pre',
            cursor: 'text',
            transformOrigin: '0% 0%',
            userSelect: 'text',
          },
          // PDF.js writes the per-span metrics as custom properties and
          // expects the stylesheet to assemble them; these two selectors
          // are that assembly, and they are why a span ends up the right
          // size and at the right angle.
          '.textLayer > :not(.markedContent), .textLayer .markedContent span:not(.markedContent)': {
            zIndex: 1,
            '--font-height': 0,
            fontSize: 'calc(var(--text-scale-factor) * var(--font-height))',
            '--scale-x': 1,
            '--rotate': '0deg',
            transform:
              'rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))',
          },
          // A structural wrapper with no geometry of its own — it must
          // not introduce a box, or every span inside it is positioned
          // against the wrong origin.
          '.textLayer .markedContent': { display: 'contents' },
          '.textLayer ::selection': {
            // Tinted rather than the OS default, which on a white page
            // under transparent text renders as an opaque block that
            // hides the very characters being selected.
            background: `${theme.palette.primary.main}40`,
          },
        }
      }}
    />
  )
}
