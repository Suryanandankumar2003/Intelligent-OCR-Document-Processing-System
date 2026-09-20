/**
 * The batch and batch-file status vocabularies, mirroring
 * `backend/core/batch_status.py`.
 *
 * Written out here rather than derived from whatever the API last
 * returned, for the same reason `utils/reviewStatus.js` is: the status
 * filters have to offer every status, including the ones that happen to
 * have no batches in them right now. A dropdown built from the loaded
 * page can only offer what is already on screen, which makes "show me
 * the failed ones" disappear exactly when there are none visible — the
 * moment it is most useful to be able to ask.
 *
 * --- Why a batch has five states and a file has four ----------------
 *
 * Because a batch of 100 files where 3 failed is neither completed nor
 * failed. `PARTIALLY_COMPLETED` is the single most common real outcome
 * of bulk processing, and the backend models it as its own state rather
 * than forcing it to be spelled as a lie in one direction. The UI has to
 * carry that distinction through, or it undoes the whole point: a
 * partially completed batch is the one an operator has to *do*
 * something about.
 */

export const BATCH_STATUS = {
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  PARTIALLY_COMPLETED: 'Partially Completed',
}

export const BATCH_STATUSES = Object.values(BATCH_STATUS)

export const BATCH_FILE_STATUS = {
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  SUCCESS: 'Success',
  FAILED: 'Failed',
}

export const BATCH_FILE_STATUSES = Object.values(BATCH_FILE_STATUS)

/**
 * Whether a batch still has work queued or in flight.
 *
 * The single predicate behind three behaviours that must agree: whether
 * to hold the progress stream open, whether the list keeps refreshing
 * itself, and whether the details page shows a live progress bar. If
 * these three ever disagreed about "still running", the UI would show a
 * finished batch with a moving progress bar, or the reverse.
 *
 * Note that a terminal status is not permanent — retrying failed files
 * moves a batch back to `Processing` — which is exactly why this is a
 * question asked of the current status on every update rather than a
 * flag latched once.
 */
export function isBatchActive(status) {
  return status === BATCH_STATUS.PENDING || status === BATCH_STATUS.PROCESSING
}

/** Whether a *file* has reached an outcome. Used to decide if a row can offer a retry. */
export function isFileFinished(status) {
  return status === BATCH_FILE_STATUS.SUCCESS || status === BATCH_FILE_STATUS.FAILED
}

/**
 * "12 of 500 files" style text for a batch's counters.
 *
 * Here rather than inline in the two components that show it, because
 * the pluralisation and the thousands separators are the kind of detail
 * that quietly diverges between a list row and a details header.
 */
export function formatFileCount(count) {
  return `${count.toLocaleString()} file${count === 1 ? '' : 's'}`
}
