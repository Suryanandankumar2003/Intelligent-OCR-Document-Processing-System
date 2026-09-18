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
 * failed upload.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import './FileSelect.css'

const ACCEPTED_TYPES = ['application/pdf', 'image/png', 'image/jpeg']
const ACCEPTED_EXTENSIONS = '.pdf,.png,.jpg,.jpeg'

export default function FileSelect({ selectedFile, onFileSelect, disabled }) {
  const inputRef = useRef(null)
  const [isDragActive, setIsDragActive] = useState(false)
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
      if (!file || !ACCEPTED_TYPES.includes(file.type)) return
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

  const openFileDialog = () => {
    if (!disabled) inputRef.current?.click()
  }

  return (
    <div
      className={[
        'file-select',
        isDragActive && 'file-select--active',
        disabled && 'file-select--disabled',
      ]
        .filter(Boolean)
        .join(' ')}
      onDragOver={(event) => {
        event.preventDefault()
        if (!disabled) setIsDragActive(true)
      }}
      onDragLeave={() => setIsDragActive(false)}
      onDrop={handleDrop}
      onClick={openFileDialog}
      role="button"
      tabIndex={0}
      aria-disabled={disabled}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openFileDialog()
        }
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS}
        onChange={handleInputChange}
        disabled={disabled}
        className="file-select__input"
        aria-hidden="true"
        tabIndex={-1}
      />

      {selectedFile ? (
        <div className="file-select__preview">
          {previewUrl && <img src={previewUrl} alt="" className="file-select__thumbnail" />}
          <div>
            <p className="file-select__filename">{selectedFile.name}</p>
            <p className="file-select__filesize">{formatBytes(selectedFile.size)}</p>
          </div>
        </div>
      ) : (
        <div className="file-select__prompt">
          <p>Drag &amp; drop a PAN card, Aadhaar card, invoice, or prescription</p>
          <p className="file-select__hint">or click to browse — PDF, PNG, or JPG, up to 10 MB</p>
        </div>
      )}
    </div>
  )
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
