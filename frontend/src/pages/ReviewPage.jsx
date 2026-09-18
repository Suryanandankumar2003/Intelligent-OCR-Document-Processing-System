/**
 * The document review screen: the workflow step between "the model read
 * this document" and "this data is good enough to use".
 *
 * A screen of its own rather than an editable block on the upload page,
 * because reviewing is a separate job from processing — often a
 * different person, often later. Everything it shows comes from
 * `GET /documents/{filename}/review` keyed by filename alone, so it
 * stands up on its own: nothing here depends on the upload that
 * produced the document still being in memory. (The OCR text is the one
 * exception — it isn't persisted, so it's passed in when the reviewer
 * arrives straight from the pipeline and simply omitted otherwise.)
 *
 * State lives in `useDocumentReview`; this file decides what to show for
 * each of its four states — loading, failed-to-load, loaded, saving —
 * and nothing else.
 */
import CorrectionHistory from '../components/CorrectionHistory'
import DocumentReviewForm from '../components/DocumentReviewForm'
import DocumentTypeBadge from '../components/DocumentTypeBadge'
import ErrorBanner from '../components/ErrorBanner'
import OcrTextPanel from '../components/OcrTextPanel'
import { useDocumentReview } from '../hooks/useDocumentReview'
import './ReviewPage.css'

function ReviewStatusBadge({ status, reviewedAt }) {
  const isReviewed = status === 'Reviewed'
  return (
    <span className={`review-status${isReviewed ? ' review-status--done' : ''}`}>
      {status}
      {isReviewed && reviewedAt && (
        <span className="review-status__time">{new Date(reviewedAt).toLocaleString()}</span>
      )}
    </span>
  )
}

export default function ReviewPage({ filename, ocrText, onBack }) {
  const { review, isLoading, isSaving, error, save, dismissError } = useDocumentReview(filename)

  return (
    <div className="review-page">
      <button type="button" className="review-page__back" onClick={onBack}>
        ← Process another document
      </button>

      <section className="review-page__panel">
        <header className="review-page__header">
          <div>
            <h2 className="review-page__heading">Review &amp; correct</h2>
            <p className="review-page__hint">
              Every extracted field is editable. Saved corrections are kept alongside the original values,
              never on top of them.
            </p>
          </div>
          {review && (
            <div className="review-page__badges">
              <DocumentTypeBadge documentType={review.document_type} />
              <ReviewStatusBadge status={review.review_status} reviewedAt={review.reviewed_at} />
            </div>
          )}
        </header>

        {/* Shown above the form rather than replacing it: a rejected
            correction (an invalid PAN, say) needs the reviewer's edits
            still on screen to be fixable. Only dismissible when there
            is a form underneath to go back to — if the document itself
            failed to load, this message is the whole screen. */}
        {error && <ErrorBanner message={error} onDismiss={review ? dismissError : undefined} />}

        {isLoading && <p className="review-page__loading">Loading document…</p>}

        {!isLoading && review && (
          <>
            <DocumentReviewForm
              originalData={review.original_data}
              reviewedData={review.reviewed_data}
              isSaving={isSaving}
              onSave={save}
            />
            <CorrectionHistory corrections={review.corrections} />
          </>
        )}
      </section>

      {ocrText && (
        <section className="review-page__panel">
          <OcrTextPanel text={ocrText} />
        </section>
      )}
    </div>
  )
}
