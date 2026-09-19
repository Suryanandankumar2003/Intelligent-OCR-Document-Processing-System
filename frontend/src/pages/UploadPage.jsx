/**
 * The processing screen: pick a file, upload & process it, see the
 * results, and link on to the review screen to correct them. Owns
 * exactly two pieces of state:
 *
 *   1. `selectedFile` — the File object the user picked, before
 *      anything has been sent anywhere.
 *   2. `useDocumentPipeline()` — everything about the in-flight/finished
 *      upload -> OCR -> classify -> extract chain (see
 *      src/hooks/useDocumentPipeline.js for why that's a separate hook
 *      rather than inlined here).
 *
 * Every component below this one is presentation-only — FileSelect,
 * PipelineSteps, ErrorBanner, and ResultsPanel all take plain props and
 * hold no pipeline state of their own. This is the only component that
 * decides *when* things happen; the rest just render whatever they're
 * told.
 *
 * The snackbars here are outcome notices only ("Extracted 6 fields",
 * "Processing failed"). The failure *reason* still renders inline where
 * the user is working, because a toast can't be re-read while they fix
 * it — see `components/ErrorBanner.jsx`.
 */
import { useEffect, useRef, useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { Box, Button, Card, CardContent, CircularProgress, Stack, Typography } from '@mui/material'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import FactCheckIcon from '@mui/icons-material/FactCheck'
import PageHeader from '../components/common/PageHeader'
import FileSelect from '../components/FileSelect'
import PipelineSteps from '../components/PipelineSteps'
import ErrorBanner from '../components/ErrorBanner'
import ResultsPanel from '../components/ResultsPanel'
import UnsupportedDocumentPanel from '../components/UnsupportedDocumentPanel'
import { useNotify } from '../components/feedback/snackbarContext'
import { useDocumentPipeline, STAGES } from '../hooks/useDocumentPipeline'

export default function UploadPage() {
  const [selectedFile, setSelectedFile] = useState(null)
  const pipeline = useDocumentPipeline()
  const notify = useNotify()

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

  const isFinished = pipeline.stage === STAGES.DONE || pipeline.stage === STAGES.UNSUPPORTED

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', py: { xs: 2, md: 3 } }}>
      <PageHeader
        title="Process a document"
        description="Upload a PAN card, Aadhaar card, invoice, prescription, or test report form. The pipeline transcribes it, identifies its type, and extracts its structured fields."
        actions={
          isFinished ? (
            <Button
              variant="outlined"
              color="inherit"
              startIcon={<RestartAltIcon />}
              onClick={handleReset}
            >
              Process another
            </Button>
          ) : null
        }
      />

      <Stack spacing={2.5}>
        <Card>
          <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography variant="h4" component="h2" sx={{ mb: 2 }}>
              1. Choose a document
            </Typography>

            <FileSelect
              selectedFile={selectedFile}
              onFileSelect={handleFileSelect}
              disabled={isProcessing}
            />

            <Button
              variant="contained"
              size="large"
              onClick={handleUpload}
              disabled={!selectedFile || isProcessing}
              startIcon={
                isProcessing ? <CircularProgress size={16} color="inherit" /> : <PlayArrowIcon />
              }
              sx={{ mt: 2.5 }}
            >
              {isProcessing ? 'Processing…' : 'Upload & process'}
            </Button>

            {pipeline.stage !== STAGES.IDLE && (
              <Box sx={{ mt: 3 }}>
                <PipelineSteps stage={pipeline.stage} uploadProgress={pipeline.uploadProgress} />
              </Box>
            )}

            {pipeline.stage === STAGES.ERROR && (
              <ErrorBanner
                message={pipeline.error}
                title="Processing failed"
                onDismiss={pipeline.reset}
                sx={{ mt: 2.5 }}
              />
            )}
          </CardContent>
        </Card>

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
                      2. Verify the extracted data
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
