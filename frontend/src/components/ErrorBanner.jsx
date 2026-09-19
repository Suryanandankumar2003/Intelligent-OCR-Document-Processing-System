/**
 * A dismissible inline alert for failures the user has to act on.
 *
 * Shows the exact message the failing backend call returned (see
 * `api/errorMessage.js`) rather than a generic "something went wrong" —
 * the FastAPI backend's error responses are already written to be read
 * by a human (e.g. "File exceeds the maximum allowed size of 10 MB.",
 * see backend/core/exceptions.py), so reproducing that wording here
 * would only make it worse.
 *
 * Inline and persistent, deliberately not a snackbar. A toast vanishes
 * on a timer and can't be re-read, which is fine for "Saved" and wrong
 * for a rejected correction the reviewer still has to fix — they need
 * the reason on screen while they retype the field. The two coexist
 * across this app: the snackbar acknowledges, this explains.
 */
import { Alert, AlertTitle } from '@mui/material'

export default function ErrorBanner({ message, title, onDismiss, severity = 'error', sx }) {
  return (
    <Alert
      severity={severity}
      // Dismissal is optional: an error the user can recover from
      // (a rejected correction they can retype) is dismissible, while
      // one that leaves the screen with nothing to show is not — a ×
      // that clears the only thing on the page is a dead end.
      onClose={onDismiss}
      sx={{ ...sx }}
    >
      {title && <AlertTitle>{title}</AlertTitle>}
      {message}
    </Alert>
  )
}
