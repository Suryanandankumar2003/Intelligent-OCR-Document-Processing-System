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
 */
import {
  Box,
  Divider,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
} from '@mui/material'
import DocumentScannerIcon from '@mui/icons-material/DocumentScanner'
import { NavLink, useLocation } from 'react-router-dom'
import { NAV_ITEMS, matchesNavItem } from './navItems'

export default function SidebarNav({ onNavigate }) {
  const { pathname } = useLocation()

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ px: 2.5, py: 2.25, display: 'flex', alignItems: 'center', gap: 1.5 }}>
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
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" noWrap sx={{ fontWeight: 700 }}>
            Intelligent OCR
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
            Document Processing
          </Typography>
        </Box>
      </Box>

      <Divider />

      <Typography
        variant="overline"
        sx={{ px: 2.5, pt: 2, pb: 0.5, color: 'text.secondary', display: 'block' }}
      >
        Workspace
      </Typography>

      <List sx={{ px: 1.5, py: 0.5, flexGrow: 1 }}>
        {NAV_ITEMS.map((item) => {
          const { to, label, description, icon: Icon, end } = item
          // Computed here rather than left to `NavLink`'s own `isActive`,
          // because an item can own a screen that does not live under its
          // path (`alsoMatch` — Process owns /batches). `aria-current` is
          // set from the same answer, so the item announced to assistive
          // tech is always the one that is tinted.
          const isActive = matchesNavItem(item, pathname)
          return (
          <ListItemButton
            key={to}
            component={NavLink}
            to={to}
            end={end}
            className={isActive ? 'active' : undefined}
            aria-current={isActive ? 'page' : undefined}
            onClick={onNavigate}
            sx={{
              borderRadius: 2,
              mb: 0.5,
              py: 1,
              color: 'text.secondary',
              '&.active': {
                bgcolor: 'action.selected',
                color: 'primary.main',
                '& .MuiListItemIcon-root': { color: 'primary.main' },
                '& .MuiListItemText-primary': { fontWeight: 650 },
              },
            }}
          >
            <ListItemIcon sx={{ minWidth: 36, color: 'inherit' }}>
              <Icon fontSize="small" />
            </ListItemIcon>
            <ListItemText
              primary={label}
              secondary={description}
              slotProps={{
                primary: { variant: 'body2', fontWeight: 600 },
                secondary: { variant: 'caption' },
              }}
            />
          </ListItemButton>
          )
        })}
      </List>

      <Divider />
      <Box sx={{ px: 2.5, py: 2 }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          PAN · Aadhaar · Invoice · Prescription · Test Report
        </Typography>
      </Box>
    </Box>
  )
}
