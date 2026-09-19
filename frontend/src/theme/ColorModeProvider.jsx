/**
 * Dark mode: the stored preference, the resolved theme, and the control
 * that changes it.
 *
 * --- Three modes, not two --------------------------------------------
 *
 * The preference is `'light' | 'dark' | 'system'`, and `'system'` is the
 * default. A two-state toggle has to pick one of the two as the initial
 * value for everyone, which means every user whose OS says otherwise
 * gets the wrong one on first load and has to fix it by hand. Following
 * the OS until told otherwise is the only default that's right for both
 * groups — and `prefers-color-scheme` is a live query, so a user whose
 * OS switches at sunset gets the app switching with it, mid-session,
 * without a reload.
 *
 * `resolvedMode` ('light' or 'dark') is what the theme is actually built
 * from; `mode` is what the user chose. Components that render a toggle
 * need both — one to know what's on screen, one to know which option to
 * show as selected.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CssBaseline, ThemeProvider } from '@mui/material'
import { createAppTheme } from './theme'
import { ColorModeContext } from './colorModeContext'
import AppGlobalStyles from './GlobalStyles'

const STORAGE_KEY = 'ocr-app:color-mode'
const MODES = ['light', 'dark', 'system']

/**
 * Reads the saved preference.
 *
 * Wrapped in try/catch and validated against the known set because
 * `localStorage` is not guaranteed to be there or to be trustworthy: it
 * throws outright in a Safari private window, and its contents are
 * user-editable. A bad value falls back to 'system' rather than being
 * handed to `createTheme`.
 */
function readStoredMode() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return MODES.includes(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

export default function ColorModeProvider({ children }) {
  const [mode, setModeState] = useState(readStoredMode)
  const [systemMode, setSystemMode] = useState(() =>
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  )

  // Subscribed to for the whole session, not read once at startup: the
  // OS theme can change while the app is open (a scheduled switch, or
  // the user changing it in another window), and a dashboard someone
  // leaves open all day is exactly where that happens.
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!query) return undefined
    const handleChange = (event) => setSystemMode(event.matches ? 'dark' : 'light')
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  const setMode = useCallback((next) => {
    setModeState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Storage can be unavailable or full. The preference still applies
      // for this session — it just won't survive a reload, which is a
      // better outcome than the toggle appearing not to work at all.
    }
  }, [])

  const resolvedMode = mode === 'system' ? systemMode : mode

  // Rebuilt only when the resolved mode actually changes. `createTheme`
  // walks every override in theme.js, and a new theme object identity
  // re-renders every styled component beneath it, so doing this on each
  // render would make every keystroke in a form repaint the page.
  const theme = useMemo(() => createAppTheme(resolvedMode), [resolvedMode])

  const value = useMemo(
    () => ({ mode, resolvedMode, setMode, modes: MODES }),
    [mode, resolvedMode, setMode],
  )

  return (
    <ColorModeContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        {/* CssBaseline must sit inside ThemeProvider — it reads the
            theme to paint the page background and set `color-scheme`,
            which is what makes the browser's own scrollbars and form
            widgets follow dark mode too. */}
        <CssBaseline />
        <AppGlobalStyles />
        {children}
      </ThemeProvider>
    </ColorModeContext.Provider>
  )
}
