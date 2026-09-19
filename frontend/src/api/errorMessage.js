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
 *
 * `extractBlobErrorMessage` at the bottom is the same unpacking for
 * binary downloads, where the body arrives as a Blob instead of parsed
 * JSON.
 */
function messageFromDetail(detail) {
  if (typeof detail === 'string' && detail) return detail

  if (Array.isArray(detail)) {
    const messages = detail.map((item) => item?.msg).filter(Boolean)
    if (messages.length > 0) return messages.join('; ')
  }

  return null
}

export function extractErrorMessage(error, fallback = 'Something went wrong.') {
  return messageFromDetail(error.response?.data?.detail) || error.message || fallback
}

/**
 * The same thing, for a request made with `responseType: 'blob'`.
 *
 * Axios honours `responseType` for *every* response, not just successful
 * ones, so a failing binary download hands back a `{ detail: "..." }`
 * body that has already been wrapped in a Blob. `error.response.data.detail`
 * on it is `undefined` — the JSON is real, it's just unparsed — which is
 * exactly how a perfectly clear backend error message turns into a
 * useless generic one. Reading the Blob's text and parsing it recovers
 * the message the backend actually sent.
 *
 * Async for the same reason: `Blob.text()` is a promise, and there is no
 * synchronous way to read one. Callers await it.
 */
export async function extractBlobErrorMessage(error, fallback = 'Something went wrong.') {
  const data = error.response?.data

  if (data instanceof Blob) {
    try {
      const message = messageFromDetail(JSON.parse(await data.text())?.detail)
      if (message) return message
    } catch {
      // Not JSON at all (an HTML error page from a proxy, an empty
      // body): nothing to recover, so fall through to the generic
      // handling below rather than surfacing a parse error the user
      // can do nothing with.
    }
  }

  return extractErrorMessage(error, fallback)
}
