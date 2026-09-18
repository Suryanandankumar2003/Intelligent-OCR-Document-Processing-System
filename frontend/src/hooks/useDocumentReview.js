/**
 * Owns the server side of the review screen: loading a document's
 * review state and saving corrections back to it.
 *
 * Same split as `useDocumentPipeline` — the hook holds the async state
 * machine, the page holds the JSX — but a separate hook rather than
 * more stages on that one, because reviewing isn't a step of the
 * upload pipeline. It's a thing you do to a document that was uploaded
 * at some point, possibly by someone else, possibly last week.
 *
 * The `review` object it exposes is whatever the backend last returned
 * (see backend/schemas/review.py: `original_data`, `reviewed_data`,
 * `review_status`, `reviewed_at`, `corrections`). Both endpoints return
 * that same shape, which is what lets a save be applied by simply
 * replacing the state — there is no client-side merging of a partial
 * response into the values already on screen, and so no way for the two
 * to drift apart.
 */
import { useCallback, useEffect, useState } from 'react'
import { getDocumentReview, saveDocumentReview } from '../api/documents'
import { extractErrorMessage } from '../api/errorMessage'

export function useDocumentReview(filename) {
  const [review, setReview] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    // Guards against a slow response landing after the screen is gone,
    // or after a newer request for a different document overtook it.
    let ignore = false

    getDocumentReview(filename)
      .then((data) => {
        if (!ignore) setReview(data)
      })
      .catch((requestError) => {
        if (!ignore) setError(extractErrorMessage(requestError, 'Could not load this document for review.'))
      })
      .finally(() => {
        if (!ignore) setIsLoading(false)
      })

    return () => {
      ignore = true
    }
    // `isLoading` starts true and is only ever turned off here, which
    // is correct as long as one instance of this hook loads one
    // document — App mounts the review screen keyed by filename, so a
    // different document is a fresh mount with fresh state rather than
    // a refetch into a hook that thinks it has already finished.
  }, [filename])

  /**
   * Saves `correctedFields` and returns whether it worked, so the form
   * can decide what to do next (show a confirmation, keep the user's
   * edits on screen to fix) without also having to watch this hook's
   * error state to find out.
   */
  const save = useCallback(
    async (correctedFields) => {
      setIsSaving(true)
      setError(null)
      try {
        setReview(await saveDocumentReview(filename, correctedFields))
        return true
      } catch (requestError) {
        setError(extractErrorMessage(requestError, 'Could not save your corrections.'))
        return false
      } finally {
        setIsSaving(false)
      }
    },
    [filename],
  )

  const dismissError = useCallback(() => setError(null), [])

  return { review, isLoading, isSaving, error, save, dismissError }
}
