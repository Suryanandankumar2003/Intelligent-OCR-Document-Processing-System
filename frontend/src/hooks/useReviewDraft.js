/**
 * The edit buffer behind the review screen's field form.
 *
 * This logic used to live inside `DocumentReviewForm`, which was fine
 * while the Save button was also inside that form. It isn't any more:
 * the screen now puts Save/Approve/Reject in a bar spanning the bottom
 * of both panes, and that bar has to know how many fields are edited and
 * what to send. Lifting the buffer into a hook is what lets the fields
 * pane and the action bar read the same state without one rendering the
 * other. The rules below are unchanged — only their address is.
 *
 * --- Three versions of each value -----------------------------------
 *
 * Correcting data means holding three things at once, and most of this
 * hook is about keeping them straight:
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
import { useCallback, useMemo, useState } from 'react'

export const EMPTY_DISPLAY = '— not found —'

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

export function formatForDisplay(value) {
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : EMPTY_DISPLAY
  if (value === null || value === undefined || value === '') return EMPTY_DISPLAY
  return value
}

function buildDraft(data) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, toDraftText(value)]))
}

export function useReviewDraft(originalData, reviewedData) {
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
          text: draft[name] ?? '',
          hasUnsavedEdit: !isSameValue(draftValue, reviewedData[name]),
          isCorrected: !isSameValue(reviewedData[name], originalData[name]),
          originalValue: originalData[name],
        }
      }),
    [draft, originalData, reviewedData],
  )

  const editedFields = useMemo(() => fields.filter((field) => field.hasUnsavedEdit), [fields])

  const setFieldText = useCallback((name, text) => {
    setDraft((previous) => ({ ...previous, [name]: text }))
  }, [])

  const discard = useCallback(() => setDraft(buildDraft(reviewedData)), [reviewedData])

  /** Exactly the fields the reviewer touched, in the shape the PATCH body takes. */
  const changedFields = useCallback(
    () => Object.fromEntries(editedFields.map((field) => [field.name, field.draftValue])),
    [editedFields],
  )

  return { fields, editedFields, setFieldText, discard, changedFields }
}
