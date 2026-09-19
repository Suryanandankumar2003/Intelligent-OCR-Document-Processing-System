/**
 * Composes the three result views once the pipeline finishes: the
 * classified document type (with confidence), the structured extracted
 * fields, and the raw OCR text — the "show OCR text, document type,
 * extracted fields" requirement, laid out together as one panel.
 *
 * A thin layout component on purpose — all the actual rendering logic
 * lives in its two children, so this file stays readable as "what order
 * do these things appear in", not "how is any of them rendered".
 *
 * The two panes are a grid that collapses to one column below `lg`.
 * Side by side is the useful arrangement — the whole point is checking a
 * field against the text it came from — but only when both panes are
 * wide enough to read; stacked beats two 300px columns.
 */
import { Box, Card, CardContent, Divider, Stack, Typography } from '@mui/material'
import DocumentTypeBadge from './DocumentTypeBadge'
import ExtractedFieldsTable from './ExtractedFieldsTable'
import OcrTextPanel from './OcrTextPanel'

export default function ResultsPanel({ documentType, confidence, ocrText, fields }) {
  return (
    <Card>
      <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
        <Stack
          direction="row"
          useFlexGap
          spacing={1.5}
          sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', mb: 2 }}
        >
          <Typography variant="h3" component="h2">
            Results
          </Typography>
          <DocumentTypeBadge documentType={documentType} confidence={confidence} />
        </Stack>

        <Divider sx={{ mb: 2.5 }} />

        <Box
          sx={{
            display: 'grid',
            gap: { xs: 3, lg: 4 },
            gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) minmax(0, 1fr)' },
          }}
        >
          <Box>
            <Typography variant="h4" component="h3" sx={{ mb: 1.5 }}>
              Extracted fields
            </Typography>
            <ExtractedFieldsTable fields={fields} />
          </Box>

          <OcrTextPanel text={ocrText} />
        </Box>
      </CardContent>
    </Card>
  )
}
