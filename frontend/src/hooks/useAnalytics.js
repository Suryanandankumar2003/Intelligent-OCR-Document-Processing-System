/**
 * Owns the analytics dashboard's data: the summary (totals, by-type,
 * average processing time, per-stage success rates) and the daily trend
 * for a selectable day-range window, plus a manual refresh.
 *
 * Both requests are independent (see api/routes/analytics.py's docstring
 * on why the trend is its own endpoint rather than folded into the
 * summary) and are fired together on mount and on every refresh, but
 * changing `days` only re-fetches the trend — the summary numbers don't
 * depend on it.
 *
 * Refetches keep the previous render on screen (`isRefreshing`, not a
 * cleared `summary`/`trend`) rather than flashing back to a loading
 * state — the dataviz skill's interaction guidance calls this out
 * explicitly: a monitoring dashboard that blanks itself on every
 * refresh is worse than one that's a few seconds stale while the next
 * request is in flight.
 */
import { useCallback, useEffect, useState } from 'react'
import { getAnalyticsSummary, getDailyTrend } from '../api/analytics'
import { extractErrorMessage } from '../api/errorMessage'

const DAY_RANGE_PRESETS = [7, 30, 90]
const DEFAULT_DAYS = 30

export function useAnalytics() {
  const [days, setDays] = useState(DEFAULT_DAYS)
  const [summary, setSummary] = useState(null)
  const [trend, setTrend] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async (forDays) => {
    setIsRefreshing(true)
    setError(null)
    try {
      const [summaryResult, trendResult] = await Promise.all([getAnalyticsSummary(), getDailyTrend(forDays)])
      setSummary(summaryResult)
      setTrend(trendResult)
    } catch (requestError) {
      setError(extractErrorMessage(requestError, 'Could not load analytics.'))
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load(days)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` is stable (useCallback, no deps); re-running only on `days` is intentional
  }, [days])

  return {
    summary,
    trend,
    days,
    dayRangePresets: DAY_RANGE_PRESETS,
    setDays,
    isLoading,
    isRefreshing,
    error,
    refresh: () => load(days),
  }
}
