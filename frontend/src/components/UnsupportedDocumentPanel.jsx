/**
 * What the user sees when classification comes back `Unknown`.
 *
 * The pipeline used to send this case to extraction anyway, collect the
 * backend's 422, and render a red "something went wrong" — for a document
 * that had in fact uploaded, transcribed, and classified without a single
 * failure. This panel replaces that dead end with the three things a
 * person can actually do about it:
 *
 *   1. Read the transcript, to see what the model saw.
 *   2. Download it, so the document isn't a total loss even if its type
 *      is genuinely unsupported.
 *   3. Name the type themselves and continue — the classifier being
 *      unsure says nothing about whether a human is.
 *
 * Presentation only, like every other component under components/: the
 * type list comes from `useExtractableDocumentTypes` and the actual
 * extraction call is `onExtractAs`, handed down from the pipeline hook.
 *
 * Styled as a warning, never an error: `severity="warning"` on the
 * explanation and a neutral card around it. Nothing failed here, and
 * painting it red would tell the user otherwise.
 */
import { useState } from 'react'
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  MenuItem,
  Stack,
  TextField,
} from '@mui/material'
import ErrorBanner from './ErrorBanner'
import OcrTextPanel from './OcrTextPanel'
import { useExtractableDocumentTypes } from '../hooks/useExtractableDocumentTypes'

export default function UnsupportedDocumentPanel({
  filename,
  ocrText,
  error,
  isExtracting,
  onExtractAs,
}) {
  const documentTypes = useExtractableDocumentTypes()
  const [selectedType, setSelectedType] = useState('')

  const handleSubmit = (event) => {
    event.preventDefault()
    if (selectedType && !isExtracting) onExtractAs(selectedType)
  }

  return (
    <Card>
      <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
        <Alert severity="warning" sx={{ mb: 2.5 }}>
          <AlertTitle>This document type is currently unsupported</AlertTitle>
          The classifier couldn&apos;t match this document to a type it has a field set for, so no
          fields were extracted. Nothing was lost — the file, its OCR text, and the classification
          result are all saved. If you know what this document is, choose its type below to extract
          its fields anyway.
        </Alert>

        {/* A failed manual attempt reports the backend's own message and
            leaves the selector in place, because trying another type is
            the obvious next move. */}
        {error && <ErrorBanner message={error} sx={{ mb: 2.5 }} />}

        <Box component="form" onSubmit={handleSubmit}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            sx={{ alignItems: { sm: 'flex-end' } }}
          >
            <TextField
              select
              label="Set the document type manually"
              value={selectedType}
              onChange={(event) => setSelectedType(event.target.value)}
              disabled={isExtracting}
              sx={{ minWidth: 260 }}
            >
              <MenuItem value="">
                <em>Choose a type…</em>
              </MenuItem>
              {documentTypes.map((documentType) => (
                <MenuItem key={documentType} value={documentType}>
                  {documentType}
                </MenuItem>
              ))}
            </TextField>

            <Button
              type="submit"
              variant="contained"
              disabled={!selectedType || isExtracting}
              startIcon={isExtracting ? <CircularProgress size={16} color="inherit" /> : null}
              sx={{ height: 40 }}
            >
              {isExtracting ? 'Extracting…' : 'Extract fields'}
            </Button>
          </Stack>
        </Box>

        <Divider sx={{ my: 3 }} />

        <OcrTextPanel text={ocrText} downloadName={`${filename ?? 'document'}.txt`} />
      </CardContent>
    </Card>
  )
}
