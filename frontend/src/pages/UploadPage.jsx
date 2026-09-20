/**
 * The processing screen: the two ways to put documents into the system,
 * side by side — one document on the left, a batch of them on the right.
 *
 * --- Why they share a screen -----------------------------------------
 *
 * Because they are the same decision, not two features. Someone arriving
 * with work to do is choosing between "I have this one scan" and "I have
 * this folder", and that choice is easier to make when both options are
 * visible at once than when one of them is behind a different sidebar
 * entry they have to know exists. The batch *history* is still its own
 * screen (`/batches`), because reviewing what happened is a different
 * task from starting something new — the panel on the right links to it.
 *
 * --- Layout ----------------------------------------------------------
 *
 * Two equal columns from `lg` up, stacked below it, with the single-file
 * column first in the DOM so a narrow screen and a screen reader both get
 * the simpler option first.
 *
 * The single-document *results* deliberately break out of the column and
 * render full width underneath. A results panel carrying a transcript and
 * a field table is unreadable at half width, and by the time it exists
 * the two-column choice has already been made — so the layout stops
 * paying for it.
 *
 * --- State -----------------------------------------------------------
 *
 * The left column owns `selectedFile` plus `useDocumentPipeline()`; the
 * right column owns its own upload state inside `BatchUploadPanel`. The
 * two never interact, which is what lets someone kick off a 300-file
 * batch and then carry on processing a single urgent document while it
 * runs.
 *
 * The snackbars here are outcome notices only ("Extracted 6 fields",
 * "Processing failed"). The failure *reason* still renders inline where
 * the user is working, because a toast can't be re-read while they fix
 * it — see `components/ErrorBanner.jsx`.
 */
import { useEffect, useRef, useState } from 'react'
import { Link as RouterLink, useNavigate } from 'react-router-dom'
import {
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  Typography,
} from '@mui/material'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import FactCheckIcon from '@mui/icons-material/FactCheck'
import HistoryIcon from '@mui/icons-material/History'
import PageHeader from '../components/common/PageHeader'
import FileSelect from '../components/FileSelect'
import PipelineSteps from '../components/PipelineSteps'
import ErrorBanner from '../components/ErrorBanner'
import ResultsPanel from '../components/ResultsPanel'
import UnsupportedDocumentPanel from '../components/UnsupportedDocumentPanel'
import BatchUploadPanel from '../components/batch/BatchUploadPanel'
import { useNotify } from '../components/feedback/snackbarContext'
import { useDocumentPipeline, STAGES } from '../hooks/useDocumentPipeline'
import { formatFileCount } from '../utils/batchStatus'

export default function UploadPage() {
  const [selectedFile, setSelectedFile] = useState(null)
  const pipeline = useDocumentPipeline()
  const notify = useNotify()
  const navigate = useNavigate()

  const isProcessing =
    pipeline.stage !== STAGES.IDLE &&
    pipeline.stage !== STAGES.DONE &&
    pipeline.stage !== STAGES.ERROR

  // Fires the toast once per *transition* into a terminal stage, not on
  // every render while sitting in one. Without the ref this would
  // re-notify on any unrelated re-render (a theme change, a resize)
  // because the stage hasn't moved.
  const lastNotifiedStage = useRef(pipeline.stage)
  useEffect(() => {
    if (lastNotifiedStage.current === pipeline.stage) return
    lastNotifiedStage.current = pipeline.stage

    if (pipeline.stage === STAGES.DONE) {
      const fieldCount = Object.keys(pipeline.fields ?? {}).length
      notify.success(`${pipeline.documentType} processed — ${fieldCount} fields extracted.`)
    } else if (pipeline.stage === STAGES.ERROR) {
      notify.error('Processing failed. See the details on the page.')
    } else if (pipeline.stage === STAGES.UNSUPPORTED) {
      notify.warning('Document type could not be identified.')
    }
  }, [pipeline.stage, pipeline.fields, pipeline.documentType, notify])

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

  const handleReset = () => {
    setSelectedFile(null)
    pipeline.reset()
  }

  /**
   * A batch has been accepted by the server. Straight to its own page:
   * it is the only screen with a live progress feed, and it is what
   * someone who just uploaded 300 files wants to look at.
   */
  const handleBatchUploaded = (batch) => {
    if (batch.rejected.length > 0) {
      notify.warning(
        `${batch.total_files} file${batch.total_files === 1 ? '' : 's'} queued — ${batch.rejected.length} skipped. Details on the batch page.`,
      )
    } else {
      notify.success(`${formatFileCount(batch.total_files)} queued for processing.`)
    }
    navigate(`/batches/${encodeURIComponent(batch.batch_id)}`, { state: { backTo: '/' } })
  }

  const isFinished = pipeline.stage === STAGES.DONE || pipeline.stage === STAGES.UNSUPPORTED

  return (
    <Box sx={{ maxWidth: 1500, mx: 'auto', py: { xs: 2, md: 3 } }}>
      <PageHeader
        title="Process documents"
        description="Run one document through the pipeline and see the result immediately, or upload a whole batch and let it process in the background. Both take PAN cards, Aadhaar cards, invoices, prescriptions, and test report forms."
        actions={
          <>
            <Button
              component={RouterLink}
              to="/batches"
              variant="outlined"
              color="inherit"
              startIcon={<HistoryIcon />}
            >
              Batch history
            </Button>
            {isFinished && (
              <Button
                variant="outlined"
                color="inherit"
                startIcon={<RestartAltIcon />}
                onClick={handleReset}
              >
                Process another
              </Button>
            )}
          </>
        }
      />

      <Stack spacing={2.5}>
        <Box
          sx={{
            display: 'grid',
            gap: 2.5,
            // Equal columns: neither way of working is the "main" one,
            // and giving one more room would say otherwise.
            gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' },
            alignItems: 'stretch',
          }}
        >
          {/* --- Left: one document ------------------------------------ */}
          <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            <CardContent
              sx={{ p: { xs: 2, sm: 3 }, flex: 1, display: 'flex', flexDirection: 'column' }}
            >
              <Typography variant="h4" component="h2" sx={{ mb: 0.5 }}>
                One document
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Upload a single file and watch it move through OCR, classification, and
                extraction. The results appear below.
              </Typography>

              <Stack spacing={2} sx={{ flex: 1 }}>
                <FileSelect
                  selectedFile={selectedFile}
                  onFileSelect={handleFileSelect}
                  disabled={isProcessing}
                />

                {pipeline.stage !== STAGES.IDLE && (
                  <PipelineSteps stage={pipeline.stage} uploadProgress={pipeline.uploadProgress} />
                )}

                {pipeline.stage === STAGES.ERROR && (
                  <ErrorBanner
                    message={pipeline.error}
                    title="Processing failed"
                    onDismiss={pipeline.reset}
                  />
                )}

                {/* Pinned to the bottom so both columns' primary buttons
                    sit on the same line despite different content heights. */}
                <Box sx={{ mt: 'auto', pt: 1 }}>
                  <Button
                    variant="contained"
                    size="large"
                    onClick={handleUpload}
                    disabled={!selectedFile || isProcessing}
                    startIcon={
                      isProcessing ? (
                        <CircularProgress size={16} color="inherit" />
                      ) : (
                        <PlayArrowIcon />
                      )
                    }
                  >
                    {isProcessing ? 'Processing…' : 'Upload & process'}
                  </Button>
                </Box>
              </Stack>
            </CardContent>
          </Card>

          {/* --- Right: many documents --------------------------------- */}
          <BatchUploadPanel onUploaded={handleBatchUploaded} />
        </Box>

        {/* An unsupported document isn't an error and isn't a result, so it
            gets neither of their panels. `isExtracting` is read from the
            stage rather than tracked separately: a manual extraction moves
            the pipeline to EXTRACTING_FIELDS, and this panel stays mounted
            (with its selector disabled) until that either finishes or comes
            back here with a message. */}
        {(pipeline.stage === STAGES.UNSUPPORTED ||
          (pipeline.isManualExtraction && pipeline.stage === STAGES.EXTRACTING_FIELDS)) && (
          <UnsupportedDocumentPanel
            filename={pipeline.filename}
            ocrText={pipeline.ocrText}
            error={pipeline.error}
            isExtracting={pipeline.stage === STAGES.EXTRACTING_FIELDS}
            onExtractAs={pipeline.extractAs}
          />
        )}

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
            <Card>
              <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={2}
                  sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}
                >
                  <Box>
                    <Typography variant="h4" component="h2" sx={{ mb: 0.5 }}>
                      Verify the extracted data
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      Check each field against the document and correct anything the model got
                      wrong.
                    </Typography>
                  </Box>

                  {/* A link to a real URL, not a callback into a parent's
                      state: the review screen is addressable on its own,
                      and this page no longer owns or lends it anything.
                      `ocrText` rides along as router state purely as a
                      bonus — the review screen loads its own copy and
                      renders fine without it. */}
                  <Button
                    component={RouterLink}
                    to={`/documents/${encodeURIComponent(pipeline.filename)}/review`}
                    state={{ ocrText: pipeline.ocrText, backTo: '/' }}
                    variant="contained"
                    startIcon={<FactCheckIcon />}
                    sx={{ flexShrink: 0 }}
                  >
                    Review &amp; correct fields
                  </Button>
                </Stack>
              </CardContent>
            </Card>
          </>
        )}
      </Stack>
    </Box>
  )
}
