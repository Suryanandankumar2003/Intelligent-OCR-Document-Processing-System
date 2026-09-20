/**
 * Thin wrappers around the FastAPI document endpoints (see
 * backend/api/routes/{upload,ocr,classification,extraction}.py).
 *
 * Each function does exactly one HTTP call and returns `response.data`
 * — no orchestration, no React state — so they can be called
 * independently or composed (as `useDocumentPipeline` does) without
 * either use case fighting the other. Every backend route this file
 * calls already validates its own input and returns a clean
 * `{ detail: "..." }` error body on failure (see backend/app.py's
 * exception handlers), so there is nothing to validate or reshape here.
 */
import apiClient from './client'
import { filenameFromContentDisposition } from '../utils/download'

/**
 * POST /upload — stores the file and returns its metadata (most
 * importantly, the server-generated `filename` every later call in the
 * pipeline needs).
 *
 * `onUploadProgress(percent)` is called repeatedly while the file body
 * streams to the server, driven by Axios's `onUploadProgress` event —
 * this is the actual mechanism behind the "display upload progress"
 * requirement; it reflects real bytes sent, not a simulated progress
 * bar.
 */
export async function uploadDocument(file, { onUploadProgress } = {}) {
  const formData = new FormData()
  formData.append('file', file)

  // No explicit Content-Type header here on purpose: letting the
  // browser set `multipart/form-data; boundary=...` itself is the only
  // way the boundary value is correct. Setting the header manually
  // (without the boundary) is a classic mistake that makes the backend
  // fail to parse the body at all.
  const response = await apiClient.post('/upload', formData, {
    onUploadProgress: (progressEvent) => {
      if (!onUploadProgress || !progressEvent.total) return
      const percent = Math.round((progressEvent.loaded / progressEvent.total) * 100)
      onUploadProgress(percent)
    },
  })
  return response.data
}

/**
 * GET /document-types — the document types field extraction actually
 * supports, for the manual-classification selector.
 *
 * Fetched rather than hardcoded so the options can't offer a type the
 * backend would then reject with a 422 — the whole failure this screen
 * exists to prevent. See backend/api/routes/document_types.py.
 */
export async function listExtractableDocumentTypes() {
  const response = await apiClient.get('/document-types')
  return response.data
}

/**
 * GET /documents — one page of stored document records, most recently
 * uploaded first (see backend/api/routes/documents.py).
 *
 * `limit` is capped at 500 by the backend, and the response is a bare
 * array with no total count, so a caller that wants "every document"
 * pages until it gets a short batch — that's what `useDocuments` does.
 */
export async function listDocuments({ skip = 0, limit = 100, documentType } = {}) {
  const response = await apiClient.get('/documents', {
    params: { skip, limit, ...(documentType ? { document_type: documentType } : {}) },
  })
  return response.data
}

/**
 * GET /documents/export/xlsx — the matching documents as one Excel
 * workbook, returned as `{ blob, filename }` for the caller to save.
 *
 * Every filter is optional and they compose, which is what lets this one
 * function serve all three of the export buttons: no arguments is
 * "everything", the list screen's active filters is "what I'm looking
 * at", and `{ reviewStatus: 'Reviewed' }` is "the approved set". The
 * `search` argument matches the same way the list's search box does —
 * filename plus current-best field values, case-insensitive — because
 * the backend deliberately mirrors `utils/documentRecords.js` there
 * (see backend/services/export_service.py's `iter_matching_search`).
 *
 * Two things here that no other call in this file needs:
 *
 *   * `responseType: 'blob'`. Without it Axios decodes the body as text
 *     (its default), which silently corrupts binary content — the file
 *     downloads, opens, and Excel reports it as damaged. This is the
 *     single most important line in the function.
 *   * the `Content-Disposition` filename. The backend names the export
 *     after its filters and the moment it ran
 *     (`documents_export_Reviewed_20240115T093000Z.xlsx`), which is only
 *     readable here because the API opts that header out of CORS's
 *     default header hiding (see backend/app.py's `expose_headers`); the
 *     fallback below covers the case where it doesn't arrive.
 *
 * Returning the blob rather than downloading it keeps this module what
 * every other function in it already is — one HTTP call, no side
 * effects — leaving the "save it to disk" step to `useDocumentExport`.
 */
export async function exportDocumentsXlsx({ documentType, reviewStatus, search } = {}) {
  const response = await apiClient.get('/documents/export/xlsx', {
    // Empty/absent filters are dropped rather than sent as empty
    // strings: `?document_type=` would fail the backend's enum
    // validation with a 422 instead of meaning "no filter".
    params: {
      ...(documentType ? { document_type: documentType } : {}),
      ...(reviewStatus ? { review_status: reviewStatus } : {}),
      ...(search?.trim() ? { search: search.trim() } : {}),
    },
    responseType: 'blob',
  })

  return {
    blob: response.data,
    filename: filenameFromContentDisposition(
      response.headers['content-disposition'],
      'documents_export.xlsx',
    ),
  }
}

/** POST /documents/{filename}/ocr — runs OCR (Vertex AI) on an already-uploaded file. */
export async function runOcr(filename) {
  const response = await apiClient.post(`/documents/${encodeURIComponent(filename)}/ocr`)
  return response.data
}

/** POST /documents/{filename}/classify — classifies the document's type from its OCR text. */
export async function classifyDocument(filename) {
  const response = await apiClient.post(`/documents/${encodeURIComponent(filename)}/classify`)
  return response.data
}

/**
 * POST /documents/{filename}/extract — extracts the structured field
 * set for `documentType` (PAN Card / Aadhaar Card / Invoice / Medical
 * Prescription). Passing the already-known type (from `classifyDocument`
 * above) as a query param skips the backend re-classifying the same
 * text a second time — see the `document_type` query parameter on
 * backend/api/routes/extraction.py.
 */
export async function extractFields(filename, documentType) {
  const response = await apiClient.post(
    `/documents/${encodeURIComponent(filename)}/extract`,
    null,
    {
      params: { document_type: documentType },
    },
  )
  return response.data
}

/**
 * GET /documents/{filename}/review — everything the review screen needs
 * for one document: the original extraction, the current (possibly
 * corrected) values, its review status, and the full correction history.
 *
 * The review screen loads from here rather than from whatever the
 * pipeline left in memory, so a document is reviewable on its own terms
 * — reopened after a page reload, or days after it was processed.
 */
export async function getDocumentReview(filename) {
  const response = await apiClient.get(`/documents/${encodeURIComponent(filename)}/review`)
  return response.data
}

/**
 * POST /documents/{filename}/review/decision — records a verdict on the
 * field set exactly as it stands, without changing any of it.
 *
 * The action `saveDocumentReview` below deliberately cannot express.
 * That endpoint is for corrections and rejects an empty body on purpose
 * (backend/schemas/review.py), which left the two most common review
 * outcomes — "the model got this right, sign it off" and "this
 * extraction is unusable" — with nowhere to go. `decision` is
 * `'approve'` or `'reject'`; both return the same full review shape
 * every other review call returns, so the screen re-renders through the
 * path it already uses.
 */
export async function submitReviewDecision(filename, decision) {
  const response = await apiClient.post(
    `/documents/${encodeURIComponent(filename)}/review/decision`,
    { decision },
  )
  return response.data
}

/**
 * PATCH /documents/{filename}/review — saves reviewer corrections.
 *
 * `correctedFields` is a partial object holding only the fields the
 * reviewer actually changed (`{ vendor_name: 'Acme Ltd' }`), not the
 * whole field set — that's what lets the backend record precisely what
 * was touched instead of guessing (see backend/schemas/review.py).
 *
 * Returns the saved state, which is not always what was sent: the
 * backend runs corrections through the same validators the AI's
 * extraction went through, so values come back normalized (a PAN number
 * upper-cased, surrounding whitespace gone).
 */
export async function saveDocumentReview(filename, correctedFields) {
  const response = await apiClient.patch(`/documents/${encodeURIComponent(filename)}/review`, {
    corrected_fields: correctedFields,
  })
  return response.data
}

/**
 * The absolute URL of a stored document's original file (see
 * backend/api/routes/documents.py's `get_document_file`).
 *
 * A URL rather than a request, for the same reason `batchStreamUrl` is:
 * the consumer is an `<img>` or an `<iframe>`, which fetches on its own
 * and cannot be handed an Axios response. Composing it from
 * `apiClient`'s baseURL is what keeps it pointing at the same backend as
 * every other call, including when `VITE_API_BASE_URL` overrides it —
 * a relative URL here would resolve against Vite's dev server instead.
 */
export function documentFileUrl(filename) {
  const base = apiClient.defaults.baseURL.replace(/\/$/, '')
  return `${base}/documents/${encodeURIComponent(filename)}/file`
}
