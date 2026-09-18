/**
 * The audit trail: every correction saved for this document, oldest
 * first, as "extracted value -> corrected value" with a timestamp.
 *
 * Collapsed by default. The history is what makes the review auditable
 * rather than merely editable, but it is evidence to be consulted, not
 * the thing a reviewer is working on — the fields above are.
 *
 * Note the two values shown are the *original extraction* and the
 * correction, not "before and after this particular edit". A field
 * corrected three times produces three entries that all cite the same
 * original, because the question this answers is "how far has this
 * drifted from what the model read off the page", which is what the
 * backend anchors every record to (see backend/services/review_service.py).
 */
import { humanizeFieldName } from '../utils/fieldLabels'
import './CorrectionHistory.css'

const EMPTY_DISPLAY = '— not found —'

function formatValue(value) {
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : EMPTY_DISPLAY
  if (value === null || value === undefined || value === '') return EMPTY_DISPLAY
  return value
}

function formatTimestamp(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export default function CorrectionHistory({ corrections }) {
  if (corrections.length === 0) {
    return <p className="correction-history__empty">No corrections have been saved for this document.</p>
  }

  return (
    <details className="correction-history">
      <summary className="correction-history__summary">
        Correction history
        <span className="correction-history__count">{corrections.length}</span>
      </summary>

      <ol className="correction-history__list">
        {corrections.map((correction) => (
          <li className="correction-history__item" key={correction.id}>
            <div className="correction-history__field">{humanizeFieldName(correction.field_name)}</div>
            <div className="correction-history__change">
              <span className="correction-history__from">{formatValue(correction.original_value)}</span>
              <span className="correction-history__arrow" aria-label="corrected to">
                →
              </span>
              <span className="correction-history__to">{formatValue(correction.corrected_value)}</span>
            </div>
            <time className="correction-history__time" dateTime={correction.corrected_at}>
              {formatTimestamp(correction.corrected_at)}
            </time>
          </li>
        ))}
      </ol>
    </details>
  )
}
