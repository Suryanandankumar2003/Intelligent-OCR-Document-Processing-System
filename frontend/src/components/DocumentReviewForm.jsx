/**
 * The editable field set at the centre of the review screen: every
 * field the backend extracted, rendered as an input a reviewer can
 * correct, with the model's original value kept visible next to
 * anything that's been changed.
 *
 * Generic over field names, the same way the read-only table is: it
 * reads whatever keys the document's field set actually has rather than
 * hardcoding four layouts, so a fifth document type added to
 * backend/schemas/extraction.py becomes editable here for free. The only
 * distinction it draws is between a scalar (one input) and a list like a
 * prescription's `medicines` (a textarea, one entry per line).
 *
 * --- Three versions of each value -----------------------------------
 *
 * Correcting data means holding three things at once, and most of this
 * component is about keeping them straight:
 *
 *   1. `originalData[field]`  — what AI extraction produced. Never
 *      changes, and is shown beside any field that no longer matches it,
 *      so a reviewer can always see what they are overriding.
 *   2. `reviewedData[field]`  — what the server currently has stored.
 *      This is the baseline a save is diffed against.
 *   3. `draft[field]`         — what's in the input right now, as text.
 *
 * Only the fields where (3) differs from (2) are sent on save. That
 * keeps the backend's audit trail honest: it records the fields the
 * reviewer actually touched, rather than every field that happened to be
 * on screen.
 */
import { useMemo, useState } from 'react'
import { humanizeFieldName } from '../utils/fieldLabels'
import './DocumentReviewForm.css'

const EMPTY_DISPLAY = '— not found —'

/** Server value -> the string shown in an input. */
function toDraftText(value) {
  if (Array.isArray(value)) return value.join('\n')
  return value ?? ''
}

/** Input string -> the value the backend expects for that field. */
function fromDraftText(text, isList) {
  if (isList) {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  }
  const trimmed = text.trim()
  // Empty means "this field has no value", which the backend models as
  // null — not as an empty string, which would be a third way of
  // spelling "missing" that every consumer would then have to handle.
  return trimmed === '' ? null : trimmed
}

function isSameValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
  }
  return (left ?? null) === (right ?? null)
}

function formatForDisplay(value) {
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : EMPTY_DISPLAY
  if (value === null || value === undefined || value === '') return EMPTY_DISPLAY
  return value
}

function buildDraft(data) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, toDraftText(value)]))
}

export default function DocumentReviewForm({ originalData, reviewedData, isSaving, onSave }) {
  const [draft, setDraft] = useState(() => buildDraft(reviewedData))
  const [syncedTo, setSyncedTo] = useState(reviewedData)

  // Resynchronize the inputs when — and only when — the server hands
  // back a new stored state, so what's on screen after a save is what
  // was actually saved (the backend normalizes values on the way in;
  // typing "  abcde1234f " stores "ABCDE1234F").
  //
  // Done during render rather than in an effect on purpose: this is
  // React's documented way to reset state on a prop change, and it
  // avoids the render-then-immediately-render-again an effect would
  // cause, during which the old values would flash back on screen.
  if (syncedTo !== reviewedData) {
    setSyncedTo(reviewedData)
    setDraft(buildDraft(reviewedData))
  }

  const fields = useMemo(
    () =>
      Object.keys(reviewedData).map((name) => {
        const isList = Array.isArray(reviewedData[name]) || Array.isArray(originalData[name])
        const draftValue = fromDraftText(draft[name] ?? '', isList)
        return {
          name,
          isList,
          draftValue,
          hasUnsavedEdit: !isSameValue(draftValue, reviewedData[name]),
          isCorrected: !isSameValue(reviewedData[name], originalData[name]),
        }
      }),
    [draft, originalData, reviewedData],
  )

  const editedFields = fields.filter((field) => field.hasUnsavedEdit)

  const handleSubmit = (event) => {
    event.preventDefault()
    if (editedFields.length === 0 || isSaving) return
    onSave(Object.fromEntries(editedFields.map((field) => [field.name, field.draftValue])))
  }

  return (
    <form className="review-form" onSubmit={handleSubmit}>
      <div className="review-form__fields">
        {fields.map(({ name, isList, hasUnsavedEdit, isCorrected }) => {
          const inputId = `review-field-${name}`
          return (
            <div className="review-form__field" key={name}>
              <label className="review-form__label" htmlFor={inputId}>
                {humanizeFieldName(name)}
                {isCorrected && <span className="review-form__tag">Corrected</span>}
                {hasUnsavedEdit && <span className="review-form__tag review-form__tag--unsaved">Unsaved</span>}
              </label>

              {isList ? (
                <textarea
                  id={inputId}
                  className="review-form__input review-form__input--list"
                  rows={4}
                  value={draft[name] ?? ''}
                  placeholder="One per line"
                  disabled={isSaving}
                  onChange={(event) => setDraft((prev) => ({ ...prev, [name]: event.target.value }))}
                />
              ) : (
                <input
                  id={inputId}
                  type="text"
                  className="review-form__input"
                  value={draft[name] ?? ''}
                  placeholder={EMPTY_DISPLAY}
                  disabled={isSaving}
                  onChange={(event) => setDraft((prev) => ({ ...prev, [name]: event.target.value }))}
                />
              )}

              {isCorrected && (
                <p className="review-form__original">
                  Extracted value: <span>{formatForDisplay(originalData[name])}</span>
                </p>
              )}
            </div>
          )
        })}
      </div>

      <div className="review-form__actions">
        <button type="submit" className="review-form__save" disabled={editedFields.length === 0 || isSaving}>
          {isSaving ? 'Saving…' : 'Save corrections'}
        </button>
        <button
          type="button"
          className="review-form__discard"
          disabled={editedFields.length === 0 || isSaving}
          onClick={() => setDraft(buildDraft(reviewedData))}
        >
          Discard changes
        </button>
        <span className="review-form__status" role="status">
          {editedFields.length > 0
            ? `${editedFields.length} unsaved ${editedFields.length === 1 ? 'change' : 'changes'}`
            : 'No unsaved changes'}
        </span>
      </div>
    </form>
  )
}
