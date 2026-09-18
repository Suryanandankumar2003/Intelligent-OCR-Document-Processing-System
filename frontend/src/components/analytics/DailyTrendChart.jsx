/**
 * "Documents uploaded" vs. "documents successfully extracted", one line
 * each, over the selected day range — the two counts share a single
 * y-axis (never a dual-axis chart, the dataviz skill's #1 chart
 * mistake to avoid: both series are the same unit, a document count,
 * so there's no reason to ever split them onto two scales).
 *
 * The day-range preset lives in this chart's own header rather than as
 * a page-level filter bar above the whole dashboard: it's the one
 * widget on this page that's actually date-scoped (the summary cards,
 * by-type chart, and stage table are all "as of right now" facts) — a
 * global-looking filter row that silently didn't affect three of the
 * four widgets beneath it would be more misleading than a control
 * that's visibly attached to the one chart it changes.
 */
import { useMemo } from 'react'
import { computeYAxis } from '../../utils/chartAxis'
import { formatShortDate } from '../../utils/analyticsFormat'
import { useHoverTooltip } from '../../hooks/useHoverTooltip'
import ChartTooltip from './ChartTooltip'
import './DailyTrendChart.css'

const VIEW_WIDTH = 640
const VIEW_HEIGHT = 260
const MARGIN = { top: 12, right: 16, bottom: 32, left: 40 }

const SERIES = [
  { key: 'documents_uploaded', label: 'Uploaded', color: 'var(--color-primary)' },
  { key: 'documents_extracted', label: 'Extracted', color: 'var(--color-success)' },
]

export default function DailyTrendChart({ data, days, dayRangePresets, onDaysChange }) {
  const { containerRef, tooltip, showTooltip, hideTooltip } = useHoverTooltip()

  const plotWidth = VIEW_WIDTH - MARGIN.left - MARGIN.right
  const plotHeight = VIEW_HEIGHT - MARGIN.top - MARGIN.bottom

  const maxValue = Math.max(1, ...data.flatMap((point) => SERIES.map((series) => point[series.key])))
  const { max: axisMax, ticks } = computeYAxis(maxValue)

  const xFor = (index) => (data.length <= 1 ? plotWidth / 2 : (index / (data.length - 1)) * plotWidth)
  const yFor = (value) => plotHeight - (value / axisMax) * plotHeight

  const linePaths = useMemo(
    () =>
      SERIES.map((series) => ({
        ...series,
        d: data.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(point[series.key])}`).join(' '),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- xFor/yFor are derived from data/axisMax each render; recomputing on those two is what actually matters
    [data, axisMax],
  )

  // Every 5th-ish day, so labels stay readable at a 90-day range instead of overlapping.
  const labelEvery = Math.max(1, Math.ceil(data.length / 8))

  const handlePointerMove = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const relativeX = event.clientX - bounds.left - MARGIN.left
    const index = Math.max(0, Math.min(data.length - 1, Math.round((relativeX / plotWidth) * (data.length - 1))))
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
    <div className="chart-card">
      <div className="chart-card__header">
        <h3 className="chart-card__title">Daily processing trend</h3>
        <div className="day-range-toggle" role="group" aria-label="Day range">
          {dayRangePresets.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`day-range-toggle__button${preset === days ? ' day-range-toggle__button--active' : ''}`}
              onClick={() => onDaysChange(preset)}
            >
              {preset}d
            </button>
          ))}
        </div>
      </div>

      <div className="chart-legend">
        {SERIES.map((series) => (
          <div className="chart-legend__item" key={series.key}>
            <span className="chart-legend__key" style={{ backgroundColor: series.color }} />
            {series.label}
          </div>
        ))}
      </div>

      <div ref={containerRef} style={{ position: 'relative' }}>
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
                <line x1={0} x2={plotWidth} y1={yFor(tick)} y2={yFor(tick)} stroke="var(--chart-grid)" strokeWidth={1} />
                <text x={-10} y={yFor(tick)} textAnchor="end" dominantBaseline="middle" className="chart-svg__tick">
                  {tick.toLocaleString()}
                </text>
              </g>
            ))}
            <line x1={0} x2={0} y1={0} y2={plotHeight} stroke="var(--chart-axis)" strokeWidth={1} />
            <line x1={0} x2={plotWidth} y1={plotHeight} y2={plotHeight} stroke="var(--chart-axis)" strokeWidth={1} />

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
              <path key={series.key} d={series.d} fill="none" stroke={series.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
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
      </div>
    </div>
  )
}
