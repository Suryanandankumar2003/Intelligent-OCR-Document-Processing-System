/**
 * The values the Logs screen's filter dropdowns offer, from
 * `GET /logs/filters`.
 *
 * Fetched rather than hardcoded, and fetched from the *enums* rather
 * than derived from the rows on screen. Both halves of that matter:
 *
 *   * A copy of the backend's enums in the frontend drifts, and the
 *     symptom — a filter that returns nothing — looks like missing data
 *     rather than a stale option list.
 *   * Deriving the options from the loaded page would make them change
 *     as you filter, so narrowing to "Failure" would remove every other
 *     status from the dropdown you would need to un-narrow it. Worse, on
 *     a healthy system "Failure" would not be offered at all until
 *     something had failed.
 *
 * Failing to load is not fatal. The dropdowns fall back to empty, the
 * table still works, and the screen says nothing about it — losing the
 * filters is a degradation the reader can see for themselves, and an
 * error banner over a working log table would be the wrong emphasis.
 */
import { useEffect, useState } from 'react'
import { getLogFilterOptions } from '../api/logs'

const EMPTY = { event_types: [], event_categories: [], statuses: [], document_types: [] }

export function useLogFilterOptions() {
  const [options, setOptions] = useState(EMPTY)

  useEffect(() => {
    let ignore = false
    getLogFilterOptions()
      .then((payload) => {
        if (!ignore) setOptions(payload)
      })
      .catch(() => {
        // Deliberately silent — see the module docstring.
      })
    return () => {
      ignore = true
    }
  }, [])

  return options
}
