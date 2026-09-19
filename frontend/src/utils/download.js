/**
 * Turning a binary response into a file on the user's disk.
 *
 * Every other backend call in this app returns JSON that React renders,
 * so nothing before the xlsx export needed either of these. They live in
 * `utils/` rather than inside the export API call because neither knows
 * anything about documents or exports — a second binary endpoint later
 * (a PDF report, say) reuses both as-is.
 */

/**
 * The server-chosen filename out of a `Content-Disposition` header, or
 * `fallback` when the header is missing or unparseable.
 *
 * The header is missing more often than it looks: it's not on the
 * browser's CORS-safelist, so a cross-origin response only exposes it to
 * JavaScript if the server opts in (`expose_headers` in backend/app.py).
 * The fallback is what keeps a download working — under a less
 * descriptive name — if that ever stops being true, rather than saving
 * the file as "blob" or failing outright.
 *
 * Both spellings the RFCs allow are handled, `filename*` first because
 * RFC 6266 says it wins when a server sends both: it's the percent-
 * encoded form (`filename*=UTF-8''report%20%C3%A9.xlsx`) that can carry
 * non-ASCII, while plain `filename=` is the ASCII-only legacy form.
 * FastAPI/Starlette sends only the plain form for an ASCII name, which
 * is what our export always produces today — the `filename*` branch is
 * for the day a filter value puts a non-ASCII character in that name.
 */
export function filenameFromContentDisposition(header, fallback) {
  if (!header) return fallback

  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header)
  if (extended) {
    try {
      return decodeURIComponent(extended[2].trim())
    } catch {
      // A malformed percent-escape would throw here; fall through to
      // the plain `filename=` below rather than lose the download.
    }
  }

  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header)
  const name = (plain?.[1] ?? plain?.[2] ?? '').trim()
  return name || fallback
}

/**
 * Hands `blob` to the browser as a download named `filename`.
 *
 * There is no JS API for "save this data as a file", so the standard
 * approach is to synthesize the thing a browser *does* know how to
 * download — a link with a `download` attribute — and click it. The
 * anchor is never in the layout: it's appended (Firefox ignores a click
 * on a detached element), clicked, and removed in the same tick, so
 * nothing about it is ever visible.
 */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'

  document.body.appendChild(link)
  link.click()
  link.remove()

  // Not revoked synchronously: the click only *starts* the download, and
  // revoking the URL in the same tick can pull the data out from under a
  // browser that hasn't finished reading it. A timeout releases the
  // blob's memory (it would otherwise be held until the page unloads)
  // once the download is safely under way.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
