/**
 * Shows the classified document type as a colored chip, plus Vertex
 * AI's confidence as a percentage.
 *
 * `confidence` arrives from the backend as a decimal string like "0.93"
 * (see backend/schemas/classification.py — it's a string, not a float,
 * in the API contract on purpose). Parsing it into a percentage is a
 * pure display concern, so it happens here at the UI boundary rather
 * than asking the backend to pre-format a percentage string.
 *
 * The chip's color comes from the same `--chart-*` custom properties the
 * analytics charts use, not from a second palette defined here: a PAN
 * Card is the same blue in a table row as it is in the "documents by
 * type" bar chart, in both light and dark mode, because there is only
 * one definition of that blue (see theme/GlobalStyles.jsx).
 */
import { Box, Chip, Typography } from '@mui/material'

const COLOR_BY_TYPE = {
  'PAN Card': 'var(--chart-pan)',
  'Aadhaar Card': 'var(--chart-aadhaar)',
  Invoice: 'var(--chart-invoice)',
  'Medical Prescription': 'var(--chart-prescription)',
  'Test Report Form': 'var(--chart-trf)',
  Unknown: 'var(--chart-unknown)',
}

export default function DocumentTypeBadge({ documentType, confidence, size = 'small' }) {
  const color = COLOR_BY_TYPE[documentType] ?? COLOR_BY_TYPE.Unknown
  const confidenceFraction = Number.parseFloat(confidence)
  const showConfidence = Number.isFinite(confidenceFraction)

  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      <Chip
        label={documentType}
        size={size}
        variant="outlined"
        sx={{
          // A tinted fill plus a full-strength border and label, rather
          // than a solid chip: at the density of a table this reads as a
          // category marker instead of a row of competing buttons, and
          // the `color-mix` keeps one hue definition working on both a
          // white and a near-black surface.
          color,
          borderColor: color,
          backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
          fontWeight: 650,
        }}
      />
      {showConfidence && (
        <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
          {Math.round(confidenceFraction * 100)}% confidence
        </Typography>
      )}
    </Box>
  )
}
