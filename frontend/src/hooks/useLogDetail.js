/**
 * Loads one log entry plus the context the detail screen shows around
 * it: whether its document and batch still exist, and how many other
 * entries share them.
 *
 * A separate hook from `useLogs` rather than "find the row in the list
 * we already have", because the detail page is a real URL
 * (`/logs/:logId`) that is reachable without ever having visited the
 * list — from a bookmark, from a link someone sent, from a browser
 * refresh. A screen that could only render for an entry the list
 * happened to be holding would be a screen that breaks on reload, which
 * is exactly what giving it its own route was meant to avoid.
 */
import { useEffect, useState } from 'react'
import { getLogDetail } from '../api/logs'
import { extractErrorMessage } from '../api/errorMessage'

export function useLogDetail(logId) {
  const [result, setResult] = useState({ detail: null, error: null, forId: null })

  useEffect(() => {
    // Guards against a slow response landing after the screen is gone,
    // or after a newer request for a different entry overtook it.
    let ignore = false

    getLogDetail(logId)
      .then((payload) => {
        if (!ignore) setResult({ detail: payload, error: null, forId: logId })
      })
      .catch((requestError) => {
        if (!ignore)
          setResult({
            detail: null,
            error: extractErrorMessage(requestError, 'Could not load this log entry.'),
            forId: logId,
          })
      })

    return () => {
      ignore = true
    }
  }, [logId])

  return {
    detail: result.forId === logId ? result.detail : null,
    // Derived, not stored: a request is in flight exactly when the
    // result on hand is for a different entry than the one being asked
    // for. Holding it in state would mean writing a flag synchronously
    // inside the effect, which starts a second render for nothing.
    isLoading: result.forId !== logId,
    error: result.forId === logId ? result.error : null,
  }
}
