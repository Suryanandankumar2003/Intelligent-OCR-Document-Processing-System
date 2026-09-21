/**
 * The app's primary navigation, and the sidebar's width.
 *
 * Its own module because two components read it: `SidebarNav` renders
 * the list, and `AppLayout` matches the current URL against it to title
 * the navbar. Keeping "what are this app's screens" in one place means a
 * new screen is one entry, not a sidebar entry plus a matching lookup
 * table that has to agree with it.
 *
 * `alsoMatch` is for a screen that belongs to an entry without living
 * under its path. Batches are started on the Process screen and then
 * open at `/batches/...`, which no prefix rule on "/" could match
 * without also matching every other screen in the app.
 */
import CloudUploadIcon from '@mui/icons-material/CloudUpload'
import DescriptionIcon from '@mui/icons-material/Description'
import InsightsIcon from '@mui/icons-material/Insights'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'

export const SIDEBAR_WIDTH = 256

/**
 * The sidebar's width when collapsed.
 *
 * A narrow icon rail rather than zero, which is the point of the
 * feature: someone collapses the sidebar to give a wide screen — the
 * documents table, the two-pane review — more room, not to give up
 * navigating. 72px is wide enough for a 40px touch target with even
 * gutters, and narrow enough that reclaiming 184px is visibly worth
 * doing.
 */
export const SIDEBAR_COLLAPSED_WIDTH = 72

export const NAV_ITEMS = [
  {
    to: '/',
    label: 'Process',
    description: 'One file or a batch',
    icon: CloudUploadIcon,
    // `end` only on "/" — without it every path is a child match and
    // this item would stay selected on every screen. Documents
    // deliberately omits it, so it stays selected inside a review.
    //
    // The batch screens are therefore matched explicitly below rather
    // than by prefix: they belong to this entry (batches are started
    // here) but they do not live under "/", so nothing else would keep
    // it selected while the user is looking at one.
    end: true,
    alsoMatch: ['/batches'],
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
  {
    to: '/logs',
    label: 'Logs',
    description: 'Every event, searchable',
    icon: ReceiptLongIcon,
    // `end` omitted, so the entry stays selected on `/logs/:logId` —
    // the same rule Documents follows for its review screen.
    end: false,
  },
]

/**
 * Whether `pathname` belongs to `item` — the single definition of
 * "which section am I in", used both to highlight the sidebar and to
 * title the navbar.
 *
 * Three rules, in order: an `end` item matches its own path exactly, any
 * item matches a path beneath it, and `alsoMatch` adds paths that belong
 * to the item without living under it. Splitting these across the two
 * consumers is how a sidebar ends up highlighting one section while the
 * navbar names another.
 */
export function matchesNavItem(item, pathname) {
  if (item.end ? pathname === item.to : pathname.startsWith(item.to)) return true
  return (item.alsoMatch ?? []).some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}
