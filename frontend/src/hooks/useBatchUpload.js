/**
 * The bulk upload: the selected files, the transfer itself, and what
 * came back.
 *
 * The counterpart to `useDocumentPipeline`, and deliberately a much
 * smaller thing. That hook drives a four-stage chain from the browser
 * (upload -> OCR -> classify -> extract), because for one document the
 * browser is a perfectly good orchestrator. This one makes a single
 * request and stops: everything after it happens in a Celery worker, and
 * the browser's job ends at "the server has the files". Watching what
 * the worker then does is `useBatchProgress`'s job, on the details
 * screen, which is reachable long after this page has been closed.
 *
 * --- Upload progress is real ----------------------------------------
 *
 * `progress` is bytes actually sent, from Axios's `onUploadProgress`,
 * not a timer pretending to be one. It matters more here than anywhere
 * else in the app: 500 scans is minutes of transfer, and a bar that
 * moves on a schedule rather than on bytes would keep advancing through
 * a stalled connection.
 *
 * --- Cancellation ----------------------------------------------------
 *
 * An in-flight upload can be aborted, which no other upload in this app
 * offers, for the same reason: a one-file upload is over before a Cancel
 * button could be clicked, and a 500-file one is a commitment. Aborting
 * stops the browser sending; files the server already accepted are not
 * un-accepted, and nothing here pretends otherwise.
 */
import { useCallback, useRef, useState } from 'react'
import { uploadBatch } from '../api/batches'
import { extractErrorMessage } from '../api/errorMessage'

export const UPLOAD_STAGE = {
  IDLE: 'idle',
  UPLOADING: 'uploading',
  DONE: 'done',
  ERROR: 'error',
}

export function useBatchUpload() {
  const [stage, setStage] = useState(UPLOAD_STAGE.IDLE)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const abortRef = useRef(null)

  const run = useCallback(async (files, batchName) => {
    if (files.length === 0) return null

    const controller = new AbortController()
    abortRef.current = controller

    setStage(UPLOAD_STAGE.UPLOADING)
    setProgress(0)
    setError(null)
    setResult(null)

    try {
      const response = await uploadBatch(files, {
        batchName,
        onUploadProgress: setProgress,
        signal: controller.signal,
      })
      setResult(response)
      setStage(UPLOAD_STAGE.DONE)
      return response
    } catch (requestError) {
      // An abort is a user action, not a failure, and must not land in
      // the error banner as though something went wrong.
      if (controller.signal.aborted) {
        setStage(UPLOAD_STAGE.IDLE)
        setProgress(0)
        return null
      }
      setError(extractErrorMessage(requestError, 'Could not upload this batch.'))
      setStage(UPLOAD_STAGE.ERROR)
      return null
    } finally {
      abortRef.current = null
    }
  }, [])

  const cancel = useCallback(() => abortRef.current?.abort(), [])

  const reset = useCallback(() => {
    setStage(UPLOAD_STAGE.IDLE)
    setProgress(0)
    setResult(null)
    setError(null)
  }, [])

  return {
    stage,
    progress,
    result,
    error,
    isUploading: stage === UPLOAD_STAGE.UPLOADING,
    run,
    cancel,
    reset,
  }
}
