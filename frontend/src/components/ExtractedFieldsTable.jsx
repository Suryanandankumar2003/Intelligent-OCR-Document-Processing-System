/**
 * Renders whichever field set the backend returned — PAN Card, Aadhaar
 * Card, Invoice, and Medical Prescription each have a different shape
 * (see backend/schemas/extraction.py) — generically, as label/value
 * rows, instead of four hardcoded layouts picked by document type.
 *
 * Extraction is only actually "generic" end to end if a future fifth
 * document type doesn't also require new frontend code — this
 * component makes no assumption about which keys are present, only
 * about how to render the two kinds of value it knows how to show: a
 * plain scalar (string or null) and a list (prescriptions' `medicines`).
 */
import { humanizeFieldName } from '../utils/fieldLabels'
import './ExtractedFieldsTable.css'

function renderValue(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="extracted-fields__missing">None found</span>
    return (
      <ul className="extracted-fields__medicine-list">
        {value.map((item, index) => (
          // eslint-disable-next-line react/no-array-index-key -- medicine names have no stable id of their own
          <li key={index}>{item}</li>
        ))}
      </ul>
    )
  }
  if (value === null || value === undefined || value === '') {
    return <span className="extracted-fields__missing">Not found</span>
  }
  return value
}

export default function ExtractedFieldsTable({ fields }) {
  const entries = Object.entries(fields ?? {})

  return (
    <div className="extracted-fields">
      <h3>Extracted Fields</h3>
      <dl className="extracted-fields__list">
        {entries.map(([key, value]) => (
          <div className="extracted-fields__row" key={key}>
            <dt className="extracted-fields__label">{humanizeFieldName(key)}</dt>
            <dd className="extracted-fields__value">{renderValue(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
