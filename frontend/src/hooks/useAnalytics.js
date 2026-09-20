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
 * The two batch calls ride along with them. They are separate endpoints
 * on the backend (so an install that never batches doesn't pay for the
 * queries), but they are one dashboard to the person reading it, and
 * firing them together is what keeps every number on screen describing
 * the same moment. A failure of the batch half alone is tolerated: the
 * batch section simply doesn't render, rather than taking down the
 * document metrics that loaded perfectly well beside it.
 *
 * Refetches keep the previous render on screen (`isRefreshing`, not a
 * cleared `summary`/`trend`) rather than flashing back to a loading
 * state — the dataviz skill's interaction guidance calls this out
 * explicitly: a monitoring dashboard that blanks itself on every
 * refresh is worse than one that's a few seconds stale while the next
 * request is in flight.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  getAnalyticsSummary,
  getBatchAnalytics,
  getBatchVolume,
  getDailyTrend,
} from '../api/analytics'
import { extractErrorMessage } from '../api/errorMessage'

const DAY_RANGE_PRESETS = [7, 30, 90]
const DEFAULT_DAYS = 30

export function useAnalytics() {
  const [days, setDays] = useState(DEFAULT_DAYS)
  const [summary, setSummary] = useState(null)
  const [trend, setTrend] = useState(null)
  const [batchSummary, setBatchSummary] = useState(null)
  const [batchVolume, setBatchVolume] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async (forDays) => {
    setIsRefreshing(true)
    setError(null)
    try {
      // `allSettled`, not `all`: the two document calls are what this
      // screen is fundamentally for, and a batch endpoint failing (an
      // older backend, a migration mid-flight) must not blank the whole
      // dashboard. The two required results are checked below; the batch
      // pair degrades to "not shown".
      const [summaryResult, trendResult, batchResult, volumeResult] = await Promise.allSettled([
        getAnalyticsSummary(),
        getDailyTrend(forDays),
        getBatchAnalytics(),
        getBatchVolume(forDays),
      ])

      if (summaryResult.status === 'rejected') throw summaryResult.reason
      if (trendResult.status === 'rejected') throw trendResult.reason

      setSummary(summaryResult.value)
      setTrend(trendResult.value)
      setBatchSummary(batchResult.status === 'fulfilled' ? batchResult.value : null)
      setBatchVolume(volumeResult.status === 'fulfilled' ? volumeResult.value : null)
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
    batchSummary,
    batchVolume,
    days,
    dayRangePresets: DAY_RANGE_PRESETS,
    setDays,
    isLoading,
    isRefreshing,
    error,
    refresh: () => load(days),
  }
}
