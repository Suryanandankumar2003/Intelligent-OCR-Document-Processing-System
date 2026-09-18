/**
 * The floating readout every chart shows on hover/focus. `tooltip` is
 * `{x, y, content}` from `useHoverTooltip`, or `null` to render nothing.
 *
 * `pointer-events: none` (in the CSS) so the tooltip itself never
 * intercepts the pointermove that's driving it — without that, a
 * tooltip appearing directly under the cursor would fire its own
 * mouseleave on the mark beneath it and flicker.
 */
import './ChartTooltip.css'

export default function ChartTooltip({ tooltip }) {
  if (!tooltip) return null
  return (
    <div className="chart-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
      {tooltip.content}
    </div>
  )
}
