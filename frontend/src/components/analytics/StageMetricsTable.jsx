/**
 * Per-stage detail table: OCR, Classification, and Extraction, each
 * with its attempt/success/failure counts, success rate, and average
 * duration of a successful attempt — the full breakdown the stat cards
 * above only summarize two rows of (OCR and Extraction success rate).
 *
 * A table, not a third chart: this is exactly-three-rows of several
 * precise numbers per row, which a reader scans and compares cell by
 * cell — the case the dataviz skill's own form guidance defers to a
 * table for, rather than forcing it into bars or a grouped chart nobody
 * would read more precisely than the numbers themselves.
 */
import { formatDurationMs, formatPercent } from '../../utils/analyticsFormat'
import './StageMetricsTable.css'

function successRateTone(successRate) {
  if (successRate === null) return 'none'
  if (successRate >= 0.95) return 'good'
  if (successRate >= 0.8) return 'warning'
  return 'critical'
}

export default function StageMetricsTable({ stageMetrics }) {
  return (
    <div className="chart-card">
      <h3 className="chart-card__title">Pipeline stage detail</h3>
      <table className="stage-table">
        <thead>
          <tr>
            <th scope="col">Stage</th>
            <th scope="col">Attempts</th>
            <th scope="col">Successes</th>
            <th scope="col">Failures</th>
            <th scope="col">Success rate</th>
            <th scope="col">Avg. duration</th>
          </tr>
        </thead>
        <tbody>
          {stageMetrics.map((row) => (
            <tr key={row.stage}>
              <th scope="row">{row.stage}</th>
              <td className="stage-table__num">{row.attempts.toLocaleString()}</td>
              <td className="stage-table__num">{row.successes.toLocaleString()}</td>
              <td className="stage-table__num">{row.failures.toLocaleString()}</td>
              <td className="stage-table__num">
                {row.success_rate === null ? (
                  <span className="stage-table__no-data">No attempts yet</span>
                ) : (
                  <span className={`stage-table__rate stage-table__rate--${successRateTone(row.success_rate)}`}>
                    <span className="stage-table__rate-dot" aria-hidden="true" />
                    {formatPercent(row.success_rate)}
                  </span>
                )}
              </td>
              <td className="stage-table__num">
                {row.average_duration_ms === null ? (
                  <span className="stage-table__no-data">—</span>
                ) : (
                  formatDurationMs(row.average_duration_ms)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
