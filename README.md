# Intelligent OCR Document Processing System

An end-to-end pipeline that turns a photographed or scanned document into
structured, human-verified data. Upload a PAN card, Aadhaar card, invoice,
or medical prescription; the system transcribes it with OCR, classifies
what kind of document it is, extracts the field set defined for that type,
lets a human correct anything the model got wrong, and exports the whole
inventory to Excel.

Built as a FastAPI backend and a React frontend over Google Cloud's
Vertex AI (Gemini), with SQLite persistence.

---

## Table of contents

- [What it does](#what-it-does)
- [How the pipeline works](#how-the-pipeline-works)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Backend setup](#backend-setup)
- [Vertex AI credentials](#vertex-ai-credentials)
- [Frontend setup](#frontend-setup)
- [Configuration reference](#configuration-reference)
- [API reference](#api-reference)
- [Document types and extracted fields](#document-types-and-extracted-fields)
- [Data model](#data-model)
- [Human review workflow](#human-review-workflow)
- [Excel export](#excel-export)
- [Analytics](#analytics)
- [Error handling](#error-handling)
- [Troubleshooting](#troubleshooting)
- [Known gaps](#known-gaps)
- [Further reading](#further-reading)

---

## What it does

| Capability | Where it lives |
|---|---|
| Upload PDF / PNG / JPG with size and type validation | `POST /upload` |
| OCR via Gemini multimodal transcription | `POST /documents/{filename}/ocr` |
| Document-type classification (5 labels) | `POST /documents/{filename}/classify` |
| Structured field extraction per type | `POST /documents/{filename}/extract` |
| Human review with a full correction audit trail | `GET` / `PATCH /documents/{filename}/review` |
| Bulk `.xlsx` export with filters | `GET /documents/export/xlsx` |
| Pipeline health and throughput metrics | `GET /analytics/summary`, `/analytics/daily-trend` |
| Browsable document records | `GET /documents`, `GET`/`DELETE /documents/{filename}` |

---

## How the pipeline works

```
   ┌────────┐     ┌──────┐     ┌──────────┐     ┌───────────┐     ┌────────┐
   │ Upload │ ──▶ │ OCR  │ ──▶ │ Classify │ ──▶ │  Extract  │ ──▶ │ Review │
   └────────┘     └──────┘     └──────────┘     └───────────┘     └────────┘
      file         Gemini       one of 5         type-specific      human
     to disk     transcribes    doc types        field schema     corrects
        │                            │                 │              │
        ▼                            ▼                 ▼              ▼
   Document row              document_type      extracted_data   reviewed_data
   (type=Unknown,             persisted           persisted     + field_corrections
    data=null)                                                    (audit trail)
```

Each stage is an independent HTTP endpoint. The frontend
(`src/hooks/useDocumentPipeline.js`) is what chains them together — the
backend deliberately does not, so any stage can be called on its own.

**Important:** classification can legitimately return `Unknown` for a
document that isn't one of the four supported types. There is no field
schema for `Unknown`, so extraction then fails with a `422`. That is
by design, not a bug — see [Known gaps](#known-gaps) for how the
frontend currently handles it.

OCR text is **not persisted**. Classification and extraction each re-run
OCR internally rather than reusing a stored transcript.

---

## Tech stack

**Backend**
- Python 3.11, FastAPI 0.115, Uvicorn
- SQLAlchemy 2.0 (typed `Mapped`/`mapped_column` style), SQLite (WAL mode)
- Pydantic 2 + pydantic-settings
- `google-genai` (Vertex AI / Gemini 2.5 Flash)
- pandas + openpyxl for the Excel export
- pypdf for PDF page counts

**Frontend**
- React 19, Vite 8
- Axios (single shared client instance)
- oxlint
- Hand-rolled SVG charts — no charting library

---

## Project structure

```
Intelligent OCR Document Processing System/
├── backend/
│   ├── app.py                      # FastAPI entrypoint: middleware, routers, exception handlers
│   ├── requirements.txt
│   ├── .env.example                # copy to .env and fill in
│   ├── api/
│   │   ├── router.py               # aggregates every route module
│   │   ├── processing_metrics.py   # times each pipeline stage into processing_events
│   │   └── routes/
│   │       ├── health.py           # GET /health
│   │       ├── upload.py           # POST /upload
│   │       ├── ocr.py              # POST /documents/{f}/ocr
│   │       ├── classification.py   # POST /documents/{f}/classify
│   │       ├── extraction.py       # POST /documents/{f}/extract
│   │       ├── review.py           # GET + PATCH /documents/{f}/review
│   │       ├── export.py           # GET /documents/export/xlsx
│   │       ├── analytics.py        # GET /analytics/*
│   │       └── documents.py        # GET/DELETE document records
│   ├── core/                       # config, enums, exceptions, Vertex client (imports nothing above it)
│   ├── services/                   # business logic; no FastAPI, no DB sessions
│   │   └── prompts/                # Vertex AI prompt + JSON schema definitions
│   ├── schemas/                    # Pydantic request/response contracts
│   ├── database/                   # engine, session, models, CRUD, analytics queries
│   │   └── app.db                  # SQLite file (git-ignored)
│   ├── credentials/                # service account key goes here (git-ignored)
│   └── uploads/                    # stored files (git-ignored)
├── frontend/
│   ├── .env                        # VITE_API_BASE_URL
│   ├── vite.config.js
│   └── src/
│       ├── App.jsx                 # shell + tab state
│       ├── api/                    # axios client + endpoint wrappers
│       ├── hooks/                  # useDocumentPipeline, useDocumentReview, useAnalytics
│       ├── pages/                  # UploadPage, ReviewPage, AnalyticsPage
│       ├── components/             # presentational components (incl. analytics/ charts)
│       └── utils/                  # formatting and label helpers
├── docs/
│   └── architecture.md             # layering rules and design rationale
└── README.md
```

### Layering rules

Dependency direction is strictly `api → services → database / core`.
Lower layers never import from higher ones:

- `core/` holds cross-cutting config and enums and imports from nothing else.
- `services/` takes plain data in and returns plain data out — no FastAPI
  imports, no `Session` arguments. This keeps business logic unit-testable
  without HTTP or a transaction.
- `database/` owns persistence and translates driver errors into the
  app's own exception types.
- `api/` does HTTP concerns only: look things up, choose a status code,
  shape a response.

---

## Prerequisites

- **Python 3.11+**
- **Node.js 18+** and npm
- A **Google Cloud project** with the **Vertex AI API** enabled, and
  either a service account key or a `gcloud` login (see below)

Billing must be active on the GCP project — Gemini calls are charged per
request.

---

## Backend setup

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate           # Windows
# source .venv/bin/activate      # macOS / Linux
pip install -r requirements.txt
copy .env.example .env           # then fill in values
uvicorn app:app --reload
```

The server starts on `http://localhost:8000`.

| URL | What it is |
|---|---|
| `http://localhost:8000/api/v1/health` | Health check |
| `http://localhost:8000/docs` | Interactive Swagger UI |
| `http://localhost:8000/redoc` | ReDoc API reference |

On startup the app creates `backend/uploads/` if missing and runs
`init_db()`, which creates any missing tables and adds any mapped column
an existing table is missing (additive only — it is not a migration tool;
see `database/init_db.py`).

> **Run `uvicorn` from inside `backend/`.** Paths in `core/config.py`
> resolve against the `backend/` directory, but starting the server from
> elsewhere can still produce a second, empty `app.db` if you override
> `DATABASE_URL` with a relative path.

---

## Vertex AI credentials

OCR, classification, and field extraction all run on Vertex AI (Gemini).
Pick one of the two options below.

### Option A — service account key file (recommended for local setup)

1. In the GCP Console: **IAM & Admin → Service Accounts → Create**, grant
   it the **Vertex AI User** role, then **Keys → Add key → JSON**. A
   `credentials.json`-style file downloads.
2. Put that file at **`backend/credentials/gcp-service-account.json`**.
   That folder already exists and is git-ignored, so nothing you put
   there gets committed.
3. In `backend/.env`:
   ```
   GOOGLE_CLOUD_PROJECT=your-gcp-project-id
   GOOGLE_CLOUD_LOCATION=us-central1
   GOOGLE_APPLICATION_CREDENTIALS=credentials/gcp-service-account.json
   ```
   A relative path here resolves against `backend/`, not your current
   working directory (see `core/config.py`'s
   `google_application_credentials_path`).

### Option B — your own gcloud login (local dev only)

```bash
gcloud auth application-default login
```

Leave `GOOGLE_APPLICATION_CREDENTIALS` blank and set only
`GOOGLE_CLOUD_PROJECT`. Application Default Credentials picks up the
stored login automatically.

**Never commit a real key file.** `backend/.gitignore` already excludes
everything under `backend/credentials/` except the `.gitkeep` placeholder.
`core/vertex_client.py` builds one shared, lazily-created `genai.Client`
that all three AI services reuse.

---

## Frontend setup

```bash
cd frontend
npm install
npm run dev
```

Opens at `http://localhost:5173`, which is already in the backend's
default `CORS_ORIGINS`. The backend must be running — there is no mock
mode.

`frontend/.env` holds a single variable:

```
VITE_API_BASE_URL=http://localhost:8000/api/v1
```

Only variables prefixed with `VITE_` are exposed to browser code. If the
file is missing, `src/api/client.js` falls back to that same default.

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the built `dist/` locally |
| `npm run lint` | oxlint |

### Using the app

1. **Process Documents** tab — choose a PDF/PNG/JPG and upload. A
   progress bar tracks real bytes sent, then the pipeline steps light up
   as OCR, classification, and extraction run.
2. Results show the detected type, a confidence score, the raw OCR text,
   and the extracted fields.
3. Click **Review & correct fields** to open the review screen, where
   every field is editable. Corrections are stored alongside the model's
   original values — never on top of them — and each is logged with the
   value it replaced under **Correction history**.
4. **Analytics** tab — totals, per-type breakdown, per-stage success
   rates, and a daily trend chart.

---

## Configuration reference

All backend settings live in `backend/.env` and are read once through
`core/config.py`. Nothing else in the app touches `os.environ`.

| Variable | Default | Purpose |
|---|---|---|
| `APP_NAME` | `OCR Document Processing System` | Shown in health check and OpenAPI title |
| `APP_VERSION` | `0.1.0` | Reported by `/health` |
| `ENVIRONMENT` | `development` | Free-form label |
| `DEBUG` | `true` | Enables SQL echo and DEBUG-level logging |
| `API_V1_PREFIX` | `/api/v1` | Prefix every route is mounted under |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:3000` | Comma-separated allowed origins |
| `DATABASE_URL` | `sqlite:///<backend>/database/app.db` | SQLAlchemy connection string |
| `UPLOAD_DIR` | `<backend>/uploads` | Where uploaded files are stored |
| `MAX_UPLOAD_SIZE_MB` | `10` | Rejects larger uploads with `413` |
| `GOOGLE_CLOUD_PROJECT` | *(empty)* | **Required.** GCP project billed for Gemini calls |
| `GOOGLE_CLOUD_LOCATION` | `us-central1` | Vertex AI region |
| `GOOGLE_APPLICATION_CREDENTIALS` | *(empty)* | Path to service account JSON; blank = use ADC |
| `VERTEX_OCR_MODEL` | `gemini-2.5-flash` | Model used for transcription |
| `VERTEX_OCR_TIMEOUT_SECONDS` | `120` | Per-call OCR budget |
| `VERTEX_CLASSIFICATION_MODEL` | `gemini-2.5-flash` | Model used for classification |
| `VERTEX_CLASSIFICATION_TIMEOUT_SECONDS` | `60` | Per-call budget |
| `VERTEX_CLASSIFICATION_MAX_TEXT_CHARS` | `8000` | OCR text truncated to this before classifying |
| `VERTEX_EXTRACTION_MODEL` | `gemini-2.5-flash` | Model used for extraction |
| `VERTEX_EXTRACTION_TIMEOUT_SECONDS` | `60` | Per-call budget |
| `VERTEX_EXTRACTION_MAX_TEXT_CHARS` | `8000` | OCR text truncated to this before extracting |

---

## API reference

Base URL: `http://localhost:8000/api/v1`

`{filename}` always means the **server-generated** stored filename
returned by `POST /upload` (e.g. `4fb2bb8136b04af7ad4e2a8fbd7a3b5c.pdf`),
never the client's original filename.

### Health

```http
GET /health
→ 200 {"status":"ok","service":"...","version":"0.1.0","environment":"development"}
```

### Upload

```http
POST /upload            (multipart/form-data, field name: file)
→ 201 {
    "filename": "4fb2bb81...pdf",
    "original_filename": "pan-card.pdf",
    "content_type": "application/pdf",
    "size_bytes": 148223,
    "uploaded_at": "2026-09-18T06:50:35.691924Z"
  }
```

Accepts `application/pdf`, `image/png`, `image/jpeg`. Both the declared
content type **and** the file extension are checked. Creates a `Document`
row with `document_type=Unknown`, `extracted_data=null`.

### OCR

```http
POST /documents/{filename}/ocr
→ 200 {
    "filename": "...",
    "model": "gemini-2.5-flash",
    "extracted_text": "...",
    "page_count": 1,
    "processing_time_seconds": 4.312
  }
```

Page count comes from pypdf for PDFs; an image is always 1.

### Classification

```http
POST /documents/{filename}/classify
→ 200 {"document_type":"Medical Prescription","confidence":"0.95"}
```

Returns one of: `PAN Card`, `Aadhaar Card`, `Invoice`,
`Medical Prescription`, `Unknown`.

### Field extraction

```http
POST /documents/{filename}/extract?document_type=Invoice
→ 200 {
    "invoice_number": "INV-2024-001",
    "vendor_name": "Acme Supplies Pvt Ltd",
    "invoice_date": "15/01/2024",
    "total_amount": "$450.00"
  }
```

`document_type` is optional — omit it and the document is classified
first, reusing the same OCR text for both calls. Passing a type you
already know skips that second Gemini call.

Persists the result via `save_extraction_result`. Requesting
`document_type=Unknown` returns `422` — there is no field schema for it.

### Review

```http
GET /documents/{filename}/review
→ 200 {
    "filename": "...",
    "document_type": "Medical Prescription",
    "original_data":  { "patient_name": "Mrs. Asha", ... },
    "reviewed_data":  { "patient_name": "Asha Breed", ... },
    "review_status": "Reviewed",
    "reviewed_at": "2026-09-18T11:35:43.136763Z",
    "corrections": [
      {
        "id": 1,
        "field_name": "patient_name",
        "original_value": "Mrs. Asha",
        "corrected_value": "Asha Breed",
        "corrected_at": "2026-09-18T11:35:43Z"
      }
    ]
  }
```

```http
PATCH /documents/{filename}/review
Content-Type: application/json

{ "corrected_fields": { "patient_name": "Asha Breed" } }
→ 200  (same shape as GET)
```

Send **only** the fields that changed — that partial body is what lets
the server record precisely what the reviewer touched. An empty
`corrected_fields` object is rejected. Returns the full saved state,
because stored values are normalized on the way in (a PAN number is
upper-cased, whitespace trimmed, a blank becomes `null`).

`404` if the filename has no record; `409` if it exists but has never
been extracted; `422` if a value fails the document type's schema.

### Excel export

```http
GET /documents/export/xlsx
GET /documents/export/xlsx?document_type=Invoice
GET /documents/export/xlsx?uploaded_from=2026-09-01T00:00:00Z&uploaded_to=2026-09-30T23:59:59Z
→ 200  application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
```

### Analytics

```http
GET /analytics/summary
→ 200 {
    "generated_at": "...",
    "total_documents": 30,
    "documents_by_type": [{"document_type":"Invoice","count":1}, ...],
    "average_processing_time_seconds": 12.4,
    "stage_metrics": [
      {"stage":"OCR","attempts":42,"successes":40,"failures":2,
       "success_rate":0.952,"average_duration_ms":4310.5}, ...
    ]
  }

GET /analytics/daily-trend?days=30
→ 200 {
    "days": 30,
    "trend": [{"date":"2026-09-18","documents_uploaded":30,"documents_extracted":11}, ...]
  }
```

`days` accepts 1–365 and defaults to 30. The series is zero-filled and
contiguous — every day in range appears.

### Document records

```http
GET    /documents?skip=0&limit=100&document_type=Invoice
GET    /documents/{filename}
DELETE /documents/{filename}          → 204
```

`DELETE` removes the database record only; the file stays in `uploads/`.
Its correction history is removed with it via cascade.

> **Route-order note:** `GET /documents/export/xlsx` and
> `GET /documents/{filename}` overlap. It resolves correctly only because
> `api/router.py` registers the export router *before* the documents
> router. Do not reorder those two lines.

---

## Document types and extracted fields

| Document type | Fields |
|---|---|
| **PAN Card** | `name`, `father_name`, `dob`, `pan_number` |
| **Aadhaar Card** | `name`, `dob`, `gender`, `aadhaar_number` |
| **Invoice** | `invoice_number`, `vendor_name`, `invoice_date`, `total_amount` |
| **Medical Prescription** | `patient_name`, `doctor_name`, `date`, `medicines` (list) |
| **Unknown** | *(no schema — extraction refuses)* |

Every scalar field is `Optional[str]` defaulting to `None`. A field the
model could not find comes back as `null` — never `""`, never `"N/A"`,
never an exception. Consumers need exactly one check.

**Two validation layers** (`schemas/extraction.py`), both Pydantic
validators so there is no way to construct an unvalidated instance:

1. A `mode="before"` normalizer trims whitespace and folds placeholder
   tokens (`N/A`, `null`, `none`, `not found`, `-`, …) down to `None`.
2. `mode="after"` format checks:
   - `pan_number` must match `^[A-Z]{5}[0-9]{4}[A-Z]$` (upper-cased first)
   - `aadhaar_number` must be 12 digits (spaces/dashes stripped)
   - `total_amount` must contain at least one digit
   - `gender` expands `m`/`f`/`o`/`t`, keeps anything else verbatim

During **extraction** a value failing these checks folds to `None` —
noisy OCR should not fail an otherwise-good read. During **review** the
same failure raises a `422` instead, because silently blanking what a
reviewer typed would report a save that never happened.

---

## Data model

Three SQLite tables (`database/models.py`).

### `documents`

| Column | Notes |
|---|---|
| `id` | PK |
| `filename` | Unique, indexed — every endpoint addresses documents by this |
| `document_type` | Enum stored as its value (`"PAN Card"`), VARCHAR + CHECK |
| `extracted_data` | JSON. The model's original answer. **Immutable once written** |
| `reviewed_data` | JSON. Corrected values; `null` until a reviewer saves |
| `review_status` | `Pending Review` / `Reviewed` |
| `reviewed_at` | When a reviewer last saved |
| `uploaded_at` | Business timestamp, set at upload |
| `created_at` / `updated_at` | Row-lifecycle audit columns, server-defaulted |

Reading **"current best data"** always means
`reviewed_data or extracted_data`.

### `field_corrections`

Append-only audit trail, one row per corrected field per save. Cascades
on document delete. `original_value`/`corrected_value` are JSON, not
strings, so a list field (`medicines`) round-trips and so JSON `null`
stays distinguishable from `""`.

Every correction is recorded against `extracted_data` — the model's
untouched first answer — never against the previous correction. Correcting
the same field three times yields three rows all citing the same original,
so "how far is this from what the model produced?" stays answerable.

### `processing_events`

One row per pipeline-stage attempt (success **or** failure) with
`duration_ms`, `started_at`, and the failing exception's class name.
Deliberately **not** foreign-keyed to `documents`: this is telemetry about
the pipeline's health, and a 30-day success-rate trend must stay accurate
even after some of its documents are deleted.

Writing one is best-effort — a telemetry failure never turns a successful
OCR call into a 500.

---

## Human review workflow

Extraction is a model's best guess, so its output is corrected rather than
trusted.

- **Corrections never overwrite the model's output.** `extracted_data`
  stays immutable; corrections land in `reviewed_data` with an audit row
  per field.
- **Reviewer input is validated through the same Pydantic model** that
  validated the AI's extraction, so human and machine values are held to
  identical rules.
- **Re-saving is safe.** A field re-submitted with the value it already
  holds is not a correction and produces no audit row.
- **Undoing is an event.** Setting a field back to the model's original
  value *is* recorded — as a row whose original and corrected values
  coincide.
- **A second review never silently reverts the first.** Corrections merge
  onto current values, not onto the original extraction.
- Corrections and the status change are written in a **single
  transaction** (`crud.save_review`), so there is no window where data
  claims to be corrected but nothing records what it replaced.

---

## Excel export

`GET /documents/export/xlsx` produces one sheet named **Documents**:

```
Filename | Document Type | Created Date | Name | Father's Name | Date of Birth |
PAN Number | Gender | Aadhaar Number | Invoice Number | Vendor Name |
Invoice Date | Total Amount | Patient Name | Doctor Name | Date | Medicines
```

Every field across all four document types is a column in one sheet, in a
stable order, de-duplicated where a name repeats (`name`, `dob`). A row
fills in its own type's columns and leaves the rest blank — that makes the
export a single inventory rather than four files a consumer must
reassemble, and a fifth document type would extend the column list for
free.

Rows export **current best data** (`reviewed_data or extracted_data`), so
a corrected document exports its corrected values. Documents that were
only uploaded still appear, with blank field columns — this is a document
inventory, not solely an extraction report. `medicines` is joined with
`"; "` (not `", "`, since one entry can itself contain a comma).

**Memory-bounded by design**, in two halves:

- `crud.iter_documents_for_export` uses **keyset pagination**
  (`WHERE id > last_seen_id ORDER BY id LIMIT 1000`) rather than
  OFFSET/LIMIT, which degrades to rescanning an ever-larger table prefix.
- `export_service.write_documents_xlsx` uses
  `openpyxl.Workbook(write_only=True)`, flushing each row to a temp file
  as it is appended. pandas normalizes each batch (`reindex` guarantees
  identical columns per batch; `NaN`/`NaT`/`None` collapse to one blank
  cell).

The route streams the finished file via `FileResponse` and deletes it with
a `BackgroundTask` after the download completes.

---

## Analytics

`database/analytics.py` computes everything fresh on each request, with no
caching or pre-aggregation — at this scale it is the same handful of
`GROUP BY`/`AVG` queries either way, and a dashboard that can silently show
stale numbers is a worse failure mode than one extra query per page load.

Stage metrics cover every attempt ever recorded. `average_processing_time_seconds`
measures upload → successful extraction. Both are computed from
`processing_events`, so they are only as complete as that table.

---

## Error handling

Every custom exception is mapped to a status code in one place
(`app.py:register_exception_handlers`), so all errors return the same
`{"detail": "..."}` shape. Handlers are matched most-specific-first.

| Status | When |
|---|---|
| `400` | Empty file, empty OCR text, generic upload/review error |
| `404` | No document record, or no such file for OCR |
| `409` | Document exists but has not been extracted yet (review) |
| `413` | Upload exceeds `MAX_UPLOAD_SIZE_MB` |
| `415` | Unsupported file type |
| `422` | No field schema for the type (e.g. `Unknown`), or a review value failed validation |
| `500` | Vertex AI misconfigured, file save failed, database write failed |
| `502` | Vertex AI auth failure, parsing failure, or processing error |
| `503` | Vertex AI rate limit |
| `504` | Vertex AI timeout |

Rule of thumb: 4xx means the caller can fix it; 5xx means a downstream
dependency or our own side failed. AI-stage failures map mostly to 5xx
because they represent *our* request to Vertex AI failing, not a bad
request from the client.

On the frontend, `src/api/errorMessage.js` unpacks `detail` whether it is
a plain string or FastAPI's validation-error array.

---

## Troubleshooting

**`VertexAIConfigurationError` / 500 on any AI endpoint**
`GOOGLE_CLOUD_PROJECT` is unset, or `GOOGLE_APPLICATION_CREDENTIALS`
points at a file that does not exist. Remember the path resolves against
`backend/`.

**502 with an authentication message**
The service account lacks the **Vertex AI User** role, or the Vertex AI
API is not enabled on the project.

**`Review screen shows "has no extracted fields yet"` (409)**
That document was uploaded but never successfully extracted — usually
because it classified as `Unknown`. Only PAN cards, Aadhaar cards,
invoices, and prescriptions can be extracted.

**Extraction returns 422 for a real document**
It classified as `Unknown`. Call
`POST /documents/{filename}/extract?document_type=Invoice` explicitly to
override the classifier.

**CORS errors in the browser console**
Add your frontend origin to `CORS_ORIGINS` in `backend/.env` and restart
the backend.

**Analytics dashboard is empty**
`processing_events` only records attempts made *after* that table existed.
Re-run a document through the pipeline to populate it.

**A second, empty `app.db` appears**
`uvicorn` was started from outside `backend/` with a relative
`DATABASE_URL`. Start it from `backend/`.

**Excel file will not open / "format is not valid"**
The response is a binary zip. If you are fetching it from JavaScript,
the request must use `responseType: 'blob'` — the default JSON parsing
corrupts it.

---

## Known gaps

Honest notes on what is not finished, so nobody mistakes these for bugs
to hunt.

1. **No Excel export button in the UI.** The backend endpoint is complete
   and working; the frontend has no wrapper, button, or download handler
   for it. Today you download it by opening
   `http://localhost:8000/api/v1/documents/export/xlsx` directly. Wiring
   it up will need `responseType: 'blob'` on the axios call, plus
   `expose_headers=["Content-Disposition"]` on the backend's CORS
   middleware for the browser to read the server's filename.

2. **The review screen is only reachable right after a successful
   pipeline run.** `App.jsx` holds the selection in component state with
   no router and no persistence, and the "Review & correct fields" button
   only renders at `stage === DONE`. Reload the page, or come back to a
   document processed yesterday, and there is no path to it — even though
   `GET /documents/{filename}/review` is designed to work standalone and
   `GET /documents` already lists every record. A documents-list screen is
   the missing piece.

3. **An `Unknown` classification dead-ends the pipeline.** The frontend
   passes the classifier's answer straight into extraction, so `Unknown`
   produces a 422 that lands the UI in an error state with no path back to
   the uploaded document.

4. **No automated tests.** The layering is built for testability
   (services take plain data, CRUD takes a plain `Session`) but no suite
   exists yet.

5. **`init_db.py` is not a migration tool.** It adds missing columns
   additively — no renames, no drops, no down-migrations, no history.
   Alembic is the right answer once there are deployments to keep in sync.

6. **Upload validation is not content sniffing.** Content-type and
   extension are both checked, which catches obvious mismatches but is not
   equivalent to libmagic-style inspection.

7. **OCR runs up to three times per document.** Classification and
   extraction each re-run it internally rather than reusing a stored
   transcript. Persisting OCR text would remove two Gemini calls per
   document.

---

## Further reading

- `docs/architecture.md` — layering rules and the reasoning behind each
  design decision.
- Module docstrings throughout `backend/` — most files explain *why* they
  are shaped the way they are, not just what they do.
