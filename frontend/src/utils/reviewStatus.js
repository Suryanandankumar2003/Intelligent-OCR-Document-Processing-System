/**
 * The review workflow's states, as the API spells them.
 *
 * A mirror of `backend/core/review_status.py` — the values are compared
 * against and sent to the backend verbatim, so they are the API's
 * strings, not display labels that happen to match.
 *
 * Hardcoded rather than fetched, unlike the document-type list: this set
 * is closed and three items long, and a status filter whose options
 * appeared and disappeared depending on what happened to be in the table
 * would be worse than one that is always there.
 */
export const REVIEW_STATUSES = ['Pending Review', 'Reviewed', 'Rejected']

export const REVIEW_STATUS = {
  PENDING: 'Pending Review',
  REVIEWED: 'Reviewed',
  REJECTED: 'Rejected',
}
