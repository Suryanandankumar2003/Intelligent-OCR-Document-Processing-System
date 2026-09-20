# Screenshots

The images referenced by the root `README.md`'s [Screenshots](../../README.md#screenshots)
section live here. Six files, named exactly as below — drop them in and
the README renders them; no other change is needed.

| File | Page | URL | What should be on screen |
|---|---|---|---|
| `process.png` | Process | `/` | Both panels side by side: a file chosen on the left, several files staged on the right. Take it at a wide window so the two columns are actually side by side (the layout stacks below ~1200px). |
| `batch-detail.png` | Batch detail | `/batches/{id}` | A batch **mid-run**, so the progress bar is part-filled, the "Live" chip is showing, and the file table has a mix of Success/Processing/Pending. This is the money shot — capture it while a batch is actually running. |
| `batch-history.png` | Batch history | `/batches` | Several batches in different statuses. Worth having one `Partially Completed` row, since that is the state the feature exists to surface. |
| `review.png` | Review | `/documents/{filename}/review` | The **Original document** tab active, so the scan is visible on the left with the extracted fields beside it. Use an image document rather than a PDF — it shows the zoom control. |
| `documents.png` | Documents | `/documents` | The list with a few rows, ideally a mix of review statuses and document types. |
| `analytics.png` | Analytics | `/analytics` | Scrolled so both the document stat cards and the batch section are visible, or take it after at least one batch has run so the batch half renders at all. |

## Capturing them

With the app running (see [Running the whole system](../../README.md#running-the-whole-system)):

- **Windows**: `Win` + `Shift` + `S` for a region, or `Alt` + `PrtScn`
  for the focused window.
- Use a window around **1600 px wide**. Narrower and the two-column
  layouts collapse into stacked ones, which is not what the README
  paragraphs next to them describe.
- The app has a light and a dark theme (the toggle is in the navbar).
  Pick one and use it for all six — a gallery that switches theme
  halfway looks like two different applications.

## A note on what to put in them

These end up in a public README. The sample documents in `backend/uploads/`
are real scans; if any of yours contain genuine PAN numbers, Aadhaar
numbers, patient names or contact details, either redact those regions
or process a set of dummy documents specifically for the screenshots.
