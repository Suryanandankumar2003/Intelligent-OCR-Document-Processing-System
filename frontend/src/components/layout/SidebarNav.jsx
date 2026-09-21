/**
 * The sidebar's contents: product identity, the primary navigation, and
 * a footer.
 *
 * Rendered into both of `AppLayout`'s drawers — the permanent desktop
 * one and the temporary mobile one — so the navigation is defined once.
 * `onNavigate` is how the mobile drawer closes itself after a selection;
 * the desktop one passes nothing and the links simply navigate.
 *
 * The link list itself lives in `navItems.js`, because the navbar reads
 * it too — see that file.
 *
 * --- Collapsed ---------------------------------------------------------
 *
 * `collapsed` renders the same list as an icon rail: labels and
 * descriptions gone, icons centred, each item explained by a tooltip
 * instead. It is the same component and the same list rather than a
 * second "rail" component, because two components would be two places
 * for a new screen to be added and one place for it to be forgotten.
 *
 * What survives the collapse is chosen rather than incidental: the
 * product mark stays (an unlabelled column of four icons needs
 * something at the top saying what application it belongs to), the
 * active tint stays (it is the only remaining indication of where you
 * are), and the footer's supported-document-types line goes, because it
 * is reference text that cannot be usefully abbreviated to 40 pixels.
 */
import {
  Box,
  Divider,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Typography,
} from '@mui/material'
import DocumentScannerIcon from '@mui/icons-material/DocumentScanner'
import { NavLink, useLocation } from 'react-router-dom'
import { NAV_ITEMS, matchesNavItem } from './navItems'

export default function SidebarNav({ onNavigate, collapsed = false }) {
  const { pathname } = useLocation()

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{
          px: collapsed ? 0 : 2.5,
          py: 2.25,
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'flex-start',
          gap: 1.5,
        }}
      >
        <Box
          sx={{
            width: 36,
            height: 36,
            borderRadius: 2,
            display: 'grid',
            placeItems: 'center',
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
            flexShrink: 0,
          }}
        >
          <DocumentScannerIcon fontSize="small" />
        </Box>
        {!collapsed && (
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle2" noWrap sx={{ fontWeight: 700 }}>
              Intelligent OCR
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
              Document Processing
            </Typography>
          </Box>
        )}
      </Box>

      <Divider />

      {!collapsed && (
        <Typography
          variant="overline"
          sx={{ px: 2.5, pt: 2, pb: 0.5, color: 'text.secondary', display: 'block' }}
        >
          Workspace
        </Typography>
      )}

      <List sx={{ px: collapsed ? 1 : 1.5, py: collapsed ? 1.5 : 0.5, flexGrow: 1 }}>
        {NAV_ITEMS.map((item) => {
          const { to, label, description, icon: Icon, end } = item
          // Computed here rather than left to `NavLink`'s own `isActive`,
          // because an item can own a screen that does not live under its
          // path (`alsoMatch` — Process owns /batches). `aria-current` is
          // set from the same answer, so the item announced to assistive
          // tech is always the one that is tinted.
          const isActive = matchesNavItem(item, pathname)

          const button = (
            <ListItemButton
              component={NavLink}
              to={to}
              end={end}
              className={isActive ? 'active' : undefined}
              aria-current={isActive ? 'page' : undefined}
              // Collapsed, the visible label is gone, so the accessible
              // name has to come from somewhere — without this the rail
              // announces four identically unnamed links.
              aria-label={collapsed ? label : undefined}
              onClick={onNavigate}
              sx={{
                borderRadius: 2,
                mb: 0.5,
                py: 1,
                justifyContent: collapsed ? 'center' : 'flex-start',
                px: collapsed ? 1 : 2,
                color: 'text.secondary',
                '&.active': {
                  bgcolor: 'action.selected',
                  color: 'primary.main',
                  '& .MuiListItemIcon-root': { color: 'primary.main' },
                  '& .MuiListItemText-primary': { fontWeight: 650 },
                },
              }}
            >
              <ListItemIcon
                sx={{ minWidth: collapsed ? 0 : 36, color: 'inherit', justifyContent: 'center' }}
              >
                <Icon fontSize="small" />
              </ListItemIcon>
              {!collapsed && (
                <ListItemText
                  primary={label}
                  secondary={description}
                  slotProps={{
                    primary: { variant: 'body2', fontWeight: 600 },
                    secondary: { variant: 'caption' },
                  }}
                />
              )}
            </ListItemButton>
          )

          return (
            <Box key={to}>
              {collapsed ? (
                // Both lines, not just the label: the description is the
                // part that says what the screen is *for*, and it is
                // exactly what someone hovering an unfamiliar icon is
                // trying to find out.
                <Tooltip title={`${label} — ${description}`} placement="right">
                  {button}
                </Tooltip>
              ) : (
                button
              )}
            </Box>
          )
        })}
      </List>

      {!collapsed && (
        <>
          <Divider />
          <Box sx={{ px: 2.5, py: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              PAN · Aadhaar · Invoice · Prescription · Test Report
            </Typography>
          </Box>
        </>
      )}
    </Box>
  )
}
