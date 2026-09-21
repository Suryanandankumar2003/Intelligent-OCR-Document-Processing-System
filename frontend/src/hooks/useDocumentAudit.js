/**
 * Loads a document's audit history — every field a reviewer changed and
 * every decision they recorded, merged and newest first.
 *
 * --- Why it loads lazily ---------------------------------------------
 *
 * `enabled` gates the request, and the panel that uses this hook passes
 * `false` until it is expanded. The history is evidence to be consulted,
 * not the thing a reviewer is working on, and the review screen already
 * blocks its first paint on one request — adding a second for a panel
 * that starts collapsed would slow down every review to serve a minority
 * of them.
 *
 * --- Why it takes a refresh token ------------------------------------
 *
 * Because the history changes as a result of things happening on the
 * same screen. A save adds entries, a decision adds one, and a panel
 * that only fetched on expand would keep showing the state from before
 * the action the reviewer just took — which on an audit panel is worse
 * than showing nothing, because it looks like the action was not
 * recorded.
 *
 * `refreshToken` is whatever the caller has that changes when the
 * document's server state does; `useDocumentReview` replaces its
 * `review` object on every save and decision, so passing that object is
 * enough and no explicit invalidation call is needed.
 *
 * --- Why `isLoading` is derived --------------------------------------
 *
 * The result carries *what it is a result for* — which filename, which
 * token — and "loading" is simply "what I have is not what I was asked
 * for". Holding a flag in state instead would mean writing it
 * synchronously inside the effect, which starts a second render before
 * the request has even left, for a value that was already knowable
 * during the first one.
 */
import { useEffect, useState } from 'react'
import { getDocumentAudit } from '../api/documents'
import { extractErrorMessage } from '../api/errorMessage'

const NOTHING_LOADED = { audit: null, error: null, forFilename: null, forToken: null }

export function useDocumentAudit(filename, { enabled = true, refreshToken = null } = {}) {
  const [result, setResult] = useState(NOTHING_LOADED)

  useEffect(() => {
    if (!enabled || !filename) return undefined

    // Guards against a slow response landing after the panel is
    // collapsed, or after a newer request overtook it.
    let ignore = false

    getDocumentAudit(filename)
      .then((data) => {
        if (!ignore) setResult({ audit: data, error: null, forFilename: filename, forToken: refreshToken })
      })
      .catch((requestError) => {
        if (!ignore)
          setResult({
            // The previous entries stay on screen under the warning: a
            // failed refresh should not erase a history the reviewer
            // was in the middle of reading.
            audit: null,
            error: extractErrorMessage(requestError, 'Could not load the audit history.'),
            forFilename: filename,
            forToken: refreshToken,
          })
      })

    return () => {
      ignore = true
    }
  }, [filename, enabled, refreshToken])

  const isCurrent = result.forFilename === filename && result.forToken === refreshToken

  return {
    audit: isCurrent ? result.audit : null,
    isLoading: enabled && !isCurrent,
    error: isCurrent ? result.error : null,
  }
}
