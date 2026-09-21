/**
 * The Logs dashboard's data: the five cards and the three trend series,
 * for a selectable day range.
 *
 * One request, not four, because the backend serves all of it from one
 * endpoint — and it does so because every number on that panel is
 * scoped by the *same* window. The document analytics dashboard splits
 * its summary from its trend precisely because its summary is not date-
 * scoped and re-fetching it every time someone widens the chart would be
 * waste; here there is no such asymmetry to exploit.
 *
 * A failure here is deliberately non-fatal to the screen around it: the
 * Logs page renders the analytics panel above a table that loads
 * separately, and an analytics query failing must not take the log list
 * down with it. The page reads `error` and hides the panel rather than
 * replacing the screen.
 */
import { useCallback, useEffect, useState } from 'react'
import { getLogAnalytics } from '../api/logs'
import { extractErrorMessage } from '../api/errorMessage'

const DAY_RANGE_PRESETS = [7, 30, 90]
const DEFAULT_DAYS = 30

export function useLogAnalytics({ enabled = true } = {}) {
  const [days, setDays] = useState(DEFAULT_DAYS)
  const [result, setResult] = useState({ analytics: null, error: null, settled: false })
  const [reloadCount, setReloadCount] = useState(0)

  useEffect(() => {
    if (!enabled) return undefined

    let ignore = false

    getLogAnalytics({ days })
      .then((payload) => {
        if (!ignore) setResult({ analytics: payload, error: null, settled: true })
      })
      .catch((requestError) => {
        if (!ignore)
          setResult((previous) => ({
            // The previous numbers are kept on screen behind the
            // warning. A dashboard that blanks itself because one
            // refresh failed is worse than one that is a few seconds
            // stale and says so.
            ...previous,
            error: extractErrorMessage(requestError, 'Could not load log analytics.'),
            settled: true,
          }))
      })

    return () => {
      ignore = true
    }
  }, [days, enabled, reloadCount])

  const refresh = useCallback(() => setReloadCount((count) => count + 1), [])

  return {
    analytics: result.analytics,
    days,
    dayRangePresets: DAY_RANGE_PRESETS,
    setDays,
    // Derived: the panel is loading while it is open and nothing has
    // come back yet. Deliberately *not* true for a later refresh — the
    // charts stay on screen and update in place, rather than flashing
    // back to skeletons every time the day range moves.
    isLoading: enabled && !result.settled,
    error: result.error,
    refresh,
  }
}
