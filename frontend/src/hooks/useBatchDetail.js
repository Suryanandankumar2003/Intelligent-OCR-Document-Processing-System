/**
 * Everything the batch details screen reads and does: the batch, its
 * file table, and the two retry actions.
 *
 * Two independent loads, deliberately kept apart:
 *
 *   * the **batch** (`GET /batches/{id}`) — name, counters, per-status
 *     file counts, whether a retry would do anything. Small, and needed
 *     in full whenever anything changes.
 *   * the **files** (`GET /batches/{id}/files`) — one page of up to 500
 *     rows, with its own filter, search and pagination.
 *
 * Folding them into one call would mean re-reading the file page every
 * time a counter ticked (once a second, during a 500-file run), and
 * re-reading the header every time someone turned a page. Separating
 * them is what lets the live progress bar update continuously while the
 * table underneath it stays still — which is what a person watching a
 * batch actually wants: the numbers move, the row they are reading does
 * not jump.
 *
 * Progress itself is not here. It comes from `useBatchProgress`, which
 * holds the SSE connection; this hook exposes `refresh` so that stream
 * can prod it when a batch finishes, and the page wires the two
 * together.
 */
import { useCallback, useEffect, useState } from 'react'
import { getBatch, listBatchFiles, retryBatch, retryBatchFile } from '../api/batches'
import { extractErrorMessage } from '../api/errorMessage'

export function useBatchDetail(batchId, { filePage, filePageSize, fileStatus, fileSearch }) {
  const [detail, setDetail] = useState(null)
  const [files, setFiles] = useState({ files: [], total: 0 })

  const [isLoading, setIsLoading] = useState(true)
  const [isFilesLoading, setIsFilesLoading] = useState(true)
  const [error, setError] = useState(null)
  const [actionError, setActionError] = useState(null)
  // Which retry is in flight: 'batch', a file id, or null. One piece of
  // state rather than a boolean plus an id, so the UI can never think
  // two different retries are running at once.
  const [pendingRetry, setPendingRetry] = useState(null)

  const fileSkip = (filePage - 1) * filePageSize

  const loadDetail = useCallback(async () => {
    if (!batchId) return
    setIsLoading(true)
    try {
      setDetail(await getBatch(batchId))
      setError(null)
    } catch (requestError) {
      setError(extractErrorMessage(requestError, 'Could not load this batch.'))
    } finally {
      setIsLoading(false)
    }
  }, [batchId])

  const loadFiles = useCallback(async () => {
    if (!batchId) return
    setIsFilesLoading(true)
    try {
      const result = await listBatchFiles(batchId, {
        skip: fileSkip,
        limit: filePageSize,
        status: fileStatus,
        search: fileSearch,
      })
      setFiles({ files: result.files, total: result.total })
    } catch (requestError) {
      setError(extractErrorMessage(requestError, 'Could not load this batch’s files.'))
    } finally {
      setIsFilesLoading(false)
    }
  }, [batchId, fileSkip, filePageSize, fileStatus, fileSearch])

  // Fetching on mount and whenever the query changes: the effect
  // synchronises this hook with the backend, which is precisely the
  // case the rule exempts. The `setState` it flags is the loader's own
  // "I have started" flag, several frames before any response arrives.
  useEffect(() => {
    /* oxlint-disable-next-line react/set-state-in-effect */
    loadDetail()
  }, [loadDetail])

  useEffect(() => {
    /* oxlint-disable-next-line react/set-state-in-effect */
    loadFiles()
  }, [loadFiles])

  /** Re-read both halves — after a retry, or when the progress stream reports the batch finished. */
  const refresh = useCallback(() => {
    loadDetail()
    loadFiles()
  }, [loadDetail, loadFiles])

  /**
   * Run a retry and re-read everything it could have changed.
   *
   * Returns `{ ok, message }` rather than throwing or notifying, so the
   * page owns the snackbar. The backend answers 409 when nothing
   * qualifies — every failed file has hit the retry cap, or there are no
   * failures — and that message is written to be shown as-is, which is
   * why it is surfaced rather than replaced with a generic one.
   */
  const runRetry = useCallback(
    async (key, request) => {
      setPendingRetry(key)
      setActionError(null)
      try {
        const result = await request()
        // Both halves: a retry resets file rows *and* moves the batch out
        // of its terminal status, so re-reading only one would leave the
        // page contradicting itself.
        await Promise.all([loadDetail(), loadFiles()])
        return { ok: true, message: result.message }
      } catch (requestError) {
        const message = extractErrorMessage(requestError, 'Could not retry.')
        setActionError(message)
        return { ok: false, message }
      } finally {
        setPendingRetry(null)
      }
    },
    [loadDetail, loadFiles],
  )

  const retryAll = useCallback(
    () => runRetry('batch', () => retryBatch(batchId)),
    [runRetry, batchId],
  )

  const retryOne = useCallback(
    (fileId) => runRetry(fileId, () => retryBatchFile(batchId, fileId)),
    [runRetry, batchId],
  )

  return {
    batch: detail?.batch ?? null,
    statusCounts: detail?.status_counts ?? {},
    retryableFileCount: detail?.retryable_file_count ?? 0,
    maxRetries: detail?.max_retries ?? 0,
    files: files.files,
    fileTotal: files.total,
    isLoading,
    isFilesLoading,
    error,
    actionError,
    dismissActionError: () => setActionError(null),
    pendingRetry,
    refresh,
    retryAll,
    retryOne,
  }
}
