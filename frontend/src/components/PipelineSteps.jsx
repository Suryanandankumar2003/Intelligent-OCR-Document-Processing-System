/**
 * Renders the pipeline's four stages as a stepper, so the user sees
 * exactly what's happening (uploading vs. waiting on OCR vs. waiting on
 * classification vs. waiting on extraction) instead of one opaque
 * spinner for however long the whole thing takes.
 *
 * Each step's visual status (done / active / error / skipped / pending)
 * is derived purely from comparing its position in STEP_ORDER to the
 * current `stage` — there's no separate "status per step" state to keep
 * in sync by hand, so it can never drift out of sync with the actual
 * pipeline state in useDocumentPipeline.
 *
 * MUI's `<Stepper>` handles the connector lines and the numbered
 * markers, but the icons are overridden per step: the default renders
 * every incomplete step as its index, which loses the distinction
 * between "running now", "failed here", and "skipped" that this
 * component exists to draw. Orientation switches to vertical on narrow
 * screens, where four horizontal labels would each wrap to three lines.
 */
import {
  Box,
  CircularProgress,
  LinearProgress,
  Step,
  StepLabel,
  Stepper,
  Typography,
} from '@mui/material'
import { useMediaQuery, useTheme } from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ErrorIcon from '@mui/icons-material/Error'
import RemoveCircleIcon from '@mui/icons-material/RemoveCircle'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import { STAGES } from '../hooks/useDocumentPipeline'

const STEP_ORDER = [
  { stage: STAGES.UPLOADING, label: 'Upload' },
  { stage: STAGES.EXTRACTING_TEXT, label: 'Extract text (OCR)' },
  { stage: STAGES.CLASSIFYING, label: 'Classify type' },
  { stage: STAGES.EXTRACTING_FIELDS, label: 'Extract fields' },
]

/**
 * Replaces MUI's numbered step marker.
 *
 * The default renders every incomplete step as its index, which loses
 * the three distinctions this whole component exists to draw: running
 * now, failed here, and skipped. Passed through `slots.stepIcon`, so
 * MUI's own `active`/`completed`/`icon` props also arrive here and are
 * deliberately ignored — `status` is derived from the pipeline stage in
 * one place below, and having two sources of truth for what a step looks
 * like is exactly how they drift apart.
 */
function StepIcon({ status }) {
  if (status === 'done') return <CheckCircleIcon color="success" fontSize="small" />
  if (status === 'error') return <ErrorIcon color="error" fontSize="small" />
  // A skipped step is neither a success nor a failure — an unsupported
  // document simply has no fields to extract — so it gets its own
  // neutral marker rather than borrowing either of the other two.
  if (status === 'skipped') return <RemoveCircleIcon color="disabled" fontSize="small" />
  if (status === 'active') return <CircularProgress size={18} thickness={5} />
  return <RadioButtonUncheckedIcon sx={{ color: 'action.disabled' }} fontSize="small" />
}

export default function PipelineSteps({ stage, uploadProgress }) {
  const theme = useTheme()
  const isNarrow = useMediaQuery(theme.breakpoints.down('md'))

  const isDone = stage === STAGES.DONE
  const isError = stage === STAGES.ERROR
  // An unsupported document got all the way through classification; it's
  // the *extraction* step that doesn't apply to it. Treating that stage as
  // "active at the extraction step" is what makes the marker below read
  // as skipped rather than as permanently in progress.
  const isUnsupported = stage === STAGES.UNSUPPORTED
  const activeIndex = isUnsupported
    ? STEP_ORDER.findIndex((step) => step.stage === STAGES.EXTRACTING_FIELDS)
    : STEP_ORDER.findIndex((step) => step.stage === stage)

  return (
    <Stepper
      activeStep={activeIndex}
      orientation={isNarrow ? 'vertical' : 'horizontal'}
      sx={{ '& .MuiStepConnector-line': { borderColor: 'divider' } }}
    >
      {STEP_ORDER.map((step, index) => {
        let status = 'pending'
        if (isDone || index < activeIndex) status = 'done'
        else if (index === activeIndex) {
          if (isError) status = 'error'
          else if (isUnsupported) status = 'skipped'
          else status = 'active'
        }

        return (
          <Step key={step.stage} completed={status === 'done'}>
            {/* `slots`/`slotProps`, not the old `StepIconComponent`:
                passing an inline arrow there gives the icon a new
                component identity on every render, which remounts it
                and restarts the spinner's rotation each time the upload
                percentage ticks. */}
            <StepLabel slots={{ stepIcon: StepIcon }} slotProps={{ stepIcon: { status } }}>
              <Typography
                variant="body2"
                sx={{
                  fontWeight: status === 'active' ? 650 : 500,
                  color: status === 'pending' ? 'text.disabled' : 'text.primary',
                }}
              >
                {step.label}
              </Typography>

              {/* Real byte progress from Axios, only while the upload
                  itself is in flight — the three stages after it are
                  single requests to Vertex AI with no progress to
                  report, so they get the spinner and nothing more. */}
              {step.stage === STAGES.UPLOADING && status === 'active' && (
                <Box sx={{ mt: 0.75, maxWidth: 180 }}>
                  <LinearProgress
                    variant="determinate"
                    value={Math.min(100, Math.max(0, uploadProgress))}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {uploadProgress}%
                  </Typography>
                </Box>
              )}
            </StepLabel>
          </Step>
        )
      })}
    </Stepper>
  )
}
