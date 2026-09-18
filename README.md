# OCR Document Processing System

## Backend setup

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
copy .env.example .env        # then fill in values
uvicorn app:app --reload
```

Health check: `GET http://localhost:8000/api/v1/health`

### Vertex AI credentials

OCR, classification, and field extraction run on Google Cloud's Vertex AI
(Gemini). You need a GCP project with the Vertex AI API enabled, and one
of:

**Option A — service account key file (recommended for this local setup):**

1. In the GCP Console: IAM & Admin → Service Accounts → create one →
   grant it the **Vertex AI User** role → Keys → Add key → JSON. This
   downloads a `credentials.json`-style file.
2. Put that file at **`backend/credentials/gcp-service-account.json`**
   (the `backend/credentials/` folder already exists and is git-ignored
   — nothing you put there gets committed).
3. In `backend/.env`, set:
   ```
   GOOGLE_CLOUD_PROJECT=your-gcp-project-id
   GOOGLE_APPLICATION_CREDENTIALS=credentials/gcp-service-account.json
   ```
   (a relative path here is resolved against `backend/`, not wherever
   you happen to run `uvicorn` from — see `core/config.py`'s
   `google_application_credentials_path`).

**Option B — your own gcloud login (fine for local dev only):**

```bash
gcloud auth application-default login
```
This stores credentials in a well-known location the Google Cloud SDK
manages for you — leave `GOOGLE_APPLICATION_CREDENTIALS` blank in
`.env` in this case, and just set `GOOGLE_CLOUD_PROJECT`.

Either way, the *file itself* is never referenced by a fixed path the
app assumes — `GOOGLE_APPLICATION_CREDENTIALS` is what tells Google's
auth library (used internally by `core/vertex_client.py`) where to find
it. Never commit a real key file; `backend/.gitignore` already excludes
everything under `backend/credentials/` except the placeholder
`.gitkeep`.

## Frontend

Vite + React app in `frontend/`. Requires the backend running (see above)
for uploads/OCR/classification/extraction to work — the dev server has no
mock mode.

```bash
cd frontend
npm install
copy .env.example .env        # then adjust VITE_API_BASE_URL if needed
npm run dev
```

Opens at `http://localhost:5173` by default, which is already in the
backend's default `CORS_ORIGINS`. Upload a PAN card, Aadhaar card,
invoice, or prescription (PDF/PNG/JPG) to see it OCR'd, classified, and
field-extracted.

Then click **Review & correct fields** to open the review screen, where
every extracted field is editable. Saved corrections are stored
alongside the model's original values — never on top of them — and each
one is recorded with the value it replaced, visible under "Correction
history". See `docs/architecture.md` for how that's persisted.

Download `GET /api/v1/documents/export/xlsx` (or open that URL directly)
for a spreadsheet of every processed document — filename, document type,
extracted fields, created date — with optional `document_type` /
`uploaded_from` / `uploaded_to` filters.

## Docs

See `docs/architecture.md` for the layering rules.
