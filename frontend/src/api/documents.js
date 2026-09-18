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
  const response = await apiClient.post(`/documents/${encodeURIComponent(filename)}/extract`, null, {
    params: { document_type: documentType },
  })
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
