/**
 * The floating readout every chart shows on hover/focus. `tooltip` is
 * `{x, y, content}` from `useHoverTooltip`, or `null` to render nothing.
 *
 * Positioned in plain CSS (`theme/GlobalStyles.jsx`, `.chart-tooltip`)
 * rather than with MUI's `<Popper>`: this follows the cursor across a
 * plot area on every pointermove, and a portalled popper recomputing its
 * placement at that rate is visibly laggy where absolute coordinates on
 * the chart's own container are not. `pointer-events: none` there is
 * what stops the tooltip from intercepting the very pointermove driving
 * it — without it, a tooltip under the cursor fires its own mouseleave
 * on the mark beneath and flickers.
 */

export default function ChartTooltip({ tooltip }) {
  if (!tooltip) return null
  return (
    <div className="chart-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
      {tooltip.content}
    </div>
  )
}
