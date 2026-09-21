/**
 * Runs a logs xlsx export and saves the result, with the loading and
 * error state the buttons that trigger it need.
 *
 * The same shape as `useDocumentExport`, and deliberately a second hook
 * rather than a generalization of it. The two differ in the one place a
 * shared version would have to be parameterized — which API call to make
 * — and folding them together would mean a hook that takes a function as
 * an argument to save twenty lines, in exchange for a reader of either
 * screen having to go somewhere else to find out what its export button
 * actually does.
 *
 * `pendingExport` holds the id of the export actually running rather
 * than a boolean, because this screen has three export buttons and one
 * flag would spin all three for whichever was pressed. It also
 * communicates the real constraint — one export at a time — by
 * disabling the others rather than queueing them.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { exportLogsXlsx } from '../api/logs'
import { extractBlobErrorMessage } from '../api/errorMessage'
import { saveBlob } from '../utils/download'

export function useLogExport() {
  const [pendingExport, setPendingExport] = useState(null)

  // Mirrors `pendingExport` for the re-entrancy guard below. A ref, not
  // the state value, because state updates are batched: two clicks
  // landing in the same tick would both read the pre-click `null` and
  // both start an export, each costing a full scan of the largest table
  // in the database.
  const pendingRef = useRef(null)

  // An export can outlive the screen that started it — navigating to a
  // log's detail page mid-export unmounts this hook while the request is
  // still in flight. React would warn about the state updates that
  // follow, so they are skipped once unmounted; the file still saves,
  // because that happens through the browser rather than through React.
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  /**
   * `key` names which button asked; `filters` is passed straight through
   * to `exportLogsXlsx`.
   *
   * Resolves to `{ ok, error, filename }` rather than throwing, so a
   * caller can react to the outcome without a try/catch around every
   * click. The message is returned as well as handled, because a caller
   * raising a snackbar needs it in the same tick and no state will have
   * re-rendered by the time the promise settles.
   */
  const runExport = useCallback(async (key, filters = {}) => {
    // Guarded here rather than only by the buttons' `disabled`: a
    // keyboard-repeated Enter can fire a second click before React has
    // re-rendered the first one's disabled state.
    if (pendingRef.current) return { ok: false, error: null }

    pendingRef.current = key
    setPendingExport(key)

    try {
      const { blob, filename } = await exportLogsXlsx(filters)
      saveBlob(blob, filename)
      return { ok: true, error: null, filename }
    } catch (requestError) {
      // `await`ed, not `.then`ed: reading an error out of a Blob body is
      // asynchronous, and the message has to be in hand before
      // `pendingExport` clears, or the buttons come back enabled for a
      // frame with no explanation of what went wrong.
      const message = await extractBlobErrorMessage(
        requestError,
        'Could not export the logs. Please try again.',
      )
      return { ok: false, error: message }
    } finally {
      // The ref clears unconditionally, the state only while mounted: an
      // unmounted hook must not setState, but a remounted one must not
      // inherit a stuck guard that refuses every later export.
      pendingRef.current = null
      if (isMounted.current) setPendingExport(null)
    }
  }, [])

  return { runExport, pendingExport }
}
