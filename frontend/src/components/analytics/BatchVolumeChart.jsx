/**
 * "Batch volume": files that succeeded vs. files that failed, one
 * stacked bar per day, with the number of batches created that day in
 * the tooltip.
 *
 * --- Why stacked, where the daily trend is lines --------------------
 *
 * Because the two series here are *parts of one whole*. Every file that
 * finished on a given day either succeeded or failed, so the stack's
 * total height is a real quantity — "files processed that day" — and
 * the split inside it is the thing worth looking at. The daily document
 * trend is two overlapping populations (uploaded, extracted) where one
 * is not a subset of the other in any given day's window, so stacking
 * those would draw a total that means nothing.
 *
 * Failures sit on top of successes rather than underneath, deliberately:
 * the failure count is usually small, and a small segment is far easier
 * to compare across days when every one of them starts from a common
 * edge than when it floats at a different height per bar.
 *
 * Hand-drawn SVG, like every other chart here, so the colors come from
 * the theme's published custom properties — a failed file is the same
 * red in this chart, on a status chip, and in a progress bar, in both
 * color modes.
 */
import { Box } from '@mui/material'
import BarChartIcon from '@mui/icons-material/BarChart'
import { computeYAxis } from '../../utils/chartAxis'
import { formatShortDate } from '../../utils/analyticsFormat'
import { useHoverTooltip } from '../../hooks/useHoverTooltip'
import EmptyState from '../common/EmptyState'
import ChartCard from './ChartCard'
import ChartTooltip from './ChartTooltip'

const VIEW_WIDTH = 640
const VIEW_HEIGHT = 260
const MARGIN = { top: 12, right: 16, bottom: 32, left: 44 }
const MAX_BAR_WIDTH = 22

const SERIES = [
  { key: 'files_succeeded', label: 'Succeeded', color: 'var(--color-success)' },
  { key: 'files_failed', label: 'Failed', color: 'var(--color-error)' },
]

export default function BatchVolumeChart({ data, days }) {
  const { containerRef, tooltip, showTooltip, hideTooltip } = useHoverTooltip()

  // An install that has batched before but not in this window still gets
  // a chart (of zeros); one that has never batched at all gets this.
  const hasAnyActivity = data.some(
    (point) => point.files_succeeded > 0 || point.files_failed > 0 || point.batches_created > 0,
  )

  if (!hasAnyActivity) {
    return (
      <ChartCard title="Batch volume">
        <EmptyState
          dense
          icon={BarChartIcon}
          title="No batch activity yet"
          description={`Nothing has been processed in a batch in the last ${days} days. Upload a batch and its daily volume appears here.`}
        />
      </ChartCard>
    )
  }

  const plotWidth = VIEW_WIDTH - MARGIN.left - MARGIN.right
  const plotHeight = VIEW_HEIGHT - MARGIN.top - MARGIN.bottom

  // The axis is scaled to the stack total, not to either series — the
  // tallest bar is the one that has to fit.
  const maxTotal = Math.max(
    1,
    ...data.map((point) => point.files_succeeded + point.files_failed),
  )
  const { max: axisMax, ticks } = computeYAxis(maxTotal)

  const bandWidth = plotWidth / Math.max(1, data.length)
  const barWidth = Math.min(MAX_BAR_WIDTH, bandWidth * 0.7)
  const xFor = (index) => index * bandWidth + (bandWidth - barWidth) / 2
  const heightFor = (value) => (value / axisMax) * plotHeight

  // Every nth day, so labels stay readable at a 90-day range.
  const labelEvery = Math.max(1, Math.ceil(data.length / 8))

  const handleHover = (event, point) => {
    showTooltip(
      event,
      <>
        <div className="chart-tooltip__title">{formatShortDate(point.date)}</div>
        {SERIES.map((series) => (
          <div className="chart-tooltip__row" key={series.key}>
            <span className="chart-tooltip__key" style={{ backgroundColor: series.color }} />
            <span className="chart-tooltip__series">{series.label}</span>
            <span className="chart-tooltip__value">{point[series.key].toLocaleString()}</span>
          </div>
        ))}
        <div className="chart-tooltip__row">
          <span className="chart-tooltip__series">Batches created</span>
          <span className="chart-tooltip__value">{point.batches_created.toLocaleString()}</span>
        </div>
      </>,
    )
  }

  return (
    <ChartCard title="Batch volume">
      {/* A legend is genuinely needed here: a stacked segment's color is
          its only identifier, unlike a bar chart whose categories are
          labelled on the axis beneath them. */}
      <Box sx={{ display: 'flex', gap: 2, mb: 1.5 }}>
        {SERIES.map((series) => (
          <Box key={series.key} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Box
              sx={{ width: 10, height: 10, borderRadius: 0.5, backgroundColor: series.color }}
            />
            <Box component="span" sx={{ typography: 'caption', color: 'text.secondary' }}>
              {series.label}
            </Box>
          </Box>
        ))}
      </Box>

      <Box ref={containerRef} sx={{ position: 'relative' }}>
        <svg
          className="chart-svg"
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          role="img"
          aria-label={`Stacked bar chart of batch files succeeded and failed per day over the last ${days} days`}
          onPointerLeave={hideTooltip}
        >
          <g transform={`translate(${MARGIN.left}, ${MARGIN.top})`}>
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={0}
                  x2={plotWidth}
                  y1={plotHeight - heightFor(tick)}
                  y2={plotHeight - heightFor(tick)}
                  stroke="var(--chart-grid)"
                  strokeWidth={1}
                />
                <text
                  x={-10}
                  y={plotHeight - heightFor(tick)}
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

            {data.map((point, index) => {
              const successHeight = heightFor(point.files_succeeded)
              const failedHeight = heightFor(point.files_failed)
              const x = xFor(index)
              return (
                <g
                  key={point.date}
                  onPointerMove={(event) => handleHover(event, point)}
                  tabIndex={0}
                  onFocus={(event) => handleHover(event, point)}
                  onBlur={hideTooltip}
                  role="img"
                  aria-label={`${formatShortDate(point.date)}: ${point.files_succeeded} succeeded, ${point.files_failed} failed`}
                >
                  {/* A transparent full-height target, so hovering
                      anywhere in the day's column works — including
                      above a short bar, and on a day with no bar at all. */}
                  <rect
                    x={index * bandWidth}
                    y={0}
                    width={bandWidth}
                    height={plotHeight}
                    fill="transparent"
                  />
                  <rect
                    className="chart-bar"
                    x={x}
                    y={plotHeight - successHeight}
                    width={barWidth}
                    height={successHeight}
                    fill="var(--color-success)"
                  />
                  <rect
                    className="chart-bar"
                    x={x}
                    y={plotHeight - successHeight - failedHeight}
                    width={barWidth}
                    height={failedHeight}
                    fill="var(--color-error)"
                  />
                </g>
              )
            })}

            {data.map(
              (point, index) =>
                index % labelEvery === 0 && (
                  <text
                    key={`label-${point.date}`}
                    x={index * bandWidth + bandWidth / 2}
                    y={plotHeight + 18}
                    textAnchor="middle"
                    className="chart-svg__category-label"
                  >
                    {formatShortDate(point.date)}
                  </text>
                ),
            )}
          </g>
        </svg>

        <ChartTooltip tooltip={tooltip} />
      </Box>
    </ChartCard>
  )
}
