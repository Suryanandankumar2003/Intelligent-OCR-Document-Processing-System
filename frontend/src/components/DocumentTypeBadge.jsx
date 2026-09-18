/**
 * Shows the classified document type as a colored pill, plus Vertex
 * AI's confidence as a percentage.
 *
 * `confidence` arrives from the backend as a decimal string like "0.93"
 * (see backend/schemas/classification.py — it's a string, not a float,
 * in the API contract on purpose). Parsing it into a percentage is a
 * pure display concern, so it happens here at the UI boundary rather
 * than asking the backend to pre-format a percentage string.
 */
import './DocumentTypeBadge.css'

const TYPE_STYLES = {
  'PAN Card': 'document-type-badge--pan',
  'Aadhaar Card': 'document-type-badge--aadhaar',
  Invoice: 'document-type-badge--invoice',
  'Medical Prescription': 'document-type-badge--prescription',
  Unknown: 'document-type-badge--unknown',
}

export default function DocumentTypeBadge({ documentType, confidence }) {
  const variant = TYPE_STYLES[documentType] ?? TYPE_STYLES.Unknown
  const confidencePercent = Number.parseFloat(confidence)
  const showConfidence = Number.isFinite(confidencePercent)

  return (
    <div className="document-type-badge-group">
      <span className={`document-type-badge ${variant}`}>{documentType}</span>
      {showConfidence && (
        <span className="document-type-badge__confidence">
          {Math.round(confidencePercent * 100)}% confidence
        </span>
      )}
    </div>
  )
}
