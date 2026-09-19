/**
 * File picker: a drag-and-drop zone that's also a plain click-to-browse
 * target, backed by a hidden native `<input type="file">`. The hidden
 * input is what actually opens the OS file dialog and what makes this
 * keyboard-accessible (Enter/Space on the focused zone triggers it) —
 * drag-and-drop is a bonus interaction layered on top, not a
 * replacement for it.
 *
 * Restricted to exactly the file types the backend accepts (see
 * backend/core/file_types.py's ALLOWED_CONTENT_TYPES) so a user gets
 * immediate feedback instead of discovering the mismatch only after a
 * failed upload — and a rejected drop now says *why*, rather than
 * silently doing nothing as it used to.
 *
 * Built on MUI's `ButtonBase` rather than a styled `<div role="button">`:
 * it brings the focus ring, the ripple, and the Enter/Space handling
 * that the hand-rolled version had to reimplement, and it stays in step
 * with the theme's focus styling automatically.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, ButtonBase, Stack, Typography } from '@mui/material'
import CloudUploadIcon from '@mui/icons-material/CloudUpload'
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile'

const ACCEPTED_TYPES = ['application/pdf', 'image/png', 'image/jpeg']
const ACCEPTED_EXTENSIONS = '.pdf,.png,.jpg,.jpeg'

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function FileSelect({ selectedFile, onFileSelect, disabled }) {
  const inputRef = useRef(null)
  const [isDragActive, setIsDragActive] = useState(false)
  const [rejection, setRejection] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)

  // Builds a local thumbnail for image files only (a PDF has nothing
  // useful to render as an <img>). Runs whenever the selected file
  // changes, and its cleanup function revokes the previous object URL —
  // without that, every new selection would leak the last one for the
  // lifetime of the tab, since the browser never reclaims an object URL
  // on its own. This is genuine external-system synchronization (the
  // browser's Blob URL registry), not derived state, so the setState
  // calls below are the correct tool, not a shortcut.
  /* oxlint-disable react/set-state-in-effect */
  useEffect(() => {
    if (!selectedFile || !selectedFile.type.startsWith('image/')) {
      setPreviewUrl(null)
      return undefined
    }
    const url = URL.createObjectURL(selectedFile)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
    /* oxlint-enable react/set-state-in-effect */
  }, [selectedFile])

  const validateAndSelect = useCallback(
    (file) => {
      if (!file) return
      if (!ACCEPTED_TYPES.includes(file.type)) {
        // The old version returned silently here, which made dropping a
        // .docx look like the app had frozen. Naming the file and the
        // accepted set is the difference between a bug and a rule.
        setRejection(`"${file.name}" isn't a supported file type. Choose a PDF, PNG, or JPG.`)
        return
      }
      setRejection(null)
      onFileSelect(file)
    },
    [onFileSelect],
  )

  const handleDrop = useCallback(
    (event) => {
      event.preventDefault()
      setIsDragActive(false)
      if (disabled) return
      validateAndSelect(event.dataTransfer.files?.[0])
    },
    [disabled, validateAndSelect],
  )

  const handleInputChange = (event) => {
    validateAndSelect(event.target.files?.[0])
    // Clears the input's own value so selecting the exact same file
    // twice in a row still fires this handler the second time — without
    // this, the browser considers the value unchanged and skips the
    // change event entirely.
    event.target.value = ''
  }

  const borderColor = () => {
    if (isDragActive) return 'primary.main'
    if (rejection) return 'error.main'
    return 'divider'
  }

  return (
    <Box>
      <ButtonBase
        component="div"
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label="Choose a document to process"
        disabled={disabled}
        onClick={() => !disabled && inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled) setIsDragActive(true)
        }}
        onDragLeave={() => setIsDragActive(false)}
        onDrop={handleDrop}
        sx={{
          width: '100%',
          display: 'block',
          textAlign: 'left',
          p: 3,
          borderRadius: 2,
          border: '2px dashed',
          borderColor: borderColor(),
          bgcolor: isDragActive ? 'action.hover' : 'background.paper',
          transition: 'border-color 150ms ease, background-color 150ms ease',
          opacity: disabled ? 0.6 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
          '&:hover': { borderColor: disabled ? borderColor() : 'primary.main' },
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_EXTENSIONS}
          onChange={handleInputChange}
          disabled={disabled}
          // Visually hidden rather than `display: none`: a hidden input
          // is still the element that opens the OS dialog, and some
          // browsers refuse to click one that isn't rendered at all.
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
          aria-hidden="true"
          tabIndex={-1}
        />

        {selectedFile ? (
          <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
            {previewUrl ? (
              <Box
                component="img"
                src={previewUrl}
                alt=""
                sx={{
                  width: 64,
                  height: 64,
                  objectFit: 'cover',
                  borderRadius: 1.5,
                  border: 1,
                  borderColor: 'divider',
                  flexShrink: 0,
                }}
              />
            ) : (
              <Box
                sx={{
                  width: 64,
                  height: 64,
                  borderRadius: 1.5,
                  display: 'grid',
                  placeItems: 'center',
                  bgcolor: 'action.hover',
                  color: 'text.secondary',
                  flexShrink: 0,
                }}
              >
                <InsertDriveFileIcon />
              </Box>
            )}
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle2" noWrap title={selectedFile.name}>
                {selectedFile.name}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {formatBytes(selectedFile.size)}
              </Typography>
              <Typography variant="caption" color="primary.main" sx={{ display: 'block', mt: 0.5 }}>
                Click or drop to replace
              </Typography>
            </Box>
          </Stack>
        ) : (
          <Stack spacing={1} sx={{ alignItems: 'center', py: 1.5 }}>
            <CloudUploadIcon
              sx={{ fontSize: 36, color: isDragActive ? 'primary.main' : 'text.secondary' }}
            />
            <Typography variant="subtitle1" sx={{ fontWeight: 600, textAlign: 'center' }}>
              Drag &amp; drop a document here
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
              or click to browse — PDF, PNG, or JPG, up to 10&nbsp;MB
            </Typography>
          </Stack>
        )}
      </ButtonBase>

      {rejection && (
        <Typography
          variant="caption"
          color="error.main"
          sx={{ display: 'block', mt: 1 }}
          role="alert"
        >
          {rejection}
        </Typography>
      )}
    </Box>
  )
}
