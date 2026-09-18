/**
 * The processing screen: pick a file, upload & process it, see the
 * results, and hand off to the review screen (`onReview`) to correct
 * them. Owns exactly two pieces of state:
 *
 *   1. `selectedFile` — the File object the user picked, before
 *      anything has been sent anywhere.
 *   2. `useDocumentPipeline()` — everything about the in-flight/finished
 *      upload -> OCR -> classify -> extract chain (see
 *      src/hooks/useDocumentPipeline.js for why that's a separate hook
 *      rather than inlined here).
 *
 * Every component below this one is presentation-only — FileSelect,
 * UploadButton, PipelineSteps, ErrorBanner, and ResultsPanel all take
 * plain props and hold no pipeline state of their own. This is the only
 * component that decides *when* things happen; the rest just render
 * whatever they're told.
 */
import { useState } from 'react'
import FileSelect from '../components/FileSelect'
import UploadButton from '../components/UploadButton'
import PipelineSteps from '../components/PipelineSteps'
import ErrorBanner from '../components/ErrorBanner'
import ResultsPanel from '../components/ResultsPanel'
import { useDocumentPipeline, STAGES } from '../hooks/useDocumentPipeline'
import './UploadPage.css'

export default function UploadPage({ onReview }) {
  const [selectedFile, setSelectedFile] = useState(null)
  const pipeline = useDocumentPipeline()

  const isProcessing =
    pipeline.stage !== STAGES.IDLE && pipeline.stage !== STAGES.DONE && pipeline.stage !== STAGES.ERROR

  // Picking a new file while a previous result is still on screen
  // clears that result — showing PAN card fields next to a freshly
  // selected invoice would be misleading, even briefly.
  const handleFileSelect = (file) => {
    setSelectedFile(file)
    pipeline.reset()
  }

  const handleUpload = () => {
    if (selectedFile && !isProcessing) pipeline.run(selectedFile)
  }

  return (
    <div className="upload-page">
      <section className="upload-page__panel">
        <h2 className="upload-page__heading">1. Choose a document</h2>

        <FileSelect selectedFile={selectedFile} onFileSelect={handleFileSelect} disabled={isProcessing} />

        <UploadButton
          onClick={handleUpload}
          disabled={!selectedFile || isProcessing}
          isLoading={isProcessing}
        />

        {pipeline.stage !== STAGES.IDLE && (
          <PipelineSteps stage={pipeline.stage} uploadProgress={pipeline.uploadProgress} />
        )}

        {pipeline.stage === STAGES.ERROR && (
          <ErrorBanner message={pipeline.error} onDismiss={pipeline.reset} />
        )}
      </section>

      {pipeline.stage === STAGES.DONE && (
        <>
          <ResultsPanel
            documentType={pipeline.documentType}
            confidence={pipeline.confidence}
            ocrText={pipeline.ocrText}
            fields={pipeline.fields}
          />

          {/* Extraction is a machine's best guess, so the pipeline ends
              by offering the next workflow step rather than presenting
              the result as final. */}
          <section className="upload-page__panel upload-page__next">
            <div>
              <h2 className="upload-page__heading">3. Verify the extracted data</h2>
              <p className="upload-page__next-hint">
                Check each field against the document and correct anything the model got wrong.
              </p>
            </div>
            <button
              type="button"
              className="upload-page__review-button"
              onClick={() => onReview(pipeline.filename, pipeline.ocrText)}
            >
              Review &amp; correct fields
            </button>
          </section>
        </>
      )}
    </div>
  )
}
