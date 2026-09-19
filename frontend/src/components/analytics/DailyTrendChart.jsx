/**
 * "Documents uploaded" vs. "documents successfully extracted", one line
 * each, over the selected day range — the two counts share a single
 * y-axis (never a dual-axis chart, the dataviz skill's #1 chart mistake
 * to avoid: both series are the same unit, a document count, so there's
 * no reason to ever split them onto two scales).
 *
 * The day-range toggle lives in this chart's own header rather than as a
 * page-level filter bar above the whole dashboard: it's the one widget
 * on this page that's actually date-scoped (the summary cards, by-type
 * chart, and stage table are all "as of right now" facts) — a
 * global-looking filter row that silently didn't affect three of the
 * four widgets beneath it would be more misleading than a control that's
 * visibly attached to the one chart it changes.
 */
import { useMemo } from 'react'
import { Box, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import { computeYAxis } from '../../utils/chartAxis'
import { formatShortDate } from '../../utils/analyticsFormat'
import { useHoverTooltip } from '../../hooks/useHoverTooltip'
import ChartCard from './ChartCard'
import ChartTooltip from './ChartTooltip'

const VIEW_WIDTH = 640
const VIEW_HEIGHT = 260
const MARGIN = { top: 12, right: 16, bottom: 32, left: 40 }

const SERIES = [
  { key: 'documents_uploaded', label: 'Uploaded', color: 'var(--color-primary)' },
  { key: 'documents_extracted', label: 'Extracted', color: 'var(--color-success)' },
]

/** The two-key legend. A line's color is its only identifier, so unlike the bar chart this one genuinely needs it. */
function Legend() {
  return (
    <Stack direction="row" spacing={2} sx={{ mb: 1.5 }}>
      {SERIES.map((series) => (
        <Stack direction="row" spacing={0.75} key={series.key} sx={{ alignItems: 'center' }}>
          <Box sx={{ width: 10, height: 10, borderRadius: 0.5, backgroundColor: series.color }} />
          <Typography variant="caption" color="text.secondary">
            {series.label}
          </Typography>
        </Stack>
      ))}
    </Stack>
  )
}

export default function DailyTrendChart({ data, days, dayRangePresets, onDaysChange }) {
  const { containerRef, tooltip, showTooltip, hideTooltip } = useHoverTooltip()

  const plotWidth = VIEW_WIDTH - MARGIN.left - MARGIN.right
  const plotHeight = VIEW_HEIGHT - MARGIN.top - MARGIN.bottom

  const maxValue = Math.max(
    1,
    ...data.flatMap((point) => SERIES.map((series) => point[series.key])),
  )
  const { max: axisMax, ticks } = computeYAxis(maxValue)

  const xFor = (index) =>
    data.length <= 1 ? plotWidth / 2 : (index / (data.length - 1)) * plotWidth
  const yFor = (value) => plotHeight - (value / axisMax) * plotHeight

  const linePaths = useMemo(
    () =>
      SERIES.map((series) => ({
        ...series,
        d: data
          .map(
            (point, index) =>
              `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(point[series.key])}`,
          )
          .join(' '),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- xFor/yFor are derived from data/axisMax each render; recomputing on those two is what actually matters
    [data, axisMax],
  )

  // Every 5th-ish day, so labels stay readable at a 90-day range instead of overlapping.
  const labelEvery = Math.max(1, Math.ceil(data.length / 8))

  const handlePointerMove = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const relativeX = event.clientX - bounds.left - MARGIN.left
    const index = Math.max(
      0,
      Math.min(data.length - 1, Math.round((relativeX / plotWidth) * (data.length - 1))),
    )
    const point = data[index]
    if (!point) return
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
      </>,
      { index },
    )
  }

  return (
    <ChartCard
      title="Daily processing trend"
      action={
        <ToggleButtonGroup
          exclusive
          size="small"
          value={days}
          // `exclusive` fires `null` when the active button is clicked
          // again; ignoring that keeps a range always selected rather
          // than letting the chart fall into a no-range state.
          onChange={(_event, next) => next && onDaysChange(next)}
          aria-label="Day range"
        >
          {dayRangePresets.map((preset) => (
            <ToggleButton key={preset} value={preset} sx={{ px: 1.5, py: 0.5 }}>
              {preset}d
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      }
    >
      <Legend />

      <Box ref={containerRef} sx={{ position: 'relative' }}>
        <svg
          className="chart-svg"
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          role="img"
          aria-label={`Line chart of documents uploaded and extracted per day over the last ${days} days`}
          onPointerMove={handlePointerMove}
          onPointerLeave={hideTooltip}
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

            {data.map(
              (point, index) =>
                index % labelEvery === 0 && (
                  <text
                    key={point.date}
                    x={xFor(index)}
                    y={plotHeight + 18}
                    textAnchor="middle"
                    className="chart-svg__category-label"
                  >
                    {formatShortDate(point.date)}
                  </text>
                ),
            )}

            {linePaths.map((series) => (
              <path
                key={series.key}
                d={series.d}
                fill="none"
                stroke={series.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}

            {tooltip && tooltip.index !== undefined && (
              <g>
                <line
                  x1={xFor(tooltip.index)}
                  x2={xFor(tooltip.index)}
                  y1={0}
                  y2={plotHeight}
                  stroke="var(--chart-axis)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
                {SERIES.map((series) => (
                  <circle
                    key={series.key}
                    cx={xFor(tooltip.index)}
                    cy={yFor(data[tooltip.index][series.key])}
                    r={4}
                    fill={series.color}
                    stroke="var(--color-surface)"
                    strokeWidth={2}
                  />
                ))}
              </g>
            )}

            {/* Transparent full-height hit area: bars/dots hover on the mark itself,
                but a line chart's mark is a 2px stroke nobody can reliably land a
                pointer on, so the hit target here is the whole plot area instead. */}
            <rect x={0} y={0} width={plotWidth} height={plotHeight} fill="transparent" />
          </g>
        </svg>
        <ChartTooltip tooltip={tooltip} />
      </Box>
    </ChartCard>
  )
}
