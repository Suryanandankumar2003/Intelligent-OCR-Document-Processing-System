/**
 * The single source of truth for how this app looks: one MUI theme,
 * built for either color mode from the same definitions.
 *
 * `createAppTheme(mode)` is a factory rather than two exported theme
 * objects because almost nothing about the design actually differs
 * between light and dark — the type scale, the spacing, the radii, and
 * every component override below are shared, and only the palette is
 * branched. Writing it this way means a change to, say, button shape
 * can't accidentally land in one mode and not the other.
 *
 * --- Where the old CSS custom properties went ------------------------
 *
 * This replaces the hand-rolled `:root { --color-*, --space-*, ... }`
 * block that used to live in index.css. The tokens themselves didn't go
 * away — `theme/GlobalStyles.jsx` republishes the handful the SVG charts
 * still consume — but the theme is now the definition and those
 * variables are derived from it, rather than the two being maintained
 * side by side and drifting.
 */
import { createTheme } from '@mui/material/styles'

// Slate/blue, the same family the app already used, rebalanced so each
// mode has its own foreground rather than dark mode being light mode
// with the lightness flipped (which is what makes a naively inverted UI
// look muddy: a hue that reads as "calm blue-grey" on white reads as
// "washed out" on near-black).
const BRAND = {
  light: {
    primary: '#2563eb',
    primaryDark: '#1d4ed8',
    primaryLight: '#60a5fa',
    background: '#f1f5f9',
    paper: '#ffffff',
    // A third surface between paper and background, for the inset
    // blocks (OCR transcript, code-ish panels) that need to read as
    // recessed rather than as another card.
    sunken: '#f8fafc',
    divider: '#e2e8f0',
    text: '#0f172a',
    textMuted: '#64748b',
  },
  dark: {
    primary: '#60a5fa',
    primaryDark: '#3b82f6',
    primaryLight: '#93c5fd',
    // Not pure black: a true #000 surface makes every elevation shadow
    // invisible and exaggerates the contrast of white text to the point
    // of halation on OLED displays.
    background: '#0b1120',
    paper: '#111827',
    sunken: '#0f172a',
    divider: '#1f2937',
    text: '#e5e7eb',
    textMuted: '#94a3b8',
  },
}

/**
 * The categorical palette for "documents by type", one fixed hue per
 * type so a document type is the same color on every chart, in every
 * mode.
 *
 * The light values are the dataviz skill's validated categorical slots
 * (see the original note in the old index.css). The dark values are
 * those same hues lifted in lightness — on a near-black ground the
 * light-mode versions fall under the 3:1 contrast floor, so reusing
 * them unchanged would have been the single most visible dark-mode bug
 * on the analytics page.
 */
const CHART_COLORS = {
  light: {
    pan: '#2a78d6',
    aadhaar: '#eb6834',
    invoice: '#1baf7a',
    prescription: '#eda100',
    trf: '#7c5cd6',
    grid: '#e2e8f0',
    axis: '#cbd5e1',
  },
  dark: {
    pan: '#60a5fa',
    aadhaar: '#fb923c',
    invoice: '#34d399',
    prescription: '#fbbf24',
    trf: '#a78bfa',
    grid: '#1f2937',
    axis: '#374151',
  },
}

export const FONT_FAMILY =
  '"Inter Variable", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

export const MONO_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

export function chartColors(mode) {
  return CHART_COLORS[mode] ?? CHART_COLORS.light
}

export function createAppTheme(mode) {
  const brand = BRAND[mode] ?? BRAND.light
  const isDark = mode === 'dark'

  return createTheme({
    palette: {
      mode,
      primary: { main: brand.primary, dark: brand.primaryDark, light: brand.primaryLight },
      success: { main: isDark ? '#34d399' : '#16a34a' },
      warning: { main: isDark ? '#fbbf24' : '#d97706' },
      error: { main: isDark ? '#f87171' : '#dc2626' },
      info: { main: brand.primary },
      background: { default: brand.background, paper: brand.paper },
      divider: brand.divider,
      text: { primary: brand.text, secondary: brand.textMuted },
      // Not part of MUI's palette contract — read explicitly as
      // `theme.palette.sunken` by the few places that need a recessed
      // surface, and published as `--color-sunken` for the charts.
      sunken: brand.sunken,
    },

    // --- Typography ---------------------------------------------------
    //
    // A real scale rather than MUI's defaults: tighter letter-spacing as
    // size goes up (large text at default tracking looks loose), and
    // headings at 600/700 rather than MUI's 400/500, which is what makes
    // an enterprise dashboard read as structured rather than airy.
    typography: {
      fontFamily: FONT_FAMILY,
      h1: { fontSize: '2rem', fontWeight: 700, letterSpacing: '-0.025em', lineHeight: 1.2 },
      h2: { fontSize: '1.5rem', fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.25 },
      h3: { fontSize: '1.25rem', fontWeight: 650, letterSpacing: '-0.015em', lineHeight: 1.3 },
      h4: { fontSize: '1.0625rem', fontWeight: 650, letterSpacing: '-0.01em', lineHeight: 1.4 },
      h5: { fontSize: '0.9375rem', fontWeight: 650, lineHeight: 1.4 },
      h6: { fontSize: '0.875rem', fontWeight: 650, lineHeight: 1.4 },
      subtitle1: { fontSize: '0.9375rem', fontWeight: 500, lineHeight: 1.5 },
      subtitle2: { fontSize: '0.8125rem', fontWeight: 600, lineHeight: 1.5 },
      body1: { fontSize: '0.9375rem', lineHeight: 1.6 },
      body2: { fontSize: '0.8125rem', lineHeight: 1.55 },
      caption: { fontSize: '0.75rem', lineHeight: 1.5 },
      // Buttons and tabs: sentence case, not MUI's default SHOUTING
      // uppercase, which at this density reads as louder than the data.
      button: { fontSize: '0.8125rem', fontWeight: 600, textTransform: 'none', letterSpacing: 0 },
      overline: {
        fontSize: '0.6875rem',
        fontWeight: 700,
        letterSpacing: '0.08em',
        lineHeight: 1.6,
      },
    },

    shape: { borderRadius: 10 },

    components: {
      MuiCssBaseline: {
        styleOverrides: {
          // Tells the browser to render its own widgets (scrollbars,
          // form controls, the `color-scheme` of an iframe) in the
          // matching mode. Without it, dark mode gets light scrollbars.
          ':root': { colorScheme: mode },
          body: { WebkitFontSmoothing: 'antialiased', MozOsxFontSmoothing: 'grayscale' },
        },
      },

      // Flat by default. An enterprise dashboard is mostly nested
      // containers, and MUI's default elevation shadows stack into mush
      // at three levels deep; a 1px divider border separates them more
      // cleanly and stays legible in dark mode, where shadows barely
      // register at all.
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundImage: 'none',
            border: `1px solid ${theme.palette.divider}`,
          }),
          // The exception: anything that floats above the page (menus,
          // popovers, the mobile nav drawer) genuinely is on another
          // layer and keeps its shadow.
          elevation8: { border: 'none' },
          elevation16: { border: 'none' },
          elevation24: { border: 'none' },
        },
      },

      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: 8, paddingInline: 14 },
          sizeSmall: { paddingInline: 10 },
        },
      },

      MuiTextField: { defaultProps: { size: 'small' } },
      MuiSelect: { defaultProps: { size: 'small' } },

      MuiOutlinedInput: {
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundColor: theme.palette.background.paper,
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderWidth: 1.5 },
          }),
        },
      },

      MuiTooltip: {
        defaultProps: { arrow: true },
        styleOverrides: { tooltip: { fontSize: '0.75rem', padding: '6px 10px', maxWidth: 280 } },
      },

      MuiChip: {
        styleOverrides: {
          root: { fontWeight: 600 },
          sizeSmall: { height: 22, fontSize: '0.6875rem' },
        },
      },

      MuiTableCell: {
        styleOverrides: {
          root: ({ theme }) => ({ borderColor: theme.palette.divider }),
          head: ({ theme }) => ({
            fontWeight: 650,
            fontSize: '0.75rem',
            letterSpacing: '0.02em',
            textTransform: 'uppercase',
            color: theme.palette.text.secondary,
            backgroundColor: theme.palette.sunken,
            whiteSpace: 'nowrap',
          }),
        },
      },

      MuiAlert: {
        styleOverrides: {
          root: { borderRadius: 10, alignItems: 'flex-start' },
          // `variant="outlined"` reads as part of the page rather than
          // as a browser-level interruption, which suits an inline
          // message sitting above a form the user is still working in.
          standardError: ({ theme }) => ({ border: `1px solid ${theme.palette.error.main}33` }),
          standardSuccess: ({ theme }) => ({ border: `1px solid ${theme.palette.success.main}33` }),
        },
      },

      MuiSkeleton: { defaultProps: { animation: 'wave' } },

      MuiLinearProgress: { styleOverrides: { root: { borderRadius: 999, height: 6 } } },
    },
  })
}
