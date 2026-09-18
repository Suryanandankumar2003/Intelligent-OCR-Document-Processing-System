/**
 * "Documents by type" — a categorical bar chart, one bar per document
 * type, most common first (the order the backend already returns them
 * in, see `database/analytics.py:documents_by_type`).
 *
 * No legend: each bar already carries its own category label directly
 * beneath it (the dataviz skill's legend rule is for a color that
 * identifies a *series* across many marks — a line, a stacked segment —
 * where nothing else on the mark says what it is; here color and label
 * are both already on every single bar, so a legend restating "blue =
 * PAN Card" under a bar already labeled "PAN Card" would be redundant).
 *
 * Value labels sit above every bar rather than only on hover — the
 * palette's aqua and yellow slots fall below the 3:1 contrast floor
 * against the chart surface (see `frontend/src/index.css`'s chart
 * palette comment), and an always-visible label is exactly the "relief"
 * the dataviz skill requires when a color can't carry a value on its
 * own.
 */
import { computeYAxis } from '../../utils/chartAxis'
import { useHoverTooltip } from '../../hooks/useHoverTooltip'
import ChartTooltip from './ChartTooltip'
import './DocumentsByTypeChart.css'

const COLOR_BY_TYPE = {
  'PAN Card': 'var(--chart-pan)',
  'Aadhaar Card': 'var(--chart-aadhaar)',
  Invoice: 'var(--chart-invoice)',
  'Medical Prescription': 'var(--chart-prescription)',
  Unknown: 'var(--chart-unknown)',
}

const VIEW_WIDTH = 560
const VIEW_HEIGHT = 280
const MARGIN = { top: 28, right: 16, bottom: 40, left: 40 }
const MAX_BAR_WIDTH = 24

export default function DocumentsByTypeChart({ data }) {
  const { containerRef, tooltip, showTooltip, hideTooltip } = useHoverTooltip()

  if (data.length === 0) {
    return (
      <div className="chart-card">
        <h3 className="chart-card__title">Documents by type</h3>
        <p className="chart-card__empty">No documents yet.</p>
      </div>
    )
  }

  const plotWidth = VIEW_WIDTH - MARGIN.left - MARGIN.right
  const plotHeight = VIEW_HEIGHT - MARGIN.top - MARGIN.bottom
  const maxCount = Math.max(...data.map((row) => row.count))
  const { max: axisMax, ticks } = computeYAxis(maxCount)

  const bandWidth = plotWidth / data.length
  const barWidth = Math.min(bandWidth * 0.55, MAX_BAR_WIDTH)

  const yFor = (count) => plotHeight - (count / axisMax) * plotHeight

  return (
    <div className="chart-card" ref={containerRef}>
      <h3 className="chart-card__title">Documents by type</h3>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="img"
        aria-label={`Bar chart of document counts by type: ${data
          .map((row) => `${row.document_type}, ${row.count}`)
          .join('; ')}`}
      >
        <g transform={`translate(${MARGIN.left}, ${MARGIN.top})`}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={0}
                x2={plotWidth}
                y1={yFor(tick)}
                y2={yFor(tick)}
                stroke="var(--chart-grid)"
                strokeWidth={1}
              />
              <text x={-10} y={yFor(tick)} textAnchor="end" dominantBaseline="middle" className="chart-svg__tick">
                {tick.toLocaleString()}
              </text>
            </g>
          ))}
          <line x1={0} x2={0} y1={0} y2={plotHeight} stroke="var(--chart-axis)" strokeWidth={1} />
          <line x1={0} x2={plotWidth} y1={plotHeight} y2={plotHeight} stroke="var(--chart-axis)" strokeWidth={1} />

          {data.map((row, index) => {
            const bandStart = index * bandWidth
            const barX = bandStart + (bandWidth - barWidth) / 2
            const barY = yFor(row.count)
            const barHeight = plotHeight - barY
            const color = COLOR_BY_TYPE[row.document_type] ?? 'var(--chart-unknown)'
            const tooltipContent = (
              <>
                <div className="chart-tooltip__title">{row.document_type}</div>
                <span className="chart-tooltip__value">{row.count.toLocaleString()}</span> document
                {row.count === 1 ? '' : 's'}
              </>
            )

            return (
              <g key={row.document_type}>
                <rect
                  x={barX}
                  y={barHeight === 0 ? plotHeight - 1 : barY}
                  width={barWidth}
                  height={Math.max(barHeight, 1)}
                  rx={4}
                  fill={color}
                  className="chart-bar"
                  onPointerMove={(event) => showTooltip(event, tooltipContent)}
                  onPointerLeave={hideTooltip}
                  tabIndex={0}
                  onFocus={(event) => showTooltip(event, tooltipContent)}
                  onBlur={hideTooltip}
                />
                <text x={bandStart + bandWidth / 2} y={barY - 8} textAnchor="middle" className="chart-svg__value-label">
                  {row.count.toLocaleString()}
                </text>
                <text x={bandStart + bandWidth / 2} y={plotHeight + 20} textAnchor="middle" className="chart-svg__category-label">
                  {wordsOf(row.document_type).map((word, lineIndex) => (
                    <tspan key={word} x={bandStart + bandWidth / 2} dy={lineIndex === 0 ? 0 : '1.1em'}>
                      {word}
                    </tspan>
                  ))}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
      <ChartTooltip tooltip={tooltip} />
    </div>
  )
}

/** "Medical Prescription" -> ["Medical", "Prescription"], one word per `<tspan>` line, so a two-word category label doesn't overflow its band at this chart's width. */
function wordsOf(documentType) {
  return documentType.split(' ')
}
