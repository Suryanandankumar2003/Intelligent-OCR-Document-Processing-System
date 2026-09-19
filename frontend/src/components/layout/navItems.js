/**
 * The app's primary navigation, and the sidebar's width.
 *
 * Its own module because two components read it: `SidebarNav` renders
 * the list, and `AppLayout` matches the current URL against it to title
 * the navbar. Keeping "what are this app's screens" in one place means a
 * new screen is one entry, not a sidebar entry plus a matching lookup
 * table that has to agree with it.
 */
import CloudUploadIcon from '@mui/icons-material/CloudUpload'
import DescriptionIcon from '@mui/icons-material/Description'
import InsightsIcon from '@mui/icons-material/Insights'

export const SIDEBAR_WIDTH = 256

export const NAV_ITEMS = [
  {
    to: '/',
    label: 'Process',
    description: 'Upload & extract',
    icon: CloudUploadIcon,
    // `end` only on "/" — without it every path is a child match and
    // this item would stay selected on every screen. Documents
    // deliberately omits it, so it stays selected inside a review.
    end: true,
  },
  {
    to: '/documents',
    label: 'Documents',
    description: 'Browse & review',
    icon: DescriptionIcon,
    end: false,
  },
  {
    to: '/analytics',
    label: 'Analytics',
    description: 'Pipeline health',
    icon: InsightsIcon,
    end: true,
  },
]
