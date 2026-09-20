/**
 * Thin wrappers around the FastAPI analytics endpoints (see
 * backend/api/routes/analytics.py) — same "one HTTP call, no
 * orchestration" rule as src/api/documents.js.
 */
import apiClient from './client'

/** GET /analytics/summary — totals, by-type breakdown, average processing time, per-stage success rates. */
export async function getAnalyticsSummary() {
  const response = await apiClient.get('/analytics/summary')
  return response.data
}

/** GET /analytics/daily-trend — documents uploaded vs. successfully extracted, one point per day. */
export async function getDailyTrend(days) {
  const response = await apiClient.get('/analytics/daily-trend', { params: { days } })
  return response.data
}

/**
 * GET /analytics/batches — the batch half of the dashboard: totals by
 * status, file outcomes, success rate, and the two averages (files per
 * batch, and how long a batch takes end to end).
 *
 * Its own call rather than more fields on `/summary`, mirroring the
 * backend's own split: an install that has never run a batch shouldn't
 * pay for these queries on every dashboard load.
 */
export async function getBatchAnalytics() {
  const response = await apiClient.get('/analytics/batches')
  return response.data
}

/** GET /analytics/batch-volume — batches created and files completed, one point per day. */
export async function getBatchVolume(days) {
  const response = await apiClient.get('/analytics/batch-volume', { params: { days } })
  return response.data
}
