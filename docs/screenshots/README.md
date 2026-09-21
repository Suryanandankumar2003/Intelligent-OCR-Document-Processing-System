# Screenshots

The images referenced by the root `README.md`'s [Screenshots](../../README.md#screenshots)
section live here. Seven files, named exactly as below — drop them in
and the README renders them; no other change is needed.

| File | Page | URL | What should be on screen |
|---|---|---|---|
| `process.png` | Process | `/` | Both panels side by side: a file chosen on the left, several files staged on the right. Take it at a wide window so the two columns are actually side by side (the layout stacks below ~1200px). |
| `batch-detail.png` | Batch detail | `/batches/{id}` | A batch **mid-run**, so the progress bar is part-filled, the "Live" chip is showing, and the file table has a mix of Success/Processing/Pending. This is the money shot — capture it while a batch is actually running. |
| `batch-history.png` | Batch history | `/batches` | Several batches in different statuses. Worth having one `Partially Completed` row, since that is the state the feature exists to surface. |
| `review.png` | Review | `/documents/{filename}/review` | The **Original document** tab active, with the viewer's toolbar visible and at least one value highlighted on the page. Use a **multi-page PDF that has a text layer** rather than a photo — that is the only kind of document where the page counter, the fit-to-width control and the highlight toggle are all live at once, and it is what the README paragraph beside it describes. Expand the **Audit history** panel on the right if the document has any, so the panel is visible rather than just its header. |
| `documents.png` | Documents | `/documents` | The list with a few rows, ideally a mix of review statuses and document types. |
| `analytics.png` | Analytics | `/analytics` | Scrolled so both the document stat cards and the batch section are visible, or take it after at least one batch has run so the batch half renders at all. |
| `logs.png` | Logs | `/logs` | The **Analytics** panel expanded (button, top right) so the five cards and at least the error-trend and event-distribution charts are above the table, with the table below showing a mix of statuses — including at least one `Failure` row, so its tinted row is visible. Take it after a batch has run, so the event distribution has more than two bars. |

## Capturing them

With the app running (see [Running the whole system](../../README.md#running-the-whole-system)):

- **Windows**: `Win` + `Shift` + `S` for a region, or `Alt` + `PrtScn`
  for the focused window.
- Use a window around **1600 px wide**. Narrower and the two-column
  layouts collapse into stacked ones, which is not what the README
  paragraphs next to them describe.
- The app has a light and a dark theme (the toggle is in the navbar).
  Pick one and use it for all seven — a gallery that switches theme
  halfway looks like two different applications.
- Leave the sidebar **expanded**. It can be collapsed to an icon rail,
  and the state is remembered per browser, so it is easy to capture six
  shots with it open and one with it closed without noticing.

## A note on what to put in them

These end up in a public README. The sample documents in `backend/uploads/`
are real scans; if any of yours contain genuine PAN numbers, Aadhaar
numbers, patient names or contact details, either redact those regions
or process a set of dummy documents specifically for the screenshots.

`logs.png` deserves a second look before you publish it. The log table
shows a `Message` column and the entries in it quote filenames and
failure text verbatim, so a row like *"Upload rejected for
'Priya-Sharma-PAN.jpg'"* leaks a real name into the README even though
no document is on screen. The `review.png` shot has the same problem in
the opposite direction: the highlighted values on the page are, by
definition, the extracted fields.
