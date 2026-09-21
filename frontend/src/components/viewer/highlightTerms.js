/**
 * Turning a document's extracted fields into the strings worth finding
 * on the page, and finding them in a rendered PDF text layer.
 *
 * This is the "highlight extracted values when possible" half of the
 * review viewer, and the two words carrying the weight are *when
 * possible*. A highlight here is a text search over what PDF.js read
 * out of the page — it is not a bounding box the extraction model
 * returned, because the model does not return one: `schemas/extraction.py`
 * produces values, and the OCR stage produces a flat transcript with no
 * coordinates. So this finds a value again rather than being told where
 * it was, and everything below follows from that.
 *
 * The honest consequences, stated once here rather than discovered per
 * document:
 *
 *   * A scanned image has no text layer, so nothing can be highlighted
 *     on one. The viewer says so rather than silently highlighting
 *     nothing.
 *   * A value the model normalized (an upper-cased PAN, a date rewritten
 *     to ISO) no longer matches the characters on the page, so it will
 *     not be found. `variantsOf` below recovers the common cases; it
 *     cannot recover all of them.
 *   * A match is evidence, not proof. Highlighting "2024" would light up
 *     half an invoice, which is why short and low-information values are
 *     dropped rather than searched for.
 */

/**
 * Below this length a value matches too much to be useful. Three
 * characters finds "INV" inside "INVOICE", "Invoiced" and every
 * reference number on the page; at four the false-positive rate drops
 * sharply while every identifier this system extracts — PAN numbers,
 * Aadhaar numbers, invoice numbers, names — comfortably survives.
 */
const MIN_TERM_LENGTH = 4

/**
 * A value made only of digits and separators — a year, a date, an
 * amount, an Aadhaar number.
 *
 * These are held to a longer minimum than words are, because their
 * information content per character is lower and a short one matches
 * everywhere: "2026" appears in a date, a reference number and a page
 * footer on the same sheet, and a highlight landing in ten places has
 * told the reviewer nothing about the one place the value came from.
 *
 * They are emphatically *not* excluded, though. A 12-digit Aadhaar
 * number and an invoice total are among the values a reviewer most
 * wants to find on the page, and both are bare numbers.
 */
const IS_BARE_NUMBER = /^[\d\s.,-]+$/

/**
 * How many digits a bare number needs before it is worth searching for.
 *
 * Six is the point where a numeric string stops being ambient page
 * furniture: it excludes years, page numbers, quantities and two-part
 * dates, and includes every identifier and amount this system extracts.
 * A threshold, not a guarantee — a six-digit number that genuinely
 * appears twice will highlight twice, which is why the viewer reports a
 * match *count* rather than claiming to have found "the" value.
 */
const MIN_NUMERIC_DIGITS = 6

/** How many highlights one page will draw before giving up. See `findMatches`. */
const MAX_MATCHES_PER_PAGE = 300

/**
 * The strings worth searching for, for one value.
 *
 * A single value can legitimately appear on the page in more than one
 * shape, because extraction normalizes and the page does not. The two
 * recoveries here are the ones that actually occur:
 *
 *   * **Separators.** "ABCDE 1234 F" on the card becomes "ABCDE1234F" in
 *     the field, and an Aadhaar number is almost always printed in
 *     spaced groups. Searching the stripped form as well as the given
 *     one finds both without needing to know which field is which.
 *   * **Amounts.** "1,250.00" and "1250.00" are the same number printed
 *     two ways, and which one is on the page is not knowable from here.
 *
 * Returned longest-first so `findMatches` prefers the most specific
 * spelling when two variants overlap.
 */
export function variantsOf(value) {
  const text = String(value ?? '').trim()
  if (!text) return []

  const variants = new Set([text])
  const stripped = text.replace(/[\s-]+/g, '')
  if (stripped !== text) variants.add(stripped)
  const withoutThousands = text.replace(/,(?=\d{3}\b)/g, '')
  if (withoutThousands !== text) variants.add(withoutThousands)

  // The reverse of the line above, and the one that actually fires in
  // practice: extraction normalizes an amount to "12450.00" while the
  // page prints "12,450.00". Only applied to a plain integer-with-
  // optional-decimal string — anything carrying its own punctuation is
  // left alone rather than guessed at.
  if (/^\d{4,}(\.\d+)?$/.test(text)) {
    const [whole, fraction] = text.split('.')
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    variants.add(fraction === undefined ? grouped : `${grouped}.${fraction}`)
  }

  return [...variants]
    .filter((variant) =>
      IS_BARE_NUMBER.test(variant)
        ? // Digits counted, not characters: "12,450.00" is nine
          // characters but six digits, and it is the digits that make
          // it specific enough to be worth finding.
          variant.replace(/\D/g, '').length >= MIN_NUMERIC_DIGITS
        : variant.length >= MIN_TERM_LENGTH,
    )
    .sort((left, right) => right.length - left.length)
}

/**
 * Every searchable string in a document's field set, deduplicated.
 *
 * Takes the whole `reviewed_data`/`extracted_data` object rather than a
 * list of values so that a list-valued field (a prescription's
 * `medicines`) contributes each entry separately — searching for the
 * joined string would find nothing, since the page never contains the
 * joiner.
 *
 * Sorted longest-first for the same reason `variantsOf` is: when a
 * vendor name contains a shorter field's value, the longer match should
 * claim the characters.
 */
export function termsForFields(fields) {
  const terms = new Set()
  for (const value of Object.values(fields ?? {})) {
    const values = Array.isArray(value) ? value : [value]
    for (const entry of values) {
      for (const variant of variantsOf(entry)) terms.add(variant)
    }
  }
  return [...terms].sort((left, right) => right.length - left.length)
}

/**
 * Flatten a rendered text layer into one searchable string, remembering
 * where each character came from.
 *
 * PDF.js splits a page into one `<span>` per text run, and a run
 * boundary falls wherever the PDF's own layout put one — routinely in
 * the middle of a word, and almost always between the parts of a spaced
 * identifier. Searching span by span would therefore miss exactly the
 * values this feature exists to highlight. Concatenating first and
 * mapping back afterwards is what makes a match that spans three runs
 * findable at all.
 */
function indexTextNodes(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const nodes = []
  let text = ''

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const value = node.nodeValue ?? ''
    if (!value) continue
    nodes.push({ node, start: text.length, end: text.length + value.length })
    text += value
  }

  return { text, nodes }
}

/** The node and offset a flattened-string position falls at, or `null` past the end. */
function locate(nodes, position) {
  // Linear rather than binary: a page has tens to low hundreds of text
  // runs, and a scan over that costs less than the branch misprediction
  // of a binary search, with none of the off-by-one risk.
  for (const entry of nodes) {
    if (position >= entry.start && position < entry.end) {
      return { node: entry.node, offset: position - entry.start }
    }
  }
  const last = nodes[nodes.length - 1]
  return last ? { node: last.node, offset: last.node.nodeValue.length } : null
}

/**
 * Find every `terms` occurrence in `container`'s text and return the
 * rectangles covering them, in `container`-relative CSS pixels.
 *
 * Rectangles rather than wrapped `<mark>` elements, deliberately. The
 * text layer belongs to PDF.js: it rebuilds it on every re-render, and
 * mutating it means either fighting that or having highlights silently
 * disappear on the next zoom. Measuring with `Range.getClientRects()`
 * and drawing separate absolutely-positioned boxes leaves PDF.js's DOM
 * untouched — and gets multi-line matches right for free, since a range
 * spanning a line break reports one rectangle per line rather than one
 * box swallowing the gap between them.
 *
 * Overlaps are resolved by first-claim, and `terms` arrives longest-first
 * (see `termsForFields`), so the most specific value wins the characters
 * it shares with a shorter one.
 */
export function findMatches(container, terms) {
  if (!container || terms.length === 0) return []

  const { text, nodes } = indexTextNodes(container)
  if (!text) return []

  const haystack = text.toLowerCase()
  const claimed = new Array(text.length).fill(false)
  const containerBounds = container.getBoundingClientRect()
  const rects = []

  for (const term of terms) {
    const needle = term.toLowerCase()
    let from = 0

    for (;;) {
      const at = haystack.indexOf(needle, from)
      if (at === -1) break
      from = at + 1

      // A shorter term must not draw a second box over characters a
      // longer one already covers — two stacked translucent highlights
      // render as a darker patch that reads as a different kind of mark.
      let overlaps = false
      for (let offset = at; offset < at + needle.length; offset += 1) {
        if (claimed[offset]) {
          overlaps = true
          break
        }
      }
      if (overlaps) continue

      const start = locate(nodes, at)
      const end = locate(nodes, at + needle.length - 1)
      if (!start || !end) continue

      const range = document.createRange()
      try {
        range.setStart(start.node, start.offset)
        range.setEnd(end.node, end.offset + 1)
      } catch {
        // A node re-created between indexing and measuring (a re-render
        // landing mid-scan) makes the offsets invalid. Skipping this
        // match is right: the next render will redo the whole pass.
        continue
      }

      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue
        rects.push({
          term,
          left: rect.left - containerBounds.left,
          top: rect.top - containerBounds.top,
          width: rect.width,
          height: rect.height,
        })
      }

      for (let offset = at; offset < at + needle.length; offset += 1) claimed[offset] = true

      // A ceiling, not a correctness rule: a pathological document (a
      // field whose value is a single common word that survived the
      // filters) could otherwise draw thousands of boxes and make the
      // page unreadable and slow. Stopping is better than either.
      if (rects.length >= MAX_MATCHES_PER_PAGE) return rects
    }
  }

  return rects
}
