/**
 * The bulk picker: drop (or browse for) many files at once, see what was
 * accepted, and remove anything picked by mistake before uploading.
 *
 * Built on the same `ButtonBase` foundation as `FileSelect` — hidden
 * native input, keyboard-accessible, drag-and-drop layered on top — and
 * differs from it in the three places bulk selection genuinely differs:
 *
 *   * **`multiple` and directory drops.** A folder dragged onto this
 *     zone arrives as its files, which is how anyone with 500 scans
 *     actually has them.
 *
 *   * **Adding, not replacing.** `FileSelect` swaps one file for
 *     another. Here a second drop *appends*, because a real batch is
 *     assembled from several folders as often as from one — and a drop
 *     that silently discarded the previous 200 files would be
 *     unrecoverable without re-finding them.
 *
 *   * **Rejections are a list, not a sentence.** Dropping a folder with
 *     three `.docx` files in it must name those three and keep the rest,
 *     which is the same rule the backend applies to the upload itself
 *     (see backend/services/batch_service.py). The UI enforcing it here
 *     too means the operator finds out before spending the transfer,
 *     not after.
 *
 * Identity for de-duplication is name + size + last-modified. The File
 * API gives no stable id, and this triple is what distinguishes "the
 * same file dropped twice" (common, and silently ignoring it is right)
 * from "two different scans that happen to share a name" (also common
 * across folders, and dropping one of them would be data loss).
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  Box,
  Button,
  ButtonBase,
  Chip,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material'
import CloudUploadIcon from '@mui/icons-material/CloudUpload'
import ClearIcon from '@mui/icons-material/Clear'
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'

const ACCEPTED_TYPES = ['application/pdf', 'image/png', 'image/jpeg']
const ACCEPTED_EXTENSIONS = '.pdf,.png,.jpg,.jpeg'

// How many of the selected files to list. A 500-row list inside a form
// is unreadable and janky to render; the count above it is the number
// that matters, and the list is there to spot-check what was picked.
const PREVIEW_LIMIT = 8

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** name + size + last-modified — the closest thing the File API offers to an identity. */
function keyOf(file) {
  return `${file.name}:${file.size}:${file.lastModified}`
}

export default function MultiFileSelect({ files, onChange, disabled, maxFiles }) {
  const inputRef = useRef(null)
  const [isDragActive, setIsDragActive] = useState(false)
  const [rejections, setRejections] = useState([])

  const totalBytes = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files],
  )

  const addFiles = useCallback(
    (incoming) => {
      const candidates = Array.from(incoming ?? [])
      if (candidates.length === 0) return

      const existing = new Set(files.map(keyOf))
      const accepted = []
      const refused = []

      candidates.forEach((file) => {
        if (!ACCEPTED_TYPES.includes(file.type)) {
          refused.push({ name: file.name, reason: 'Not a PDF, PNG, or JPG' })
          return
        }
        const key = keyOf(file)
        // Silent rather than reported: re-dropping the same folder is a
        // normal thing to do while assembling a batch, and calling it a
        // rejection would make a harmless action look like a mistake.
        if (existing.has(key)) return
        existing.add(key)
        accepted.push(file)
      })

      const room = maxFiles - files.length
      if (accepted.length > room) {
        // Over the per-request cap. Taking what fits and naming the rest
        // beats refusing the whole drop: the backend enforces the same
        // cap with a 413, and discovering it after a several-minute
        // transfer is the failure this prevents.
        accepted.splice(room).forEach((file) => {
          refused.push({ name: file.name, reason: `Over the ${maxFiles}-file limit` })
        })
      }

      setRejections(refused)
      if (accepted.length > 0) onChange([...files, ...accepted])
    },
    [files, onChange, maxFiles],
  )

  const handleDrop = useCallback(
    (event) => {
      event.preventDefault()
      setIsDragActive(false)
      if (disabled) return
      addFiles(event.dataTransfer.files)
    },
    [disabled, addFiles],
  )

  const handleInputChange = (event) => {
    addFiles(event.target.files)
    // Cleared so picking the identical selection twice still fires a
    // change event — the browser suppresses it otherwise.
    event.target.value = ''
  }

  const removeAt = (index) => onChange(files.filter((_, position) => position !== index))

  const isFull = files.length >= maxFiles

  return (
    <Box>
      <ButtonBase
        component="div"
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label="Choose documents to process as a batch"
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
          borderColor: isDragActive ? 'primary.main' : 'divider',
          bgcolor: isDragActive ? 'action.hover' : 'background.paper',
          transition: 'border-color 150ms ease, background-color 150ms ease',
          opacity: disabled ? 0.6 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
          '&:hover': { borderColor: disabled ? undefined : 'primary.main' },
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS}
          onChange={handleInputChange}
          disabled={disabled}
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
          aria-hidden="true"
          tabIndex={-1}
        />

        <Stack spacing={1} sx={{ alignItems: 'center', py: 1.5 }}>
          <CloudUploadIcon
            sx={{ fontSize: 36, color: isDragActive ? 'primary.main' : 'text.secondary' }}
          />
          <Typography variant="subtitle1" sx={{ fontWeight: 600, textAlign: 'center' }}>
            {files.length === 0
              ? 'Drag & drop documents or a folder here'
              : `${files.length.toLocaleString()} file${files.length === 1 ? '' : 's'} selected · ${formatBytes(totalBytes)}`}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
            {isFull
              ? `That's the ${maxFiles.toLocaleString()}-file maximum for one batch.`
              : `or click to browse — PDF, PNG, or JPG, up to ${maxFiles.toLocaleString()} files per batch`}
          </Typography>
          {files.length > 0 && !isFull && (
            <Typography variant="caption" color="primary.main">
              Drop more to add them to this batch
            </Typography>
          )}
        </Stack>
      </ButtonBase>

      {rejections.length > 0 && (
        <Box sx={{ mt: 1.5 }} role="alert">
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
            <WarningAmberIcon fontSize="small" color="warning" />
            <Typography variant="caption" sx={{ fontWeight: 600 }}>
              {rejections.length} file{rejections.length === 1 ? ' was' : 's were'} not added
            </Typography>
            <IconButton
              size="small"
              onClick={() => setRejections([])}
              aria-label="Dismiss the list of skipped files"
            >
              <ClearIcon fontSize="small" />
            </IconButton>
          </Stack>
          <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {rejections.slice(0, 12).map((item) => (
              <Chip
                key={`${item.name}-${item.reason}`}
                size="small"
                variant="outlined"
                color="warning"
                label={`${item.name} — ${item.reason}`}
              />
            ))}
            {rejections.length > 12 && (
              <Chip size="small" variant="outlined" label={`+${rejections.length - 12} more`} />
            )}
          </Stack>
        </Box>
      )}

      {files.length > 0 && (
        <Box sx={{ mt: 2 }}>
          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}
          >
            <Typography variant="caption" color="text.secondary">
              {files.length <= PREVIEW_LIMIT
                ? 'Selected files'
                : `First ${PREVIEW_LIMIT} of ${files.length.toLocaleString()} selected files`}
            </Typography>
            <Button
              size="small"
              color="inherit"
              startIcon={<DeleteSweepIcon />}
              onClick={() => {
                onChange([])
                setRejections([])
              }}
              disabled={disabled}
            >
              Clear all
            </Button>
          </Stack>

          <List
            dense
            disablePadding
            sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, overflow: 'hidden' }}
          >
            {files.slice(0, PREVIEW_LIMIT).map((file, index) => (
              <ListItem
                key={keyOf(file)}
                divider={index < Math.min(files.length, PREVIEW_LIMIT) - 1}
                secondaryAction={
                  <IconButton
                    edge="end"
                    size="small"
                    onClick={() => removeAt(index)}
                    disabled={disabled}
                    aria-label={`Remove ${file.name}`}
                  >
                    <ClearIcon fontSize="small" />
                  </IconButton>
                }
              >
                <ListItemText
                  primary={file.name}
                  secondary={formatBytes(file.size)}
                  slotProps={{
                    primary: { noWrap: true, variant: 'body2' },
                    secondary: { variant: 'caption' },
                  }}
                />
              </ListItem>
            ))}
          </List>
        </Box>
      )}
    </Box>
  )
}
