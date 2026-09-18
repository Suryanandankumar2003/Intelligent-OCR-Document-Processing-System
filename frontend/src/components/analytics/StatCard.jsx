/**
 * One headline number — the dataviz skill's "stat tile" form: a
 * sentence-case label with no trailing colon, then the value in
 * semibold, proportional (not tabular) figures, since this is a large
 * standalone number, not a column that has to align with others.
 *
 * `value === null` renders "No data yet" instead of the value slot —
 * every metric here can legitimately have nothing to show (e.g.
 * average processing time before any extraction has ever succeeded),
 * and that's a different, calmer message than a stray "0" or "NaN"
 * would be.
 */
import './StatCard.css'

export default function StatCard({ label, value, hint }) {
  return (
    <div className="stat-card">
      <div className="stat-card__label">{label}</div>
      <div className="stat-card__value">{value ?? <span className="stat-card__no-data">No data yet</span>}</div>
      {hint && <div className="stat-card__hint">{hint}</div>}
    </div>
  )
}
