/**
 * A button that kicks off a download and spins while it runs.
 *
 * Stateless — its label and disabled state are entirely driven by props
 * from whichever screen owns the export state (`useDocumentExport`). The
 * documents screen renders two of these, which is the reason this is a
 * component rather than markup inlined into the page twice.
 *
 * The spinner replaces the icon rather than sitting next to it, so the
 * button's width doesn't change mid-click, and the busy state is
 * announced through `aria-busy` plus the changed label — a decorative
 * spinning ring tells a screen reader nothing.
 */
import { Button, CircularProgress, Tooltip } from '@mui/material'
import FileDownloadIcon from '@mui/icons-material/FileDownload'

export default function ExportButton({
  onClick,
  isLoading = false,
  disabled = false,
  variant = 'outlined',
  color = 'inherit',
  label,
  loadingLabel = 'Exporting…',
  title,
}) {
  const button = (
    <Button
      variant={variant}
      color={color}
      onClick={onClick}
      // `isLoading` implies disabled so a caller can't render a spinning
      // button that's still clickable.
      disabled={disabled || isLoading}
      aria-busy={isLoading}
      startIcon={isLoading ? <CircularProgress size={16} color="inherit" /> : <FileDownloadIcon />}
    >
      {isLoading ? loadingLabel : label}
    </Button>
  )

  // The `<span>` is required: MUI's Tooltip listens for pointer events,
  // and a disabled button emits none — which is exactly when the
  // explanation matters most ("no documents have been reviewed yet").
  return title ? (
    <Tooltip title={title}>
      <span>{button}</span>
    </Tooltip>
  ) : (
    button
  )
}
