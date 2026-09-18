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
