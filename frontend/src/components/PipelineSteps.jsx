/**
 * Renders the pipeline's four stages as a vertical stepper, so the user
 * sees exactly what's happening (uploading vs. waiting on OCR vs.
 * waiting on classification vs. waiting on extraction) instead of one
 * opaque spinner for however long the whole thing takes.
 *
 * Each step's visual status (done / active / error / pending) is
 * derived purely from comparing its position in STEP_ORDER to the
 * current `stage` — there's no separate "status per step" state to
 * keep in sync by hand, so it can never drift out of sync with the
 * actual pipeline state in useDocumentPipeline.
 */
import ProgressBar from './ProgressBar'
import { STAGES } from '../hooks/useDocumentPipeline'
import './PipelineSteps.css'

const STEP_ORDER = [
  { stage: STAGES.UPLOADING, label: 'Upload' },
  { stage: STAGES.EXTRACTING_TEXT, label: 'Extract text (OCR)' },
  { stage: STAGES.CLASSIFYING, label: 'Classify document type' },
  { stage: STAGES.EXTRACTING_FIELDS, label: 'Extract fields' },
]

export default function PipelineSteps({ stage, uploadProgress }) {
  const activeIndex = STEP_ORDER.findIndex((step) => step.stage === stage)
  const isDone = stage === STAGES.DONE
  const isError = stage === STAGES.ERROR

  return (
    <ol className="pipeline-steps">
      {STEP_ORDER.map((step, index) => {
        let status = 'pending'
        if (isDone || index < activeIndex) status = 'done'
        else if (index === activeIndex) status = isError ? 'error' : 'active'

        return (
          <li key={step.stage} className={`pipeline-steps__item pipeline-steps__item--${status}`}>
            <span className="pipeline-steps__marker" aria-hidden="true">
              {status === 'done' ? '✓' : index + 1}
            </span>
            <span className="pipeline-steps__label">{step.label}</span>
            {step.stage === STAGES.UPLOADING && status === 'active' && (
              <ProgressBar percent={uploadProgress} label={`${uploadProgress}%`} />
            )}
          </li>
        )
      })}
    </ol>
  )
}
