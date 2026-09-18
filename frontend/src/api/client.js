/**
 * Single shared Axios instance for every backend call in this app.
 *
 * Centralizing this (instead of calling `axios.get(...)` directly from
 * components) means the base URL and timeout are configured in exactly
 * one place, and any future cross-cutting concern — an auth header, a
 * request/response interceptor for logging — has one obvious place to
 * live instead of being copy-pasted into every API call.
 */
import axios from 'axios'

// Vite only exposes env vars prefixed with VITE_ to client-side code
// (anything else in .env is invisible to the browser bundle, on
// purpose — it's the boundary between "safe to ship to the browser"
// and "server-only secret"). Falls back to the backend's default local
// port so `npm run dev` works out of the box without a .env file.
const baseURL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000/api/v1'

const apiClient = axios.create({
  baseURL,
  // Generous on purpose: the /ocr, /classify, and /extract endpoints
  // each make their own call to Vertex AI, which can legitimately take
  // several seconds — a short default timeout would abort a perfectly
  // healthy request on a large or multi-page document.
  timeout: 120_000,
})

export default apiClient
