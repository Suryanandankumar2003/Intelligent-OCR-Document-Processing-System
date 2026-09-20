/**
 * Thin wrappers around the FastAPI batch endpoints (see
 * backend/api/routes/batches.py).
 *
 * Same rule as src/api/documents.js: one HTTP call per function,
 * returning `response.data`, with no React state and no orchestration.
 * The backend already validates its own input and returns a readable
 * `{ detail: "..." }` on failure, so there is nothing to reshape here.
 *
 * Two things in this file are not like the document API:
 *
 *   * `uploadBatch` sends many parts under one field name (`files`) and
 *     carries its own timeout, because a 500-file request legitimately
 *     takes longer to *send* than any single-document call ever does.
 *   * `batchStreamUrl` returns a URL rather than making a request. The
 *     progress feed is Server-Sent Events, which the browser's
 *     `EventSource` opens itself — Axios cannot consume a stream that
 *     never ends. Building the URL here anyway keeps every batch
 *     endpoint's address in this one module.
 */
import apiClient from './client'

/**
 * POST /batches/upload — stores every accepted file, creates the batch,
 * and hands it to an executor. Returns as soon as that is done, never
 * when processing finishes.
 *
 * `onUploadProgress(percent)` reports real bytes sent, the same
 * mechanism `uploadDocument` uses. It matters far more here: uploading
 * 500 scans is minutes of transfer during which the only honest thing to
 * show is how much of it has left the machine.
 *
 * The response's `rejected` array is part of a *success*: a batch where
 * three files were the wrong type is a successful upload of the rest,
 * and the caller is expected to surface those three rather than treat
 * the whole thing as an error.
 */
export async function uploadBatch(files, { batchName, onUploadProgress, signal } = {}) {
  const formData = new FormData()
  // One repeated field name, which is what FastAPI's
  // `files: list[UploadFile]` binds to. `files[]` — the convention some
  // backends want — would arrive as a differently-named field and fail
  // validation with a 422.
  files.forEach((file) => formData.append('files', file))
  if (batchName?.trim()) formData.append('batch_name', batchName.trim())

  const response = await apiClient.post('/batches/upload', formData, {
    // Overrides the client's 120s default. That default is sized for one
    // Vertex AI call; this request is sized by how long it takes to push
    // hundreds of megabytes over the wire, and aborting a large upload
    // at the two-minute mark would make the headline feature — "upload
    // 500 files" — fail on exactly the batches it exists for.
    timeout: 30 * 60 * 1000,
    signal,
    onUploadProgress: (progressEvent) => {
      if (!onUploadProgress || !progressEvent.total) return
      onUploadProgress(Math.round((progressEvent.loaded / progressEvent.total) * 100))
    },
  })
  return response.data
}

/**
 * GET /batches — one page of batches, newest first, plus the total
 * matching the same filters.
 *
 * Paged, filtered and searched server-side, unlike `listDocuments`.
 * That difference follows the data and is deliberate on the backend's
 * side too: batches grow without bound and every filter here is an
 * indexed predicate, so there is nothing to gain by pulling the table
 * into the browser (see the route's docstring).
 */
export async function listBatches({ skip = 0, limit = 25, status, search } = {}) {
  const response = await apiClient.get('/batches', {
    // Empty filters are dropped rather than sent blank: `?status=` fails
    // the backend's enum validation with a 422 instead of meaning "any".
    params: {
      skip,
      limit,
      ...(status ? { status } : {}),
      ...(search?.trim() ? { search: search.trim() } : {}),
    },
  })
  return response.data
}

/** GET /batches/{id} — the batch, its per-status file counts, and whether a retry would do anything. */
export async function getBatch(batchId) {
  const response = await apiClient.get(`/batches/${encodeURIComponent(batchId)}`)
  return response.data
}

/** GET /batches/{id}/files — one page of the batch's files, filterable by status and filename. */
export async function listBatchFiles(batchId, { skip = 0, limit = 50, status, search } = {}) {
  const response = await apiClient.get(`/batches/${encodeURIComponent(batchId)}/files`, {
    params: {
      skip,
      limit,
      ...(status ? { status } : {}),
      ...(search?.trim() ? { search: search.trim() } : {}),
    },
  })
  return response.data
}

/** POST /batches/{id}/retry — re-queue every failed file that has retries left, plus any file stranded mid-processing. */
export async function retryBatch(batchId) {
  const response = await apiClient.post(`/batches/${encodeURIComponent(batchId)}/retry`)
  return response.data
}

/** POST /batches/{id}/files/{fileId}/retry — re-queue one file. */
export async function retryBatchFile(batchId, fileId) {
  const response = await apiClient.post(
    `/batches/${encodeURIComponent(batchId)}/files/${fileId}/retry`,
  )
  return response.data
}

/**
 * DELETE /batches/{id} — removes the batch record.
 *
 * The documents it produced are kept, on the backend's side, and the UI
 * says so before asking for confirmation: deleting a month-old batch to
 * tidy the list must not look like it might destroy the documents.
 */
export async function deleteBatch(batchId) {
  await apiClient.delete(`/batches/${encodeURIComponent(batchId)}`)
}

/**
 * The absolute URL of a batch's SSE progress feed.
 *
 * `EventSource` is a browser primitive that takes a URL and opens its
 * own connection, so it can't go through the Axios instance — and it
 * resolves relative URLs against the *page*, which in dev is Vite on
 * :5173, not the API on :8000. Composing it from `apiClient`'s baseURL
 * is what keeps the stream pointing at the same backend every other call
 * in this app uses, including when `VITE_API_BASE_URL` overrides it.
 */
export function batchStreamUrl(batchId) {
  const base = apiClient.defaults.baseURL.replace(/\/$/, '')
  return `${base}/batches/${encodeURIComponent(batchId)}/stream`
}
