import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
// Self-hosted variable font — bundled, so no request to a font CDN, no
// flash of unstyled text, and no third party in the page's critical
// path. `theme.js` still declares a full system-font fallback stack
// behind it, which is what renders if this ever fails to load.
import '@fontsource-variable/inter'
import ColorModeProvider from './theme/ColorModeProvider'
import SnackbarProvider from './components/feedback/SnackbarProvider'
import App from './App.jsx'

// BrowserRouter (real URLs, History API) rather than HashRouter: every
// screen in this app is a thing a reviewer should be able to bookmark,
// reload, or paste to a colleague — a document's review screen most of
// all. The Vite dev server already serves index.html for unknown paths,
// so a deep link like /documents/abc.pdf/review works on a cold load;
// any production host needs the same SPA fallback.
//
// Provider order is load-bearing: ColorModeProvider owns the MUI
// ThemeProvider, and SnackbarProvider renders MUI components, so it has
// to sit inside. Both sit outside the router because a toast fired by
// one screen should survive navigating to another.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ColorModeProvider>
      <SnackbarProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </SnackbarProvider>
    </ColorModeProvider>
  </StrictMode>,
)
