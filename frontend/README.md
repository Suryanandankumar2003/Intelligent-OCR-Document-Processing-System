# Intelligent OCR Document Processing — Frontend

Vite + React app for the OCR/classification/extraction pipeline in
`../backend`. See the repository root `README.md` for setup and the
`docs/architecture.md` for how this fits together.

## Structure

| Path | What's there |
|---|---|
| `src/api/` | `client.js` (the shared Axios instance) and `documents.js` (one function per backend endpoint) |
| `src/hooks/useDocumentPipeline.js` | The upload → OCR → classify → extract state machine |
| `src/components/` | Presentation-only components (file picker, button, progress/stepper, results) |
| `src/pages/UploadPage.jsx` | The one page: composes the hook and the components above |

## Scripts

```bash
npm run dev      # start the dev server (http://localhost:5173)
npm run build    # production build to dist/
npm run lint     # oxlint
npm run preview  # serve the production build locally
```
