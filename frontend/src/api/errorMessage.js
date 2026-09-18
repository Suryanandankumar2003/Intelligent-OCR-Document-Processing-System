/**
 * Turns an Axios error from this app's backend into one string a human
 * can read.
 *
 * Shared by every caller (the pipeline hook, the review hook) rather
 * than reimplemented per feature, because the shape it unpacks is a
 * property of the backend, not of any one screen: FastAPI puts a
 * `detail` key on every error response, and the custom exceptions in
 * backend/core/exceptions.py are already written as sentences meant to
 * be shown as-is (e.g. "File exceeds the maximum allowed size of 10
 * MB.").
 *
 * The `detail` key holds one of two different things, which is the
 * whole reason this needs a function rather than a `?.` chain:
 *
 *   * a plain string, for every exception the app raises itself;
 *   * an array of `{loc, msg, type}` objects, when FastAPI's own
 *     request-body validation rejects the request before any handler
 *     runs (a malformed review payload, say). Rendering that array
 *     straight into JSX would crash React with "Objects are not valid
 *     as a React child", so the messages are flattened out of it here.
 */
export function extractErrorMessage(error, fallback = 'Something went wrong.') {
  const detail = error.response?.data?.detail

  if (typeof detail === 'string' && detail) return detail

  if (Array.isArray(detail)) {
    const messages = detail.map((item) => item?.msg).filter(Boolean)
    if (messages.length > 0) return messages.join('; ')
  }

  return error.message || fallback
}
