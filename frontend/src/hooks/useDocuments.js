/**
 * Loads every stored document record, for the documents list screen.
 *
 * --- Why it fetches all of them --------------------------------------
 *
 * `GET /documents` offers `skip`/`limit` and a document-type filter, but
 * no full-text search, no review-status filter, and — the deciding
 * detail — no total count. Server-side paging without a count can render
 * "Next" but never "page 3 of 7", and search/status filtering isn't
 * available there at all. So this hook pulls the whole table once (in
 * 500-row batches, the backend's per-request cap) and the page filters,
 * searches, and paginates over it in memory, where all three are exact.
 *
 * That is the right trade at this app's scale — a local SQLite database
 * holding the documents one operator has processed — and deliberately
 * not the right trade at 100k rows. The fix then is to push search,
 * status filtering, and a total count into the endpoint and switch this
 * hook to one request per page; the page component's props wouldn't have
 * to change.
 */
import { useCallback, useEffect, useState } from 'react'
import { listDocuments } from '../api/documents'
import { extractErrorMessage } from '../api/errorMessage'

const BATCH_SIZE = 500

async function fetchAllDocuments() {
  const all = []
  for (;;) {
    const batch = await listDocuments({ skip: all.length, limit: BATCH_SIZE })
    all.push(...batch)
    // A short batch means there was nothing left to return — the only
    // "you've reached the end" signal this endpoint gives.
    if (batch.length < BATCH_SIZE) return all
  }
}

export function useDocuments() {
  const [documents, setDocuments] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)
  // Bumped by `reload()`; the effect below depends on it, so a reload is
  // a re-run of the same load path rather than a second copy of it.
  const [reloadCount, setReloadCount] = useState(0)

  useEffect(() => {
    let ignore = false

    fetchAllDocuments()
      .then((data) => {
        if (!ignore) setDocuments(data)
      })
      .catch((requestError) => {
        if (!ignore) setError(extractErrorMessage(requestError, 'Could not load your documents.'))
      })
      .finally(() => {
        if (!ignore) setIsLoading(false)
      })

    return () => {
      ignore = true
    }
  }, [reloadCount])

  // The "loading" flip belongs here rather than at the top of the effect:
  // it's a reaction to the click that asked for a reload, and the initial
  // load needs no flip at all (both flags already start in that state).
  const reload = useCallback(() => {
    setIsLoading(true)
    setError(null)
    setReloadCount((count) => count + 1)
  }, [])

  return { documents, isLoading, error, reload }
}
