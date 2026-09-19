/**
 * The color-mode context and its hook.
 *
 * Split from `ColorModeProvider.jsx` purely so that file exports nothing
 * but a component: React Fast Refresh can only hot-swap a module whose
 * exports are all components, and a mixed module silently falls back to
 * a full reload on every edit during development.
 */
import { createContext, useContext } from 'react'

export const ColorModeContext = createContext(null)

/** `{ mode, resolvedMode, setMode, modes }` — see ColorModeProvider. */
export function useColorMode() {
  const context = useContext(ColorModeContext)
  if (!context) throw new Error('useColorMode must be used inside <ColorModeProvider>')
  return context
}
