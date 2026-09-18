/**
 * Positioning logic for the small floating tooltip every chart on the
 * analytics dashboard shows on hover/focus (`components/analytics/ChartTooltip.jsx`).
 *
 * A chart calls `showTooltip(event, content)` from a mark's
 * `onPointerMove`/`onFocus` and `hideTooltip` from `onPointerLeave`/
 * `onBlur`; `containerRef` goes on the chart's outer `position: relative`
 * wrapper, which is what tooltip coordinates are measured against.
 */
import { useCallback, useRef, useState } from 'react'

export function useHoverTooltip() {
  const containerRef = useRef(null)
  const [tooltip, setTooltip] = useState(null)

  /**
   * `meta` is merged onto the tooltip object alongside `x`/`y`/`content`
   * — e.g. a line chart passes `{ index }` so it can also draw a
   * crosshair and per-series dots at the hovered position, not just
   * render the tooltip text.
   */
  const showTooltip = useCallback((event, content, meta) => {
    const bounds = containerRef.current?.getBoundingClientRect()
    if (!bounds) return
    setTooltip({ x: event.clientX - bounds.left, y: event.clientY - bounds.top, content, ...meta })
  }, [])

  const hideTooltip = useCallback(() => setTooltip(null), [])

  return { containerRef, tooltip, showTooltip, hideTooltip }
}
