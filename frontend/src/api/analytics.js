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
