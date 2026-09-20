/**
 * Where a batch — or one file inside it — sits in the processing
 * workflow, as a chip.
 *
 * The same role `ReviewStatusBadge` plays for the review workflow, and
 * built the same way, so the two read as one system: outlined chip,
 * semantic color, and an icon that distinguishes each state on its own.
 * The icon is not decoration. Success-green and failure-red is the
 * single most common pairing to be indistinguishable to a colorblind
 * reader, and in a 500-row file table the chip is often the only thing
 * separating two otherwise identical rows.
 *
 * --- Why "Partially Completed" is warning-toned ----------------------
 *
 * Because it is the state that needs a person. Completed needs nobody,
 * Failed is unambiguous, and Processing resolves itself; a batch where
 * 497 of 500 files worked is the one an operator has to open, find the
 * three, and retry. Giving it the same green as Completed would hide
 * exactly the outcome the batch feature exists to surface — and giving
 * it red would say the run was a write-off, which it wasn't.
 *
 * Both vocabularies live in one component because a file's four states
 * are a subset of a batch's five in everything but name (`Success` vs
 * `Completed`), and two files that disagreed about what a Processing
 * chip looks like would be worse than one that handles both.
 */
import { Chip, CircularProgress, Tooltip } from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import CancelIcon from '@mui/icons-material/Cancel'
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlined'
import { BATCH_FILE_STATUS, BATCH_STATUS } from '../../utils/batchStatus'

/** A small spinner in the icon slot, so "Processing" is the one chip that is visibly alive. */
function SpinnerIcon() {
  return <CircularProgress size={13} thickness={5} sx={{ ml: 0.75 }} />
}

const STYLES = {
  [BATCH_STATUS.PENDING]: {
    color: 'default',
    icon: HourglassEmptyIcon,
    hint: 'Queued, waiting for a worker to pick it up.',
  },
  [BATCH_STATUS.PROCESSING]: {
    color: 'info',
    icon: SpinnerIcon,
    hint: 'Files are being processed right now.',
  },
  [BATCH_STATUS.COMPLETED]: {
    color: 'success',
    icon: CheckCircleIcon,
    hint: 'Every file finished successfully.',
  },
  [BATCH_STATUS.FAILED]: {
    color: 'error',
    icon: CancelIcon,
    hint: 'Every file failed. Retrying is usually worth a try.',
  },
  [BATCH_STATUS.PARTIALLY_COMPLETED]: {
    color: 'warning',
    icon: ErrorOutlineIcon,
    hint: 'Some files failed. Open the batch to retry just those.',
  },
  [BATCH_FILE_STATUS.SUCCESS]: {
    color: 'success',
    icon: CheckCircleIcon,
    hint: 'Processed and extracted.',
  },
}

export default function BatchStatusBadge({ status, size = 'small', showHint = true }) {
  const style = STYLES[status] ?? STYLES[BATCH_STATUS.PENDING]
  const Icon = style.icon

  const chip = (
    <Chip
      icon={<Icon />}
      label={status}
      size={size}
      color={style.color}
      variant="outlined"
      sx={{ fontWeight: 600 }}
    />
  )

  if (!showHint) return chip

  // The explanation goes in a tooltip rather than beside the chip: the
  // five statuses are not self-explanatory the first time you meet them
  // (especially "Partially Completed"), and inline they would double the
  // width of a table column whose other rows are one word.
  return (
    <Tooltip title={style.hint}>
      <span>{chip}</span>
    </Tooltip>
  )
}
