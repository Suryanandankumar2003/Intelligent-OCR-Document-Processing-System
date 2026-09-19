/**
 * Runs an xlsx export and saves the result, with the loading and error
 * state the buttons that trigger it need.
 *
 * --- Why a hook and not just a click handler -------------------------
 *
 * An export is the one action on the documents screen with a real gap
 * between click and result: the backend walks the table, builds a
 * workbook, and streams it back, which on a large export is seconds, not
 * milliseconds. Without somewhere to hold "this is running", the button
 * looks inert for that whole time and gets clicked again — each click
 * costing another full table scan and another file. The `pendingExport`
 * key below is what closes that hole.
 *
 * --- Why a key instead of a boolean ----------------------------------
 *
 * The screen has two export buttons, and a single `isExporting` flag
 * would spin both of them for whichever one was pressed. `pendingExport`
 * holds the id of the export actually running (`'filtered'`,
 * `'approved'`), so the pressed button shows the spinner and the other
 * simply disables — which also communicates the real constraint, that
 * one export runs at a time.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { exportDocumentsXlsx } from '../api/documents'
import { extractBlobErrorMessage } from '../api/errorMessage'
import { saveBlob } from '../utils/download'

export function useDocumentExport() {
  const [pendingExport, setPendingExport] = useState(null)
  const [error, setError] = useState(null)

  // Mirrors `pendingExport` for the re-entrancy guard in `runExport`.
  // A ref, not the state value, because state updates are batched: two
  // clicks landing in the same tick both read the pre-click `null` and
  // both start an export, each costing a full table scan server-side. A
  // ref is written synchronously, so the second click sees the first.
  const pendingRef = useRef(null)

  // A download can outlive the screen that started it — navigating to a
  // review mid-export unmounts this hook while the request is still in
  // flight. React would warn about the state updates that follow, so
  // they're skipped once unmounted. The file itself still saves: that
  // happens through the browser, not through React state.
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  /**
   * `key` names which button asked (see above); `filters` is passed
   * straight through to `exportDocumentsXlsx`.
   *
   * Resolves to `{ ok, error }` rather than throwing, so a caller can
   * react to the outcome without a try/catch around every click. The
   * message is returned as well as stored: a caller that wants to raise
   * a snackbar needs it in the same tick, and the `error` state won't
   * have re-rendered yet at the moment the promise settles.
   */
  const runExport = useCallback(async (key, filters = {}) => {
    // Guarded here rather than only by the buttons' `disabled`: a
    // keyboard-repeated Enter can fire a second click before React has
    // re-rendered the first one's disabled state.
    if (pendingRef.current) return { ok: false, error: null }

    pendingRef.current = key
    setPendingExport(key)
    setError(null)

    try {
      const { blob, filename } = await exportDocumentsXlsx(filters)
      saveBlob(blob, filename)
      return { ok: true, error: null, filename }
    } catch (requestError) {
      // `await`ed, not `.then`ed: reading the error out of a Blob body
      // is asynchronous, and the message has to be in state before
      // `pendingExport` clears, or the buttons come back enabled for a
      // frame with no explanation of what went wrong.
      const message = await extractBlobErrorMessage(
        requestError,
        'Could not export your documents. Please try again.',
      )
      if (isMounted.current) setError(message)
      return { ok: false, error: message }
    } finally {
      // The ref clears unconditionally, the state only while mounted:
      // an unmounted hook must not setState, but a remounted one must
      // not inherit a stuck guard that refuses every later export.
      pendingRef.current = null
      if (isMounted.current) setPendingExport(null)
    }
  }, [])

  const dismissError = useCallback(() => setError(null), [])

  return { runExport, pendingExport, error, dismissError }
}
