/**
 * The snackbar context and its hook.
 *
 * Split from `SnackbarProvider.jsx` for the same reason as
 * `theme/colorModeContext.js`: keeping the provider file component-only
 * is what lets React Fast Refresh hot-swap it instead of reloading the
 * page on every edit.
 */
import { createContext, useContext } from 'react'

export const SnackbarContext = createContext(null)

/** `const notify = useNotify()` -> `notify.success(msg)` / `notify.error(msg)`. */
export function useNotify() {
  const context = useContext(SnackbarContext)
  if (!context) throw new Error('useNotify must be used inside <SnackbarProvider>')
  return context
}
