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
import { useState } from 'react'
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
import DocumentScannerIcon from '@mui/icons-material/DocumentScanner'
import { useLocation } from 'react-router-dom'
import SidebarNav from './SidebarNav'
import { NAV_ITEMS, SIDEBAR_WIDTH, matchesNavItem } from './navItems'
import ColorModeToggle from './ColorModeToggle'

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
  const sectionLabel = useCurrentSectionLabel()

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
          width: { md: `calc(100% - ${SIDEBAR_WIDTH}px)` },
          ml: { md: `${SIDEBAR_WIDTH}px` },
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Toolbar sx={{ gap: 1 }}>
          {!isDesktop && (
            <IconButton
              edge="start"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
            >
              <MenuIcon />
            </IconButton>
          )}

          {/* On mobile the sidebar is hidden, and with it the product
              name — so the logo comes back here rather than leaving the
              bar showing only a section title with no context. */}
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

      <Box component="nav" sx={{ width: { md: SIDEBAR_WIDTH }, flexShrink: { md: 0 } }}>
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
              width: SIDEBAR_WIDTH,
              boxSizing: 'border-box',
              borderRight: 1,
              borderColor: 'divider',
              bgcolor: 'background.paper',
            },
          }}
        >
          <SidebarNav />
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
