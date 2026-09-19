/**
 * Orchestrates the full "process this file" pipeline: upload -> OCR ->
 * classify -> extract fields, calling the FastAPI backend one step at a
 * time and tracking which step is currently running.
 *
 * This chaining lives on the frontend, not the backend, on purpose: each
 * backend endpoint (upload/ocr/classify/extract) is independently
 * useful and callable on its own — see backend/api/routes/ — so nothing
 * server-side already does "run all four in sequence for me". This hook
 * is that composition, for the specific "upload a document and see
 * everything about it" user story this page implements.
 *
 * Written as a custom hook (rather than inlining this logic in
 * UploadPage) so the state machine and the JSX are two separate,
 * separately-readable things — UploadPage.jsx only has to know
 * "here is the current stage and the data so far", not how each step is
 * actually fetched.
 *
 * --- Unknown is an outcome, not a failure ----------------------------
 *
 * The classifier is allowed to answer `Unknown`, and extraction has no
 * field schema for that (backend/services/prompts/extraction_prompt.py),
 * so asking it to extract one is a guaranteed 422. This hook used to do
 * exactly that and land in `ERROR`, which told the user "something went
 * wrong" about a document that had processed perfectly well — and left
 * them with no way forward. `Unknown` now ends the run in its own
 * terminal stage, `UNSUPPORTED`, with the OCR text and the verdict
 * intact, and `extractAs` is the way out: the user names the type and the
 * pipeline resumes from the extraction step.
 */
import { useCallback, useState } from 'react'
import { classifyDocument, extractFields, runOcr, uploadDocument } from '../api/documents'
import { extractErrorMessage } from '../api/errorMessage'

export const STAGES = {
  IDLE: 'idle',
  UPLOADING: 'uploading',
  EXTRACTING_TEXT: 'extracting-text',
  CLASSIFYING: 'classifying',
  EXTRACTING_FIELDS: 'extracting-fields',
  DONE: 'done',
  // Classified, but as a type nothing can be extracted from. A resting
  // state the user can act on, deliberately not ERROR: nothing failed,
  // and the document, its transcript, and its classification are all
  // saved server-side.
  UNSUPPORTED: 'unsupported',
  ERROR: 'error',
}

// The one label the backend returns that has no field schema behind it.
const UNKNOWN_TYPE = 'Unknown'

const initialState = {
  stage: STAGES.IDLE,
  uploadProgress: 0,
  filename: null,
  ocrText: null,
  documentType: null,
  confidence: null,
  fields: null,
  error: null,
  // True once the user has named the document type themselves, so the
  // page can tell a manual extraction (which keeps the unsupported panel
  // on screen while it runs) from the pipeline's own automatic one.
  isManualExtraction: false,
}

export function useDocumentPipeline() {
  const [state, setState] = useState(initialState)

  const reset = useCallback(() => setState(initialState), [])

  /**
   * Runs the extraction step for a type the caller has decided on, and
   * finishes the pipeline with it.
   *
   * Used by the unsupported-document panel, where the type comes from a
   * human rather than the classifier. `confidence` is cleared because the
   * model's score described the model's own guess, and this isn't it;
   * showing the old number next to a hand-picked type would attribute a
   * human's decision to the model.
   *
   * A failure here returns to `UNSUPPORTED` with the message, rather than
   * to `ERROR` — the user's next move (try a different type) is the same
   * one that panel already offers, so taking it away would be a step
   * backwards.
   */
  const extractAs = useCallback(
    async (documentType) => {
      const filename = state.filename
      if (!filename) return

      setState((prev) => ({
        ...prev,
        stage: STAGES.EXTRACTING_FIELDS,
        documentType,
        confidence: null,
        error: null,
        isManualExtraction: true,
      }))

      try {
        const fields = await extractFields(filename, documentType)
        setState((prev) => ({ ...prev, stage: STAGES.DONE, fields }))
      } catch (error) {
        setState((prev) => ({
          ...prev,
          stage: STAGES.UNSUPPORTED,
          error: extractErrorMessage(
            error,
            `Could not extract this document as a ${documentType}. Try a different type.`,
          ),
        }))
      }
    },
    // Only the filename is read, so a new callback identity is created
    // when the document changes and not on every unrelated state update.
    [state.filename],
  )

  const run = useCallback(async (file) => {
    setState({ ...initialState, stage: STAGES.UPLOADING })

    try {
      const uploadResult = await uploadDocument(file, {
        onUploadProgress: (percent) => setState((prev) => ({ ...prev, uploadProgress: percent })),
      })
      const { filename } = uploadResult

      setState((prev) => ({ ...prev, stage: STAGES.EXTRACTING_TEXT, filename }))
      const ocrResult = await runOcr(filename)

      setState((prev) => ({
        ...prev,
        stage: STAGES.CLASSIFYING,
        ocrText: ocrResult.extracted_text,
      }))
      const classification = await classifyDocument(filename)

      // Checked before the extraction call, not after its 422 comes back:
      // the answer is already known here, and a request whose only
      // possible outcome is a rejection is one that shouldn't be sent.
      if (classification.document_type === UNKNOWN_TYPE) {
        setState((prev) => ({
          ...prev,
          stage: STAGES.UNSUPPORTED,
          documentType: classification.document_type,
          confidence: classification.confidence,
        }))
        return
      }

      setState((prev) => ({
        ...prev,
        stage: STAGES.EXTRACTING_FIELDS,
        documentType: classification.document_type,
        confidence: classification.confidence,
      }))
      const fields = await extractFields(filename, classification.document_type)

      setState((prev) => ({ ...prev, stage: STAGES.DONE, fields }))
    } catch (error) {
      setState((prev) => ({
        ...prev,
        stage: STAGES.ERROR,
        error: extractErrorMessage(error, 'Something went wrong while processing the document.'),
      }))
    }
  }, [])

  return { ...state, run, reset, extractAs }
}
