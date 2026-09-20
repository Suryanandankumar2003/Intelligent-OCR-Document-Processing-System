/**
 * Live progress for one batch: Server-Sent Events, with polling as a
 * fallback.
 *
 * This is the client half of `GET /batches/{id}/stream` (see
 * backend/api/routes/batches.py for why that endpoint is SSE rather
 * than WebSockets or polling).
 *
 * --- Why the fallback exists -----------------------------------------
 *
 * SSE fails in a specific and nasty way: a proxy that buffers responses
 * doesn't error, it just holds every frame until the stream ends. The
 * connection looks healthy and the progress bar silently stops moving,
 * which is worse than never having had a live feed — the operator can't
 * tell a stalled *page* from a stalled *batch*. So a dead stream demotes
 * itself to polling the same status endpoint the rest of the page uses,
 * and progress keeps moving at a slightly coarser grain.
 *
 * The demotion is deliberately one-way per mount. An `EventSource` that
 * reconnects into the same broken proxy would flap between the two
 * transports, and each flap costs a reconnect; once polling is working,
 * staying there until the page is reopened is the calmer answer.
 *
 * --- What it does not do ---------------------------------------------
 *
 * It does not own the batch. It reports the counters that change while a
 * batch runs — status, processed/successful/failed, percentage — and
 * nothing else. The batch's name, executor and file table come from
 * `useBatchDetail`, which is what `onComplete` exists to prod: the
 * stream can say "finished", but only a real read of `/batches/{id}`
 * and `/files` can say what each file ended up as.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { batchStreamUrl, getBatch } from '../api/batches'
import { isBatchActive } from '../utils/batchStatus'

/** How often the fallback re-reads the batch. Slower than the stream's 1s tick, because each one is a fresh HTTP request. */
const POLL_INTERVAL_MS = 2000

export const PROGRESS_TRANSPORT = {
  STREAM: 'stream',
  POLL: 'poll',
  IDLE: 'idle',
}

/**
 * @param batchId  the batch to watch, or `null`/`undefined` to watch nothing
 * @param options.enabled   false parks the hook without connecting (used while the batch is already finished)
 * @param options.onComplete called once when the batch reaches a terminal status
 */
export function useBatchProgress(batchId, { enabled = true, onComplete } = {}) {
  const [progress, setProgress] = useState(null)
  const [transport, setTransport] = useState(PROGRESS_TRANSPORT.IDLE)

  // Held in a ref, not in state, so that changing the callback a parent
  // passes (a new arrow function on every render, in practice) doesn't
  // tear down and rebuild the connection. This is the difference between
  // one stream per batch and one stream per render.
  const onCompleteRef = useRef(onComplete)
  // Synced in an effect rather than assigned during render: a
  // render-phase write to a ref is a side effect, and React makes no
  // promise about how many times a render runs. Running after every
  // render (no dependency array) is what keeps it current.
  useEffect(() => {
    onCompleteRef.current = onComplete
  })

  // Guards `onComplete` against firing twice — the stream sends a final
  // `progress` frame *and* a `complete` frame carrying the same payload,
  // and the poller can also observe the terminal status on its next tick.
  const hasCompletedRef = useRef(false)

  useEffect(() => {
    if (!batchId || !enabled) {
      // Genuine external-system synchronisation, not derived state: the
      // transport describes a *connection*, and this branch is the one
      // that has just decided not to open one. The same reasoning (and
      // the same suppression) as `FileSelect`'s object-URL effect.
      /* oxlint-disable-next-line react/set-state-in-effect */
      setTransport(PROGRESS_TRANSPORT.IDLE)
      return undefined
    }

    hasCompletedRef.current = false
    let source = null
    let pollTimer = null
    let cancelled = false

    const finish = (payload) => {
      if (hasCompletedRef.current) return
      hasCompletedRef.current = true
      onCompleteRef.current?.(payload)
    }

    /** The fallback: read the status endpoint on a timer until the batch is done. */
    const startPolling = () => {
      if (cancelled || pollTimer) return
      setTransport(PROGRESS_TRANSPORT.POLL)

      const tick = async () => {
        if (cancelled) return
        try {
          const detail = await getBatch(batchId)
          if (cancelled) return
          const batch = detail.batch
          setProgress({
            batch_id: batch.batch_id,
            status: batch.status,
            total_files: batch.total_files,
            processed_files: batch.processed_files,
            successful_files: batch.successful_files,
            failed_files: batch.failed_files,
            progress_percentage: batch.progress_percentage,
            is_final: !isBatchActive(batch.status),
          })
          if (!isBatchActive(batch.status)) {
            clearInterval(pollTimer)
            pollTimer = null
            finish(batch)
            return
          }
        } catch {
          // Swallowed on purpose. This is a background refresher, and a
          // single failed poll (the API restarting, a blip) is not worth
          // an error banner over a progress bar that is about to update
          // again in two seconds. A persistently dead API surfaces
          // through the page's own reads, which do report their errors.
        }
      }

      tick()
      pollTimer = setInterval(tick, POLL_INTERVAL_MS)
    }

    // `EventSource` doesn't exist in every environment this bundle might
    // run in (a test renderer, SSR). Falling back is cheaper than
    // guarding every use of it below.
    if (typeof EventSource === 'undefined') {
      startPolling()
      return () => {
        cancelled = true
        if (pollTimer) clearInterval(pollTimer)
      }
    }

    source = new EventSource(batchStreamUrl(batchId))
    setTransport(PROGRESS_TRANSPORT.STREAM)

    const readFrame = (event) => {
      try {
        return JSON.parse(event.data)
      } catch {
        return null
      }
    }

    source.addEventListener('progress', (event) => {
      const payload = readFrame(event)
      if (payload && !cancelled) setProgress(payload)
    })

    source.addEventListener('complete', (event) => {
      const payload = readFrame(event)
      if (cancelled) return
      if (payload) setProgress(payload)
      // Closed by us rather than left to the server: without this,
      // `EventSource` treats the server closing the stream as a dropped
      // connection and immediately reconnects, which would reopen a
      // stream for a finished batch every few seconds for as long as the
      // page stayed open.
      source.close()
      setTransport(PROGRESS_TRANSPORT.IDLE)
      finish(payload)
    })

    // The batch was deleted while being watched. Nothing left to show,
    // and reconnecting would only 404 in a loop.
    source.addEventListener('error', () => {
      source.close()
      if (!cancelled) startPolling()
    })

    // The 30-minute server-side cap. Reconnecting is the documented
    // behaviour, but a fresh stream costs a connection and this page has
    // demonstrably been open for half an hour, so polling from here is
    // the cheaper way to stay correct.
    source.addEventListener('timeout', () => {
      source.close()
      if (!cancelled) startPolling()
    })

    // `onerror` covers the transport failing rather than the server
    // reporting a problem: a proxy that refuses the stream, the API
    // going away. Either way the live feed is not going to work, so the
    // poller takes over.
    source.onerror = () => {
      // `CONNECTING` means EventSource is already retrying on its own,
      // which is the one case worth letting it handle: a brief network
      // blip recovers without changing transport.
      if (source.readyState === EventSource.CLOSED) {
        if (!cancelled) startPolling()
      }
    }

    return () => {
      cancelled = true
      source?.close()
      if (pollTimer) clearInterval(pollTimer)
    }
  }, [batchId, enabled])

  /** Lets a page seed the bar from a batch it has already loaded, so it renders full before the first frame arrives. */
  const seed = useCallback((batch) => {
    if (!batch) return
    setProgress((current) =>
      current ?? {
        batch_id: batch.batch_id,
        status: batch.status,
        total_files: batch.total_files,
        processed_files: batch.processed_files,
        successful_files: batch.successful_files,
        failed_files: batch.failed_files,
        progress_percentage: batch.progress_percentage,
        is_final: !isBatchActive(batch.status),
      },
    )
  }, [])

  return { progress, transport, seed }
}
