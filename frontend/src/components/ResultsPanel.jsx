/**
 * Composes the three result views once the pipeline finishes: the
 * classified document type (with confidence), the structured extracted
 * fields, and the raw OCR text — the "Show: OCR text, document type,
 * extracted fields" requirement, laid out together as one panel.
 *
 * A thin layout component on purpose — all the actual rendering logic
 * lives in its three children, so this file stays readable as "what
 * order do these three things appear in", not "how is any of them
 * rendered".
 */
import DocumentTypeBadge from './DocumentTypeBadge'
import OcrTextPanel from './OcrTextPanel'
import ExtractedFieldsTable from './ExtractedFieldsTable'
import './ResultsPanel.css'

export default function ResultsPanel({ documentType, confidence, ocrText, fields }) {
  return (
    <section className="results-panel">
      <header className="results-panel__header">
        <h2>2. Results</h2>
        <DocumentTypeBadge documentType={documentType} confidence={confidence} />
      </header>

      <div className="results-panel__grid">
        <ExtractedFieldsTable fields={fields} />
        <OcrTextPanel text={ocrText} />
      </div>
    </section>
  )
}
