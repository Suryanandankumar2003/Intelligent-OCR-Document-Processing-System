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
 * Value labels sit above every bar rather than only on hover — some
 * palette slots fall below the 3:1 contrast floor against the chart
 * surface, and an always-visible label is exactly the "relief" the
 * dataviz skill requires when a color can't carry a value on its own.
 *
 * Still hand-drawn SVG rather than an MUI chart component: the hues come
 * from the `--chart-*` custom properties the theme publishes (see
 * theme/GlobalStyles.jsx), which is what keeps a document type the same
 * color here, on the type badges, and in both color modes.
 */
import { computeYAxis } from '../../utils/chartAxis'
import { useHoverTooltip } from '../../hooks/useHoverTooltip'
import EmptyState from '../common/EmptyState'
import BarChartIcon from '@mui/icons-material/BarChart'
import ChartCard from './ChartCard'
import ChartTooltip from './ChartTooltip'

const COLOR_BY_TYPE = {
  'PAN Card': 'var(--chart-pan)',
  'Aadhaar Card': 'var(--chart-aadhaar)',
  Invoice: 'var(--chart-invoice)',
  'Medical Prescription': 'var(--chart-prescription)',
  'Test Report Form': 'var(--chart-trf)',
  Unknown: 'var(--chart-unknown)',
}

const VIEW_WIDTH = 560
const VIEW_HEIGHT = 280
const MARGIN = { top: 28, right: 16, bottom: 44, left: 40 }
const MAX_BAR_WIDTH = 28

/** "Medical Prescription" -> ["Medical", "Prescription"], one word per `<tspan>` line, so a two-word category label doesn't overflow its band at this chart's width. */
function wordsOf(documentType) {
  return documentType.split(' ')
}

export default function DocumentsByTypeChart({ data }) {
  const { containerRef, tooltip, showTooltip, hideTooltip } = useHoverTooltip()

  if (data.length === 0) {
    return (
      <ChartCard title="Documents by type">
        <EmptyState
          dense
          icon={BarChartIcon}
          title="No documents yet"
          description="Once documents are processed, their type breakdown appears here."
        />
      </ChartCard>
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
    <ChartCard title="Documents by type" containerRef={containerRef}>
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
              <text
                x={-10}
                y={yFor(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                className="chart-svg__tick"
              >
                {tick.toLocaleString()}
              </text>
            </g>
          ))}
          <line x1={0} x2={0} y1={0} y2={plotHeight} stroke="var(--chart-axis)" strokeWidth={1} />
          <line
            x1={0}
            x2={plotWidth}
            y1={plotHeight}
            y2={plotHeight}
            stroke="var(--chart-axis)"
            strokeWidth={1}
          />

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
                  // Focusable so the reading is reachable without a
                  // pointer — the tooltip is the only place the exact
                  // count-per-type is given for a bar whose value label
                  // is rounded.
                  tabIndex={0}
                  onFocus={(event) => showTooltip(event, tooltipContent)}
                  onBlur={hideTooltip}
                />
                <text
                  x={bandStart + bandWidth / 2}
                  y={barY - 8}
                  textAnchor="middle"
                  className="chart-svg__value-label"
                >
                  {row.count.toLocaleString()}
                </text>
                <text
                  x={bandStart + bandWidth / 2}
                  y={plotHeight + 20}
                  textAnchor="middle"
                  className="chart-svg__category-label"
                >
                  {wordsOf(row.document_type).map((word, lineIndex) => (
                    <tspan
                      key={word}
                      x={bandStart + bandWidth / 2}
                      dy={lineIndex === 0 ? 0 : '1.1em'}
                    >
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
    </ChartCard>
  )
}
