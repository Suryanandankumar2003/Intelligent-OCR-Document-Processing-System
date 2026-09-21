/**
 * Owns the Logs screen's list: one page of entries for the current
 * filters, sort and page number, plus a manual refresh.
 *
 * --- Why the request is driven by the URL, not by state --------------
 *
 * The screen holds every control in the query string (`useSearchParams`)
 * and this hook takes the resulting values as arguments. That is the
 * same choice `DocumentsPage` makes, and the reasons are the same
 * — a filtered view is a link you can share, a refresh does not dump you
 * back at page 1 of everything, and coming back from a log's detail page
 * lands on the page you left. It matters more here: the reason to send
 * someone a log link is almost always "look at this specific failure",
 * and a URL that does not carry the filters cannot express that.
 *
 * --- Why it keeps the previous page on screen ------------------------
 *
 * `isRefreshing` rather than clearing `data`. Paging through a log is a
 * rapid back-and-forth, and a table that blanks to a skeleton on every
 * page change makes the reader lose their place in a list whose whole
 * purpose is sequence. The first load still gets a skeleton, because
 * then there genuinely is nothing to show.
 *
 * --- The debounce ----------------------------------------------------
 *
 * `search` arrives from a text field, so the request is debounced. Not
 * doing so means one full query per keystroke against a table that is
 * the largest in the schema — and, worse, responses that can arrive out
 * of order, leaving the table showing results for a prefix of what is
 * in the box. The `ignore` flag below closes that second hole
 * regardless; the debounce is what stops the requests being made at all.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { listLogs } from '../api/logs'
import { extractErrorMessage } from '../api/errorMessage'

const SEARCH_DEBOUNCE_MS = 300

export function useLogs(query) {
  const [data, setData] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [reloadCount, setReloadCount] = useState(0)

  // Serialized, so the effect below re-runs when a filter's *value*
  // changes rather than whenever the caller happens to rebuild the
  // object it passes — which, since the screen derives it from
  // `useSearchParams` on every render, is every render.
  const queryKey = JSON.stringify(query)

  // Only the free-text box needs waiting on. Changing a dropdown or a
  // page is a deliberate, single action and should feel immediate;
  // debouncing those too would make the whole screen feel laggy to fix
  // a problem only one control has.
  const previousSearch = useRef(query.search)
  const searchChanged = previousSearch.current !== query.search
  previousSearch.current = query.search

  useEffect(() => {
    let ignore = false
    const parsed = JSON.parse(queryKey)

    const run = () => {
      setIsRefreshing(true)
      setError(null)
      listLogs(parsed)
        .then((payload) => {
          if (!ignore) setData(payload)
        })
        .catch((requestError) => {
          if (!ignore) setError(extractErrorMessage(requestError, 'Could not load the logs.'))
        })
        .finally(() => {
          if (!ignore) {
            setIsLoading(false)
            setIsRefreshing(false)
          }
        })
    }

    if (!searchChanged) {
      run()
      return () => {
        ignore = true
      }
    }

    const timer = setTimeout(run, SEARCH_DEBOUNCE_MS)
    return () => {
      ignore = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `searchChanged` is derived from this run's props and must not itself retrigger the effect
  }, [queryKey, reloadCount])

  const reload = useCallback(() => setReloadCount((count) => count + 1), [])

  return {
    logs: data?.logs ?? [],
    total: data?.total ?? 0,
    // `isLoading` is the *first* load only — it is turned off once and
    // never back on, so a later request is a refresh over content that
    // is already on screen rather than a return to the skeleton.
    isLoading,
    isRefreshing,
    error,
    reload,
  }
}
