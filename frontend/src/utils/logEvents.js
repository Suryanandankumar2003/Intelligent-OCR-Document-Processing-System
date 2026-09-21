/**
 * How a log entry reads: which colour its status takes, which colour its
 * category takes, and how its timestamp and duration are shown.
 *
 * Its own module because three screens need it — the list, the detail
 * page, and the analytics charts — and a status that is amber in a
 * table cell and red in a chart is the kind of inconsistency that makes
 * a reader stop trusting both.
 *
 * The literal strings below are the backend's enum *values*
 * (`core/log_events.py`), not its member names, because that is what
 * crosses the wire. They are duplicated here rather than fetched,
 * unlike the filter dropdowns' options: a colour is a presentation
 * decision this app owns, and an unrecognized value falls through to a
 * neutral default rather than breaking — so this map is allowed to lag
 * a new backend value by one deploy, where a dropdown is not.
 */

export const LOG_STATUS = {
  STARTED: 'Started',
  SUCCESS: 'Success',
  FAILURE: 'Failure',
  WARNING: 'Warning',
}

/**
 * The MUI palette colour for each status.
 *
 * `Started` is deliberately `info` rather than `default`: it is not the
 * absence of an outcome, it is a real state meaning "this began and has
 * not reported back", and a grey chip would read as a row that does not
 * matter — when a `Started` with no partner is exactly the row that
 * does.
 */
export const STATUS_COLOR = {
  [LOG_STATUS.STARTED]: 'info',
  [LOG_STATUS.SUCCESS]: 'success',
  [LOG_STATUS.FAILURE]: 'error',
  [LOG_STATUS.WARNING]: 'warning',
}

export function statusColor(status) {
  return STATUS_COLOR[status] ?? 'default'
}

/**
 * The CSS custom property each category is drawn in on the charts.
 *
 * Reuses the chart palette the theme already publishes
 * (`theme/GlobalStyles.jsx`) rather than introducing a second set of
 * hues, which is what keeps the Logs dashboard looking like the same
 * application as the Analytics one. There are twelve categories and
 * five palette slots, so slots repeat — acceptable here because the
 * distribution chart labels every bar, and colour is decoration on it
 * rather than the thing carrying the value.
 */
export const CATEGORY_COLOR = {
  Upload: 'var(--chart-pan)',
  OCR: 'var(--chart-invoice)',
  Classification: 'var(--chart-trf)',
  Extraction: 'var(--chart-aadhaar)',
  Review: 'var(--chart-prescription)',
  Approval: 'var(--color-success)',
  Rejection: 'var(--color-error)',
  Batch: 'var(--chart-pan)',
  Retry: 'var(--chart-trf)',
  Export: 'var(--chart-invoice)',
  Error: 'var(--color-error)',
  System: 'var(--chart-unknown)',
}

export function categoryColor(category) {
  return CATEGORY_COLOR[category] ?? 'var(--chart-unknown)'
}

/** A log timestamp as a full, unambiguous local date and time. */
export function formatLogTimestamp(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

/**
 * The same timestamp split into a date and a time, for a table cell
 * that shows both on two lines.
 *
 * Two lines rather than one, because a log table is scanned down the
 * timestamp column looking for *when* something happened relative to
 * the rows around it — and a single line of "18/09/2026, 14:32:07"
 * makes the seconds, which are the part that varies, the hardest part
 * to compare.
 */
export function splitLogTimestamp(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return { date: value, time: '' }
  return {
    date: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
    time: date.toLocaleTimeString(),
  }
}

/**
 * A `processing_time` (seconds, or `null`) as a compact duration.
 *
 * `null` passes through as `null` rather than becoming "0s", because
 * the backend uses it to mean "this row records a moment, not an
 * operation" — a `Started` row, or an approval. Rendering that as zero
 * would claim every approval took no time, which is true and
 * meaningless, and would drag the average-duration chart towards zero
 * if anything ever computed one from what the table displays.
 */
export function formatProcessingTime(seconds) {
  if (seconds === null || seconds === undefined) return null
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return `${minutes}m ${String(remainder).padStart(2, '0')}s`
}

/**
 * An ISO timestamp for `date_from` / `date_to` from a `<input
 * type="date">` value.
 *
 * `end=true` moves to the last instant of that day. Without it, "to 18
 * September" means midnight *at the start* of the 18th and silently
 * excludes everything that happened on the day the user just asked for
 * — the single most common date-range bug there is, and the one nobody
 * notices until a row they know exists is missing from an export.
 */
export function dayBoundaryIso(value, { end = false } = {}) {
  if (!value) return ''
  const date = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}`)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}
