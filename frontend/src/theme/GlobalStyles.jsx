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
        }
      }}
    />
  )
}
