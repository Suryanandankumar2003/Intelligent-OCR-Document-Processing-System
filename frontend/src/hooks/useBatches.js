/**
 * One page of the batch list, with its filters and a refresh.
 *
 * --- Why this pages on the server, where `useDocuments` does not -----
 *
 * `useDocuments` pulls the whole documents table into the browser and
 * filters it in memory, because that endpoint has no total count and no
 * server-side search, and the table is bounded by what one operator has
 * processed. None of that is true here. `GET /batches` returns a total
 * alongside the page, filters by status, and searches by name — and the
 * batch table grows without bound, a hundred files at a time. Loading it
 * all would be more code and worse behaviour.
 *
 * --- Auto-refresh ----------------------------------------------------
 *
 * A list containing a running batch refreshes itself on a timer. Only
 * that case: a list of finished batches is static, and polling it would
 * be a request every few seconds forever for an answer that cannot
 * change. The timer is also paused while the tab is hidden — a
 * background tab left open overnight would otherwise be thousands of
 * pointless requests, and the page refreshes on the way back anyway
 * (`visibilitychange` below).
 *
 * The list deliberately does *not* open an SSE stream per running batch.
 * Ten visible batches would be ten connections to watch numbers that a
 * single list read already returns; the stream is for the details page,
 * where there is exactly one batch and every tick matters.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { listBatches } from '../api/batches'
import { extractErrorMessage } from '../api/errorMessage'
import { isBatchActive } from '../utils/batchStatus'

const REFRESH_INTERVAL_MS = 4000

export function useBatches({ page, pageSize, status, search }) {
  const [data, setData] = useState({ batches: [], total: 0 })
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState(null)

  // Bumped by `reload()`, so a manual refresh re-runs the same load path
  // the effect already owns rather than being a second copy of it.
  const [reloadCount, setReloadCount] = useState(0)

  // Read by the auto-refresh timer without being a dependency of it.
  // Making the timer depend on the data would rebuild the interval on
  // every tick it caused — a timer that resets itself never fires
  // predictably.
  const hasActiveRef = useRef(false)

  const skip = (page - 1) * pageSize

  const load = useCallback(
    async ({ quiet } = {}) => {
      // The loader owns both flags, rather than the caller flipping one
      // before calling it. A background refresh keeps the table on
      // screen (`isRefreshing`); a foreground load is allowed to show
      // the skeleton.
      if (quiet) setIsRefreshing(true)
      else setIsLoading(true)
      try {
        const result = await listBatches({ skip, limit: pageSize, status, search })
        setData({ batches: result.batches, total: result.total })
        hasActiveRef.current = result.batches.some((batch) => isBatchActive(batch.status))
        setError(null)
      } catch (requestError) {
        // A failing *background* refresh keeps the rows already on screen
        // and says so; a failing foreground load has nothing to fall back
        // to and replaces the table with the message.
        setError(extractErrorMessage(requestError, 'Could not load your batches.'))
        if (!quiet) setData({ batches: [], total: 0 })
      } finally {
        setIsLoading(false)
        setIsRefreshing(false)
      }
    },
    [skip, pageSize, status, search],
  )

  // Fetching on mount and whenever the query changes: the effect
  // synchronises this hook with the backend, which is precisely the
  // case the rule exempts. The `setState` it flags is the loader's own
  // "I have started" flag, several frames before any response arrives.
  useEffect(() => {
    /* oxlint-disable-next-line react/set-state-in-effect */
    load()
  }, [load, reloadCount])

  // The auto-refresh. Reinstalled whenever the query changes, because a
  // timer closing over a stale `load` would keep refreshing the page the
  // user has navigated away from.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!hasActiveRef.current) return
      if (document.visibilityState !== 'visible') return
      load({ quiet: true })
    }, REFRESH_INTERVAL_MS)

    // Coming back to the tab refreshes immediately rather than waiting
    // out the interval: the numbers are as stale as the tab was hidden,
    // and that is the moment someone is looking at them.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && hasActiveRef.current) load({ quiet: true })
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  const reload = useCallback(() => setReloadCount((count) => count + 1), [])

  return {
    batches: data.batches,
    total: data.total,
    isLoading,
    isRefreshing,
    error,
    reload,
  }
}
