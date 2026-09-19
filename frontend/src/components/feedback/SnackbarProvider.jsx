/**
 * App-wide success/error toasts.
 *
 * --- What this is for, and what it isn't -----------------------------
 *
 * A snackbar is the right place for the *outcome of an action the user
 * just took* — "Corrections saved", "Export failed" — and the wrong
 * place for an error the user has to act on. It disappears on a timer
 * and can't be read again, so anything a reviewer needs to keep looking
 * at while they fix it (a rejected PAN number, a document that wouldn't
 * load) stays as an inline `<Alert>` on the page instead. Several
 * screens here show both, deliberately: the inline alert explains, the
 * snackbar acknowledges.
 *
 * --- One at a time ---------------------------------------------------
 *
 * State is a single message, not a queue. Stacked toasts are a
 * notification centre, and this app never fires two at once — every
 * caller is a click handler for an action the UI disables while it runs.
 * A second message replacing the first is also the behavior you want in
 * the one case it can happen (a fast retry): the newest outcome is the
 * true one.
 */
import { useCallback, useMemo, useState } from 'react'
import { Alert, Snackbar } from '@mui/material'
import { SnackbarContext } from './snackbarContext'

export default function SnackbarProvider({ children }) {
  const [snack, setSnack] = useState(null)

  const notify = useMemo(() => {
    const show = (severity) => (message) => setSnack({ message, severity, key: Date.now() })
    return {
      success: show('success'),
      error: show('error'),
      info: show('info'),
      warning: show('warning'),
    }
  }, [])

  // `clickaway` is excluded so a click anywhere else on the page doesn't
  // dismiss a message the user hasn't read — the timer and the close
  // button are the only two ways out.
  const handleClose = useCallback((_event, reason) => {
    if (reason === 'clickaway') return
    setSnack(null)
  }, [])

  return (
    <SnackbarContext.Provider value={notify}>
      {children}
      <Snackbar
        // Keyed by fire time so a second message re-triggers the enter
        // transition and restarts the timer, instead of swapping text
        // inside a toast that's already half-way through fading out.
        key={snack?.key}
        open={Boolean(snack)}
        // Errors stay up longer: they're read more carefully than a
        // confirmation, and often name a field or a constraint.
        autoHideDuration={snack?.severity === 'error' ? 8000 : 4000}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        {/* Wrapped so `open=false` doesn't try to render a child with a
            null message during the exit transition. */}
        {snack ? (
          <Alert
            onClose={handleClose}
            severity={snack.severity}
            variant="filled"
            sx={{ width: '100%', maxWidth: 480, boxShadow: 6 }}
          >
            {snack.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </SnackbarContext.Provider>
  )
}
