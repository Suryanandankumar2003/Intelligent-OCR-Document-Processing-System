/**
 * Helpers for reading a document record (`GET /documents`) the way the
 * rest of the system already agrees a document should be read.
 *
 * The one rule worth centralizing: "current best data" is
 * `reviewed_data ?? extracted_data`. The review API, the xlsx export, and
 * now the documents list all follow it, so a value a reviewer corrected
 * is the value everything downstream shows — including search, which
 * would otherwise keep matching text the reviewer has already fixed.
 */
import { humanizeFieldName } from './fieldLabels'

export function currentBestData(document) {
  return document.reviewed_data ?? document.extracted_data ?? null
}

/** True once extraction has produced a field set — i.e. once there is something to review. */
export function isReviewable(document) {
  return document.extracted_data !== null && document.extracted_data !== undefined
}

function isEmptyValue(value) {
  if (value === null || value === undefined) return true
  if (Array.isArray(value)) return value.length === 0
  return String(value).trim() === ''
}

function asText(value) {
  return Array.isArray(value) ? value.join('; ') : String(value)
}

/**
 * The first few populated fields, as `{ label, value }` pairs, for the
 * list's summary column.
 *
 * Stored filenames are generated hex (`4fb2bb81...pdf`), so without a
 * couple of real values — a patient name, an invoice number — a reviewer
 * cannot tell one row from another without opening it.
 */
export function summarizeFields(document, limit = 2) {
  const data = currentBestData(document)
  if (!data) return []
  return Object.entries(data)
    .filter(([, value]) => !isEmptyValue(value))
    .slice(0, limit)
    .map(([key, value]) => ({ label: humanizeFieldName(key), value: asText(value) }))
}

/**
 * Everything about a document that free-text search should match,
 * lowercased: its stored filename plus every current-best field value.
 *
 * Field *values* only, not keys — searching "name" should not return
 * every document that happens to have a name field.
 */
export function searchTextFor(document) {
  const data = currentBestData(document) ?? {}
  const values = Object.values(data)
    .filter((value) => !isEmptyValue(value))
    .map(asText)
  return [document.filename, ...values].join(' ').toLowerCase()
}
