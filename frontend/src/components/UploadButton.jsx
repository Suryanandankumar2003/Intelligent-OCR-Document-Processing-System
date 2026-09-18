/**
 * The single call-to-action that kicks off the pipeline.
 *
 * Deliberately stateless — its label and disabled state are entirely
 * driven by props from UploadPage (which owns the actual pipeline
 * state via useDocumentPipeline). That makes this component trivial to
 * reason about and reuse: it has no idea what "processing" means, it
 * just renders whatever isLoading/disabled it was given.
 */
import './UploadButton.css'

export default function UploadButton({ onClick, disabled, isLoading }) {
  return (
    <button type="button" className="upload-button" onClick={onClick} disabled={disabled}>
      {isLoading ? (
        <>
          <span className="upload-button__spinner" aria-hidden="true" />
          Processing…
        </>
      ) : (
        'Upload & Process'
      )}
    </button>
  )
}
