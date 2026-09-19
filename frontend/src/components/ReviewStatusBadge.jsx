/**
 * Shows where a document sits in the review workflow, as a chip.
 *
 * Lifted out of ReviewPage (where it started as a local helper) once the
 * documents list needed the same badge in a table column — a reviewer
 * scanning the list and a reviewer on the review screen should not have
 * to work out that two differently-styled labels mean the same thing.
 *
 * Three states now, mirroring `backend/core/review_status.py`: pending,
 * reviewed, and rejected. The two terminal states get opposite colors
 * and distinct icons rather than colors alone — green-vs-red is the
 * single most common pairing to be indistinguishable to a colorblind
 * reader, and this chip is often the only thing separating two otherwise
 * identical table rows.
 *
 * `reviewedAt` is optional: the list shows the bare status (the table has
 * its own timestamp column), while the review screen passes the
 * timestamp so a decision says *when*.
 */
import { Chip, Tooltip } from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import CancelIcon from '@mui/icons-material/Cancel'
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty'
import { REVIEW_STATUS } from '../utils/reviewStatus'

const STATUS_STYLES = {
  [REVIEW_STATUS.REVIEWED]: { color: 'success', icon: CheckCircleIcon },
  [REVIEW_STATUS.REJECTED]: { color: 'error', icon: CancelIcon },
  [REVIEW_STATUS.PENDING]: { color: 'default', icon: HourglassEmptyIcon },
}

export default function ReviewStatusBadge({ status, reviewedAt, size = 'small' }) {
  const { color, icon: Icon } = STATUS_STYLES[status] ?? STATUS_STYLES[REVIEW_STATUS.PENDING]
  const isDecided = status === REVIEW_STATUS.REVIEWED || status === REVIEW_STATUS.REJECTED

  const chip = (
    <Chip
      icon={<Icon />}
      label={status}
      size={size}
      color={color}
      variant="outlined"
      sx={{ fontWeight: 600 }}
    />
  )

  // The timestamp goes in a tooltip rather than into the label: inline,
  // it doubles the chip's width and wrecks the alignment of a table
  // column whose other rows are two words long.
  if (!isDecided || !reviewedAt) return chip

  return (
    <Tooltip title={`Last decided ${new Date(reviewedAt).toLocaleString()}`}>
      <span>{chip}</span>
    </Tooltip>
  )
}
