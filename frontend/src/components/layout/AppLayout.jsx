/**
 * The application shell: a persistent sidebar, a top navbar, and the
 * routed screen between them.
 *
 * --- One drawer, two behaviors ---------------------------------------
 *
 * Above `md` the sidebar is `variant="permanent"` — always there, part
 * of the layout, taking its width out of the content area. Below `md`
 * the same navigation becomes `variant="temporary"`: hidden until the
 * hamburger opens it, overlaying the content, closing on selection.
 *
 * --- Collapsing the desktop sidebar -----------------------------------
 *
 * The permanent drawer can be collapsed to an icon rail, and the choice
 * is remembered across visits. Two screens in this app genuinely want
 * the space — the documents and logs tables scroll sideways below about
 * 1100px, and the review screen's two panes are each half of whatever
 * is left — and on a laptop the sidebar is a fifth of the window spent
 * on four links the user already knows.
 *
 * It collapses rather than disappearing. A sidebar that closes to
 * nothing trades one problem for another: the navigation becomes
 * unreachable without first remembering that it can be reopened and
 * where the control is. The rail keeps every destination one click away
 * and still gives back most of the width — see `navItems.js` for the
 * two numbers.
 *
 * The preference is per browser, in `localStorage`, and every access is
 * wrapped: a private window or blocked site data makes these throw, and
 * a layout that failed to render because it could not read a cosmetic
 * preference would be a bad trade for remembering it.
 *
 * Both are rendered from the same `<SidebarNav>`, not two copies of the
 * link list, which is the whole reason the nav is its own component.
 * They are two separate `<Drawer>` elements rather than one with a
 * switched `variant` because MUI mounts them differently (the temporary
 * one keeps its children unmounted until opened, `keepMounted` aside),
 * and swapping variant on a live drawer makes it animate on every
 * resize across the breakpoint.
 *
 * --- Why the navbar is `position="fixed"` ----------------------------
 *
 * The documents table and the OCR transcript both scroll for a long
 * way. A navbar that scrolls away with them means the only route out of
 * a screen is a trip back to the top; pinned, the product name, the
 * current screen, and the theme toggle are always one click away. The
 * spacer `<Toolbar />` below it is what stops the fixed bar from
 * covering the first row of content — the standard MUI idiom, not a
 * magic number.
 */
import { useEffect, useState } from 'react'
import {
  AppBar,
  Box,
  Drawer,
  IconButton,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import MenuIcon from '@mui/icons-material/Menu'
import MenuOpenIcon from '@mui/icons-material/MenuOpen'
import DocumentScannerIcon from '@mui/icons-material/DocumentScanner'
import { useLocation } from 'react-router-dom'
import SidebarNav from './SidebarNav'
import {
  NAV_ITEMS,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_WIDTH,
  matchesNavItem,
} from './navItems'
import ColorModeToggle from './ColorModeToggle'

const COLLAPSED_STORAGE_KEY = 'ocr.sidebar.collapsed'

/**
 * The remembered collapsed state, or `false` when there isn't one.
 *
 * Read lazily (this is a `useState` initializer, not a value recomputed
 * on every render) and defensively: `localStorage` throws outright in a
 * private window and when site data is blocked, and the correct
 * response to that is an expanded sidebar, not a blank page.
 */
function readCollapsedPreference() {
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/** The label for whichever nav item owns the current URL, for the navbar's title. */
function useCurrentSectionLabel() {
  const { pathname } = useLocation()
  const match = NAV_ITEMS.filter((item) => matchesNavItem(item, pathname))
  // Longest matching path wins, so /documents/x/review resolves to the
  // Documents section rather than to whichever item happens to be first.
  return match.sort((a, b) => b.to.length - a.to.length)[0]?.label ?? 'Documents'
}

export default function AppLayout({ children }) {
  const theme = useTheme()
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'))
  const [mobileOpen, setMobileOpen] = useState(false)
  const [isCollapsed, setIsCollapsed] = useState(readCollapsedPreference)
  const sectionLabel = useCurrentSectionLabel()

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(isCollapsed))
    } catch {
      // Storage unavailable — the sidebar still collapses, it just will
      // not be that way next time. Not worth telling anyone about.
    }
  }, [isCollapsed])

  // The single definition of how wide the sidebar currently is. The
  // navbar's offset and the nav column's own width both read it, which
  // is what stops them disagreeing by a frame during the transition and
  // leaving a visible seam down the page.
  const sidebarWidth = isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH

  // One control, two meanings, because at each breakpoint there is only
  // one thing the sidebar can do: below `md` it opens the temporary
  // drawer, above it toggles the rail.
  const toggleSidebar = () =>
    isDesktop ? setIsCollapsed((collapsed) => !collapsed) : setMobileOpen(true)

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar
        position="fixed"
        color="inherit"
        elevation={0}
        sx={{
          // Sits to the right of the permanent drawer rather than under
          // it, so the sidebar reads as the app's spine and the navbar
          // as the current screen's header.
          width: { md: `calc(100% - ${sidebarWidth}px)` },
          ml: { md: `${sidebarWidth}px` },
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
          // Matched to the drawer's own transition below, so the bar and
          // the sidebar's edge move together instead of the content
          // snapping across before the sidebar has finished sliding.
          transition: theme.transitions.create(['width', 'margin-left'], {
            easing: theme.transitions.easing.sharp,
            duration: theme.transitions.duration.enteringScreen,
          }),
        }}
      >
        <Toolbar sx={{ gap: 1 }}>
          <Tooltip
            title={
              !isDesktop
                ? 'Open navigation'
                : isCollapsed
                  ? 'Expand the sidebar'
                  : 'Collapse the sidebar'
            }
          >
            <IconButton
              edge="start"
              onClick={toggleSidebar}
              aria-label={isDesktop ? 'Toggle sidebar' : 'Open navigation'}
              // Only meaningful for the desktop toggle: the mobile
              // button opens a dialog-like drawer, which announces its
              // own state, while this one changes the persistent layout
              // and so has to say which state it is in.
              aria-expanded={isDesktop ? !isCollapsed : undefined}
            >
              {isDesktop && !isCollapsed ? <MenuOpenIcon /> : <MenuIcon />}
            </IconButton>
          </Tooltip>

          {/* On mobile the sidebar is hidden, and with it the product
              name — so the logo comes back here rather than leaving the
              bar showing only a section title with no context. The
              collapsed desktop rail still shows the mark, so this stays
              mobile-only. */}
          {!isDesktop && <DocumentScannerIcon sx={{ color: 'primary.main' }} fontSize="small" />}

          <Typography variant="h4" component="h1" noWrap sx={{ flexGrow: 1 }}>
            {sectionLabel}
          </Typography>

          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <Tooltip title="Backend API docs">
              <Typography
                component="a"
                href={`${import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000/api/v1'}/../../docs`}
                target="_blank"
                rel="noreferrer"
                variant="caption"
                sx={{
                  display: { xs: 'none', sm: 'block' },
                  color: 'text.secondary',
                  textDecoration: 'none',
                  '&:hover': { color: 'primary.main' },
                }}
              >
                API docs
              </Typography>
            </Tooltip>
            <ColorModeToggle />
          </Stack>
        </Toolbar>
      </AppBar>

      <Box
        component="nav"
        sx={{
          width: { md: sidebarWidth },
          flexShrink: { md: 0 },
          transition: theme.transitions.create('width', {
            easing: theme.transitions.easing.sharp,
            duration: theme.transitions.duration.enteringScreen,
          }),
        }}
      >
        <Drawer
          variant="temporary"
          open={mobileOpen && !isDesktop}
          onClose={() => setMobileOpen(false)}
          // The drawer is remounted on every open otherwise, which on a
          // phone means a visible re-layout each time.
          ModalProps={{ keepMounted: true }}
          sx={{
            display: { xs: 'block', md: 'none' },
            '& .MuiDrawer-paper': { width: SIDEBAR_WIDTH, boxSizing: 'border-box' },
          }}
        >
          <SidebarNav onNavigate={() => setMobileOpen(false)} />
        </Drawer>

        <Drawer
          variant="permanent"
          open
          sx={{
            display: { xs: 'none', md: 'block' },
            '& .MuiDrawer-paper': {
              width: sidebarWidth,
              boxSizing: 'border-box',
              borderRight: 1,
              borderColor: 'divider',
              bgcolor: 'background.paper',
              // Clipped during the slide: the labels inside are laid out
              // for the full width, and letting them spill past a
              // narrowing paper makes the collapse look like text
              // sliding out from underneath the content.
              overflowX: 'hidden',
              transition: theme.transitions.create('width', {
                easing: theme.transitions.easing.sharp,
                duration: theme.transitions.duration.enteringScreen,
              }),
            },
          }}
        >
          <SidebarNav collapsed={isCollapsed} />
        </Drawer>
      </Box>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          // `minWidth: 0` is what allows a wide child (the documents
          // table, a long transcript line) to scroll inside its own box
          // instead of stretching this flex item and pushing the whole
          // page sideways.
          minWidth: 0,
          px: { xs: 2, sm: 3, md: 4 },
          pb: { xs: 4, md: 6 },
        }}
      >
        <Toolbar />
        {children}
      </Box>
    </Box>
  )
}
