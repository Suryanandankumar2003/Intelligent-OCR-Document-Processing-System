# Architecture

## Layers (backend)

| Layer | Folder | Responsibility |
|---|---|---|
| Entrypoint | `backend/app.py` | Creates the FastAPI app, wires middleware/routers, runs startup tasks |
| API | `backend/api/` | HTTP contracts only: routers, request/response shapes |
| Services | `backend/services/` | Business logic (OCR processing will live here) |
| Database | `backend/database/` | SQLAlchemy engine, session, declarative base, model registration |
| Core | `backend/core/` | Cross-cutting config (env vars, settings) |
| Uploads | `backend/uploads/` | Local storage for uploaded documents |

Dependency direction: `api` → `services` → `database`/`core`. Lower layers never
import from higher ones, so business logic and persistence stay testable
without spinning up HTTP.

## Status

Health check, CORS, config loading, file upload, OCR extraction,
document-type classification, structured field extraction (all via
Google Cloud Vertex AI / Gemini), and SQLite persistence are
implemented. Classification and extraction both reuse the extracted OCR
text — neither re-reads the source file. Classification returns one of:
PAN Card, Aadhaar Card, Invoice, Medical Prescription, or Unknown.
Extraction returns the field set defined for that type (see
`backend/schemas/extraction.py`); it has no schema for Unknown, so
classifying as Unknown makes extraction fail with a 422.

### Vertex AI

`backend/core/vertex_client.py` builds one shared `genai.Client` (lazy
singleton) that `services/ocr_service.py`, `services/classification_service.py`,
and `services/extraction_service.py` all call — unlike the previous
per-feature Mistral clients, there's only one provider/credential setup
to share now. OCR has no dedicated endpoint on Vertex AI; it's done by
handing Gemini the file's bytes directly as multimodal input and asking
it to transcribe the text (see `ocr_service.py`'s module docstring).
Classification uses `response_mime_type="application/json"`; extraction
additionally passes `response_json_schema` (one of the four schemas in
`services/prompts/extraction_prompt.py`) so the model is structurally
constrained to each document type's exact field set.

### Persistence

`POST /upload` creates a `Document` row (`backend/database/models.py`)
for the stored file — `document_type=Unknown`, `extracted_data=null`.
`POST /documents/{filename}/extract` updates that same row in place with
the resolved `document_type` and the extracted fields as JSON, via
`database.crud.save_extraction_result`. `GET /documents`,
`GET /documents/{filename}`, and `DELETE /documents/{filename}` expose
the read/delete side of that data (`backend/api/routes/documents.py`).
One row always corresponds to one file in `UPLOAD_DIR`, keyed by its
unique stored filename.

`database/init_db.py` creates missing tables on startup and adds any
mapped column that an already-created table is missing (additive only).
That is not a migration tool — it exists so a schema change doesn't
break a local install that already holds data.

### Human review

Extraction is a model's best guess, so its output is corrected rather
than trusted. `GET /documents/{filename}/review` returns a document's
original extraction, its current values, and its correction history;
`PATCH /documents/{filename}/review` saves a partial set of corrected
fields (`backend/api/routes/review.py`).

Corrections never overwrite the model's output. `Document.extracted_data`
is immutable once written; corrected values live in
`Document.reviewed_data`, with `review_status` (`Pending Review` /
`Reviewed`, see `core/review_status.py`) and `reviewed_at` recording the
workflow state, and one append-only `field_corrections` row per
corrected field holding the original value alongside the new one.
Reading "current best data" for a document therefore means
`reviewed_data or extracted_data`.

`services/review_service.py` validates corrections through the *same*
Pydantic model that validated the extraction
(`EXTRACTION_MODEL_BY_TYPE`), so human and machine values are held to
identical rules — with one deliberate difference: extraction quietly
folds an unusable value to `None`, while a review rejects it with a 422,
since silently blanking what a reviewer typed would report a save that
didn't happen. `database/crud.py:save_review` writes the corrected data
and its audit rows in a single transaction.

Frontend: `src/pages/ReviewPage.jsx` is a screen of its own, loading by
filename via `useDocumentReview` rather than from pipeline state, so a
document can be reviewed long after it was processed.

### Bulk xlsx export

`GET /documents/export/xlsx` (`backend/api/routes/export.py`) downloads
every processed document as one spreadsheet: filename, document type,
created date, then one column per extracted field across all four
document types (PAN Card's, then Aadhaar's, then Invoice's, then
Prescription's — de-duplicated where a name repeats, e.g. `name`,
`dob`), with a row's own type's fields filled in and the rest blank.
Accepts optional `document_type` / `uploaded_from` / `uploaded_to` query
filters; omitted, it exports everything. Each row exports "current best
data" — `reviewed_data or extracted_data` — the same convention the
review API uses, so a corrected document exports its corrected values.

Built to stay memory-bounded regardless of table size, in two halves:

* `database/crud.py:iter_documents_for_export` reads the table with
  *keyset* pagination (`WHERE id > last_seen_id ORDER BY id LIMIT
  batch_size`), not the OFFSET/LIMIT paging `list_documents` uses —
  OFFSET degrades to rescanning and discarding an ever-larger table
  prefix as it grows, which is fine for a UI page size but not for a
  full-table export.
* `services/export_service.py:write_documents_xlsx` writes with
  `openpyxl.Workbook(write_only=True)`, which flushes each row to a
  temp file as soon as it's appended instead of holding the whole sheet
  in memory. Rows are normalized through pandas in the same batches they
  arrive from the database in (`reindex` to guarantee every batch has
  identical columns, `where`/`fillna` to collapse `NaN`/`None` to one
  blank cell) — pandas shapes each chunk, openpyxl is what keeps the
  process's memory flat as the export grows.

The route streams the result from a temp file via `FileResponse` (never
an in-memory buffer), deleting it via a `BackgroundTask` once the
download completes.

### Application logging (the Logs module)

Every meaningful thing the platform does writes a row to
`application_logs`: an upload accepted or rejected, each pipeline stage
started and finished, a review saved, a document approved or rejected,
a batch started, each of its files, the batch finishing, a retry, an
export, and the API starting up.

This sits *alongside* `processing_events`, not instead of it, and the
split is the point:

| | `processing_events` | `application_logs` |
|---|---|---|
| Question it answers | "how often does OCR succeed, and how fast" | "what happened to this document / this batch" |
| Shape | three stages, two outcomes, a duration — every column group-by-able | an event, a sentence, a JSON payload, optional document/batch/filename |
| Covers | the three Vertex stages only | uploads, reviews, approvals, batches, retries, exports, startup |
| Read by | `database/analytics.py` → the Analytics dashboard | `database/log_crud.py` → the Logs screen |

Widening `processing_events` with a message and a payload would turn the
table the Analytics dashboard scans on every page load into the table
that also absorbs every free-text event in the system. Both are written
from the same call sites (`api/processing_metrics.py` writes one of
each per stage attempt), so they cannot drift.

**Vocabulary.** `core/log_events.py` owns `LogEventType`, `LogCategory`,
`LogStatus`, and — critically — the event→category mapping. A call site
names only the event; the category follows. Left to call sites, "OCR
Completed" would eventually be filed under `System` somewhere and the
analytics breakdown would quietly under-count OCR. A stage *failure*
gets its own event type (`OCR Failed`, not `OCR Completed` with a
Failure status) for the same reason: the category is derived from the
event, so filing failures under a generic `Error` event would hide them
from the per-category failure cards.

**Write path.** `services/event_log.py` is the narrow waist:
`log_event` for a moment, `track_event` for an operation (writes
`Started` before and `Success`/`Failure` after, with the elapsed time),
and `log_once` for the handful of events that describe a whole thing
finishing — a batch's completion is noticed by whichever file finishes
last, and two finishing together would otherwise both record it.
Nothing in that module may raise: every call site is real work with its
own contract, and none of them is prepared for the logger to fail.

**Cost, stated plainly.** A fully processed document writes three
`processing_events` rows and six `application_logs` rows. At 500 files
that is ~4,500 small commits against SQLite, which the WAL journal and
the 15-second busy timeout in `database/session.py` are already
configured for. The `Started` rows are half of that volume and they earn
it: a lone `Started` with no partner is the only signature a stuck batch
leaves behind.

**Read path.** `database/log_crud.py` pushes every filter into SQL —
unlike the documents list, which loads the table and filters in the
browser. The difference follows the data: that table is bounded by one
operator's work and its search runs over values inside a JSON column,
while this one grows by several rows per file per batch and every filter
it offers is an indexed predicate. `GET /logs` pages server-side with a
real total; `GET /logs/analytics` serves the dashboard; `GET
/logs/export/xlsx` streams a workbook through the *same* filter builder
the list uses, which is what makes "export what I'm looking at" true by
construction.

Log rows deliberately have **no foreign keys** to `documents` or
`batches`. A log records that something happened; deleting its subject
must not delete the evidence, and "the document this refers to has since
been deleted" is a useful thing for an audit trail to be able to say.

### Audit trail

A document's history has two halves, stored separately because they are
genuinely different things:

* `field_corrections` — values that changed, one append-only row per
  field per save, each anchored to the model's original extraction.
* `application_logs` — decisions somebody made: a save happened, a
  document was approved, a document was rejected. These have no field
  and no value, and faking one to fit them into the corrections table
  would make the trail say something untrue.

`services/audit_service.py` merges them into one chronological list,
newest first, and `GET /documents/{filename}/audit` serves it. Ties are
broken so a save sorts above the field changes it describes, because
both are written within the same few milliseconds.

The endpoint is separate from `GET .../review`, which already returns
`corrections`, for three reasons: the review response is what the
screen blocks its first paint on, the audit panel is re-read after every
save and decision, and the two want opposite sort orders — the
correction list reads forwards as the story of how a value got where it
is, while the panel is opened to find out what happened last.

Unlike the review endpoints, the audit endpoint does **not** require the
document to have been extracted. A document that classified as Unknown
has no fields, but it can still have been opened and rejected — and a
409 there would hide exactly the history explaining why.

### Document viewer (review screen)

The review screen's left pane renders PDFs with PDF.js
(`frontend/src/components/viewer/`) rather than handing them to the
browser in an `<iframe>`. The iframe was the right first answer — free,
and the built-in viewer is good — and it is opaque to the page
containing it: its zoom cannot be set, its current page cannot be read,
and its text cannot be reached. Those are three of the five things this
pane has to do.

One page is rendered at a time, which is the whole answer to "support
large PDFs": memory and render time are a function of the page being
looked at, not of how many pages the document has.

Highlighting extracted values is a *text search* over what PDF.js read
off the page, not a bounding box the model returned — nothing in the
extraction pipeline produces coordinates. So it is best-effort by
construction, and the viewer says which of the three reasons applies
when it finds nothing: a scanned image has no text layer, a text-bearing
page may simply not contain the value, and a value the model normalized
may no longer match the characters on the page.

PDF.js's runtime side files (the JBIG2 / JPEG 2000 WASM decoders, the
Base-14 fonts, the CMaps) are served from the app's own origin by a
small plugin in `frontend/vite.config.js`, never from a CDN — this
project is a local install that has to work with no internet connection.
The JBIG2 and JPEG 2000 decoders are not optional: both are standard
compression formats for scanned documents, and a PDF using either
renders blank without them.
