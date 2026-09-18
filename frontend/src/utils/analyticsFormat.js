/**
 * Number/duration/percentage formatting shared by every analytics
 * component — kept in one place so "average processing time" reads the
 * same way in a stat card, a tooltip, and a table cell.
 *
 * Every formatter passes `null`/`undefined` straight through as `null`
 * rather than rendering "0" or "NaN" — the backend's analytics schemas
 * use `null` specifically to mean "no data yet" (e.g. no extraction has
 * ever succeeded), which is a different fact from "zero", and collapsing
 * the two here would misreport it everywhere downstream.
 */

export function formatCount(value) {
  if (value === null || value === undefined) return null
  return value.toLocaleString()
}

export function formatPercent(fraction, digits = 1) {
  if (fraction === null || fraction === undefined) return null
  return `${(fraction * 100).toFixed(digits)}%`
}

/** Seconds (float) -> a compact human duration, e.g. "3.2s", "1m 12s", "2h 04m". */
export function formatDurationSeconds(seconds) {
  if (seconds === null || seconds === undefined) return null
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
  const totalSeconds = Math.round(seconds)
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const wholeSeconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  return `${minutes}m ${String(wholeSeconds).padStart(2, '0')}s`
}

/** Milliseconds (float) -> a compact duration, e.g. "320ms", "1.4s". */
export function formatDurationMs(ms) {
  if (ms === null || ms === undefined) return null
  if (ms < 1000) return `${Math.round(ms)}ms`
  return formatDurationSeconds(ms / 1000)
}

/** "2026-09-18" -> "Sep 18", for chart axis ticks and tooltips. */
export function formatShortDate(isoDate) {
  const date = new Date(`${isoDate}T00:00:00Z`)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}
