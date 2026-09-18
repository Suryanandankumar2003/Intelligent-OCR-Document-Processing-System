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
  ERROR: 'error',
}

const initialState = {
  stage: STAGES.IDLE,
  uploadProgress: 0,
  filename: null,
  ocrText: null,
  documentType: null,
  confidence: null,
  fields: null,
  error: null,
}

export function useDocumentPipeline() {
  const [state, setState] = useState(initialState)

  const reset = useCallback(() => setState(initialState), [])

  const run = useCallback(async (file) => {
    setState({ ...initialState, stage: STAGES.UPLOADING })

    try {
      const uploadResult = await uploadDocument(file, {
        onUploadProgress: (percent) => setState((prev) => ({ ...prev, uploadProgress: percent })),
      })
      const { filename } = uploadResult

      setState((prev) => ({ ...prev, stage: STAGES.EXTRACTING_TEXT, filename }))
      const ocrResult = await runOcr(filename)

      setState((prev) => ({ ...prev, stage: STAGES.CLASSIFYING, ocrText: ocrResult.extracted_text }))
      const classification = await classifyDocument(filename)

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

  return { ...state, run, reset }
}
