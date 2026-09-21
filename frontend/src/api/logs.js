/**
 * Thin wrappers around the FastAPI logs endpoints (see
 * backend/api/routes/logs.py) — same "one HTTP call, no orchestration"
 * rule as src/api/documents.js.
 *
 * --- One filter object, three calls ----------------------------------
 *
 * `listLogs`, `getLogAnalytics` and `exportLogsXlsx` all take the same
 * filter shape and run it through the same `filterParams` below. That
 * mirrors the backend, where one `LogFilters` dependency serves the
 * list and the export, and it exists for the same reason: "export what
 * I'm looking at" is only true if both sides agree on what the filters
 * are, and two hand-written parameter objects are two things to keep in
 * step.
 *
 * Empty values are dropped rather than sent as empty strings, because
 * `?status=` fails the backend's enum validation with a 422 instead of
 * meaning "no filter" — the same trap `exportDocumentsXlsx` documents.
 */
import apiClient from './client'
import { filenameFromContentDisposition } from '../utils/download'

/** The non-empty subset of a filter object, in the query-parameter names the API uses. */
function filterParams({
  search,
  eventType,
  eventCategory,
  status,
  documentType,
  batchId,
  filename,
  dateFrom,
  dateTo,
} = {}) {
  return {
    ...(search?.trim() ? { search: search.trim() } : {}),
    ...(eventType ? { event_type: eventType } : {}),
    ...(eventCategory ? { event_category: eventCategory } : {}),
    ...(status ? { status } : {}),
    ...(documentType ? { document_type: documentType } : {}),
    ...(batchId ? { batch_id: batchId } : {}),
    ...(filename ? { filename } : {}),
    ...(dateFrom ? { date_from: dateFrom } : {}),
    ...(dateTo ? { date_to: dateTo } : {}),
  }
}

/**
 * GET /logs — one page of entries plus the total the filters matched.
 *
 * Paged, filtered and sorted on the server, unlike `listDocuments`,
 * which returns a page and lets the screen filter in memory. The
 * difference follows the data: this table grows by several rows per
 * file per batch and every filter it offers is an indexed predicate,
 * so there is nothing to gain by loading it into the browser and a
 * great deal to lose.
 */
export async function listLogs({ skip = 0, limit = 25, sortBy, sortDir, ...filters } = {}) {
  const response = await apiClient.get('/logs', {
    params: {
      skip,
      limit,
      ...(sortBy ? { sort_by: sortBy } : {}),
      ...(sortDir ? { sort_dir: sortDir } : {}),
      ...filterParams(filters),
    },
  })
  return response.data
}

/**
 * GET /logs/filters — the values every filter dropdown may offer.
 *
 * Fetched rather than hardcoded for the same reason
 * `listExtractableDocumentTypes` is: a dropdown built from a copy of a
 * backend enum eventually offers a value the backend no longer has, and
 * the empty table that follows looks like broken data rather than a
 * stale option list.
 */
export async function getLogFilterOptions() {
  const response = await apiClient.get('/logs/filters')
  return response.data
}

/** GET /logs/{logId} — one entry, with its related document and batch resolved. */
export async function getLogDetail(logId) {
  const response = await apiClient.get(`/logs/${encodeURIComponent(logId)}`)
  return response.data
}

/** GET /logs/analytics — the cards and the three trend series for the logs dashboard. */
export async function getLogAnalytics({ days = 30 } = {}) {
  const response = await apiClient.get('/logs/analytics', { params: { days } })
  return response.data
}

/**
 * GET /logs/export/xlsx — the matching entries as one workbook,
 * returned as `{ blob, filename }` for the caller to save.
 *
 * No arguments exports everything; the screen's current filters export
 * what is on screen; `{ status: 'Failure' }` exports the errors alone.
 * That is one endpoint serving every export button the screen offers,
 * which is the point — see the backend route's docstring.
 *
 * `responseType: 'blob'` is the single most important line here: without
 * it Axios decodes the body as text, which corrupts the workbook while
 * appearing to succeed, and Excel reports the downloaded file as
 * damaged.
 */
export async function exportLogsXlsx(filters = {}) {
  const response = await apiClient.get('/logs/export/xlsx', {
    params: filterParams(filters),
    responseType: 'blob',
  })
  return {
    blob: response.data,
    filename: filenameFromContentDisposition(
      response.headers['content-disposition'],
      'logs.xlsx',
    ),
  }
}
