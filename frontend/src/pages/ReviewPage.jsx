/**
 * The document review screen: the workflow step between "the model read
 * this document" and "this data is good enough to use".
 *
 * Addressed by URL — `/documents/:filename/review` — and built entirely
 * from `GET /documents/{filename}/review`, keyed by that filename alone.
 * Nothing it needs comes from the screen the reviewer arrived from, which
 * is what makes it survive a refresh, a bookmark, a shared link, or a
 * visit days after the document was processed.
 *
 * Two things do ride along in router state, and both are strictly
 * optional — the screen renders correctly when they're absent (which is
 * exactly what a refresh produces):
 *
 *   * `ocrText` — the pipeline's transcript, when the reviewer came
 *     straight from processing. The transcript is stored server-side too
 *     (`documents.ocr_text`) and arrives with the review payload, so this
 *     is only a fallback for documents processed before that column
 *     existed.
 *   * `backTo` — the filtered documents URL to return to, so Back lands
 *     on the page of the list the reviewer left. Falls back to the plain
 *     list.
 *
 * --- The layout -------------------------------------------------------
 *
 * Source on the left, fields on the right, decisions across the bottom.
 * That arrangement is the entire job of this screen: checking an
 * extracted value means reading it against the text it came from, and
 * anything that makes the reviewer scroll between the two — stacking
 * them, or hiding the transcript behind a toggle — turns one glance into
 * a round trip, per field, per document.
 *
 * Below `lg` the two panes stack (transcript first), because side by
 * side at that width gives neither pane enough room to read. The action
 * bar stays stuck to the bottom in both arrangements.
 *
 * Server state lives in `useDocumentReview` and the edit buffer in
 * `useReviewDraft`; this file decides what to show for each state and
 * wires the three actions together.
 */
import { Link as RouterLink, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Box, Breadcrumbs, Button, Card, CardContent, Link, Stack, Typography } from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import CorrectionHistory from '../components/CorrectionHistory'
import DocumentReviewForm from '../components/DocumentReviewForm'
import DocumentTypeBadge from '../components/DocumentTypeBadge'
import ErrorBanner from '../components/ErrorBanner'
import OcrTextPanel from '../components/OcrTextPanel'
import ReviewActionBar from '../components/ReviewActionBar'
import ReviewStatusBadge from '../components/ReviewStatusBadge'
import { ReviewSkeleton } from '../components/common/Skeletons'
import { useNotify } from '../components/feedback/snackbarContext'
import { useDocumentReview } from '../hooks/useDocumentReview'
import { useReviewDraft } from '../hooks/useReviewDraft'
import { MONO_FAMILY } from '../theme/theme'

/**
 * The editable half plus its actions.
 *
 * Split into its own component for one specific reason: `useReviewDraft`
 * initializes from `reviewedData`, which doesn't exist until the load
 * finishes. Calling it in `ReviewPage` would mean either calling a hook
 * conditionally (illegal) or seeding it with a placeholder and resetting
 * later (a flash of empty inputs). Mounting this only once the data is
 * there sidesteps both.
 */
function ReviewEditor({ review, isSaving, pendingDecision, onSave, onDecide, backTo }) {
  const { fields, editedFields, setFieldText, discard, changedFields } = useReviewDraft(
    review.original_data,
    review.reviewed_data,
  )
  const navigate = useNavigate()
  const notify = useNotify()

  const isBusy = isSaving || pendingDecision !== null

  const handleSave = async () => {
    if (editedFields.length === 0 || isBusy) return false
    const saved = await onSave(changedFields())
    if (saved)
      notify.success(
        `Saved ${editedFields.length === 1 ? '1 correction' : `${editedFields.length} corrections`}.`,
      )
    return saved
  }

  /**
   * Approve saves first when there are unsaved edits.
   *
   * The decision endpoint records a verdict on the values the *server*
   * holds, so approving with edits still in the inputs would sign off on
   * the un-edited data and silently drop the reviewer's work. If that
   * save fails, the approval is abandoned — its error is already on
   * screen, and approving anyway would mean recording a verdict on data
   * the reviewer just tried and failed to change.
   */
  const handleApprove = async () => {
    if (isBusy) return
    if (editedFields.length > 0 && !(await handleSave())) return
    if (await onDecide('approve')) {
      notify.success('Document approved.')
      navigate(backTo)
    }
  }

  const handleReject = async () => {
    if (isBusy) return
    if (await onDecide('reject')) {
      notify.warning('Document rejected.')
      navigate(backTo)
    }
  }

  return (
    <>
      <Card sx={{ display: 'flex', flexDirection: 'column' }}>
        <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
          <Typography variant="h4" component="h3" sx={{ mb: 0.5 }}>
            Extracted fields
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
            Every field is editable. Saved corrections are kept alongside the original values, never
            on top of them.
          </Typography>

          <DocumentReviewForm fields={fields} onFieldChange={setFieldText} disabled={isBusy} />

          <Box sx={{ mt: 3 }}>
            <CorrectionHistory corrections={review.corrections} />
          </Box>
        </CardContent>
      </Card>

      {/* Spans both columns of the parent grid — the decisions are about
          the document, not about either pane. */}
      <Box sx={{ gridColumn: { lg: '1 / -1' } }}>
        <ReviewActionBar
          editedCount={editedFields.length}
          isSaving={isSaving}
          pendingDecision={pendingDecision}
          reviewStatus={review.review_status}
          onSave={handleSave}
          onDiscard={discard}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      </Box>
    </>
  )
}

export default function ReviewPage() {
  const { filename } = useParams()
  const location = useLocation()
  const { ocrText: handedOverOcrText, backTo } = location.state ?? {}
  const { review, isLoading, isSaving, pendingDecision, error, save, decide, dismissError } =
    useDocumentReview(filename)

  // The stored transcript wins over the one handed over in router state:
  // both are the same text for a document processed just now, and only
  // the stored one is there after a refresh.
  const ocrText = review?.ocr_text ?? handedOverOcrText
  const returnTo = backTo ?? '/documents'

  return (
    <Box sx={{ maxWidth: 1500, mx: 'auto', py: { xs: 2, md: 3 } }}>
      <Breadcrumbs sx={{ mb: 1.5 }}>
        <Link
          component={RouterLink}
          to={returnTo}
          underline="hover"
          color="inherit"
          variant="body2"
        >
          Documents
        </Link>
        <Typography variant="body2" color="text.primary">
          Review
        </Typography>
      </Breadcrumbs>

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ alignItems: { sm: 'flex-start' }, justifyContent: 'space-between', mb: 3 }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h2" component="h2" sx={{ mb: 0.75 }}>
            Review &amp; correct
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontFamily: MONO_FAMILY, wordBreak: 'break-all' }}
          >
            {filename}
          </Typography>
        </Box>

        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: 'center', flexWrap: 'wrap' }}
        >
          {review && (
            <>
              <DocumentTypeBadge documentType={review.document_type} />
              <ReviewStatusBadge status={review.review_status} reviewedAt={review.reviewed_at} />
            </>
          )}
          <Button
            component={RouterLink}
            to={returnTo}
            size="small"
            color="inherit"
            startIcon={<ArrowBackIcon />}
          >
            Back
          </Button>
        </Stack>
      </Stack>

      {/* Above the panes rather than replacing them: a rejected
          correction (an invalid PAN, say) needs the reviewer's edits
          still on screen to be fixable. Only dismissible when there is a
          form underneath to go back to — if the document itself failed
          to load, this message is the whole screen. */}
      {error && (
        <ErrorBanner
          message={error}
          onDismiss={review ? dismissError : undefined}
          sx={{ mb: 2.5 }}
        />
      )}

      {isLoading && <ReviewSkeleton />}

      {!isLoading && review && (
        <Box
          sx={{
            display: 'grid',
            gap: 2.5,
            // Source left, fields right — see the file docstring. Stacks
            // below `lg`, transcript first, because that's the reading
            // order the side-by-side layout also has.
            gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) minmax(0, 1fr)' },
            alignItems: 'start',
          }}
        >
          {/* Sticky, and capped to the viewport. Both matter together:
              a sticky pane taller than the screen can never scroll to
              its own bottom, so the cap is what turns "the transcript
              follows you down the form" into something usable rather
              than a pane whose last paragraph is unreachable. The
              transcript scrolls inside itself instead (`fill`). `top`
              clears the fixed navbar. */}
          <Card
            sx={{
              position: { lg: 'sticky' },
              top: { lg: 88 },
              maxHeight: { lg: 'calc(100vh - 112px)' },
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <CardContent
              sx={{
                p: { xs: 2, sm: 3 },
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                flex: 1,
              }}
            >
              {ocrText ? (
                <OcrTextPanel
                  text={ocrText}
                  title="Original OCR text"
                  downloadName={`${filename}.txt`}
                  fill
                  minHeight={280}
                />
              ) : (
                <>
                  <Typography variant="h4" component="h3" sx={{ mb: 1 }}>
                    Original OCR text
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    No transcript was stored for this document. It was processed before OCR text
                    began being saved, so the fields on the right are all that remains of it.
                  </Typography>
                </>
              )}
            </CardContent>
          </Card>

          <ReviewEditor
            review={review}
            isSaving={isSaving}
            pendingDecision={pendingDecision}
            onSave={save}
            onDecide={decide}
            backTo={returnTo}
          />
        </Box>
      )}
    </Box>
  )
}
