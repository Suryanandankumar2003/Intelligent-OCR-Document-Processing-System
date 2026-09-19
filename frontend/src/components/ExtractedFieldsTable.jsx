/**
 * Renders whichever field set the backend returned — PAN Card, Aadhaar
 * Card, Invoice, Medical Prescription, and Test Report Form each have a
 * different shape (see backend/schemas/extraction.py) — generically, as
 * label/value rows, instead of five hardcoded layouts picked by document
 * type.
 *
 * Extraction is only actually "generic" end to end if a future sixth
 * document type doesn't also require new frontend code — this component
 * makes no assumption about which keys are present, only about how to
 * render the two kinds of value it knows how to show: a plain scalar
 * (string or null) and a list (prescriptions' `medicines`).
 *
 * A definition list, not a `<table>`: these are name/value pairs for one
 * record, not rows to be compared across records, and `<dl>` is what
 * says that to a screen reader.
 */
import { Box, Chip, Stack, Typography } from '@mui/material'
import { humanizeFieldName } from '../utils/fieldLabels'

function FieldValue({ value }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <MissingValue label="None found" />
    return (
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {value.map((item, index) => (
          // eslint-disable-next-line react/no-array-index-key -- medicine names have no stable id of their own
          <Chip key={`${item}-${index}`} label={item} size="small" variant="outlined" />
        ))}
      </Stack>
    )
  }

  if (value === null || value === undefined || value === '')
    return <MissingValue label="Not found" />

  return (
    <Typography variant="body2" sx={{ fontWeight: 550, wordBreak: 'break-word' }}>
      {value}
    </Typography>
  )
}

/**
 * "The model found nothing here" — styled as absent rather than as an
 * error. A blank cell would be ambiguous (did extraction run?), and a
 * red one would claim something went wrong when nothing did.
 */
function MissingValue({ label }) {
  return (
    <Typography variant="body2" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>
      {label}
    </Typography>
  )
}

export default function ExtractedFieldsTable({ fields }) {
  const entries = Object.entries(fields ?? {})

  return (
    <Box component="dl" sx={{ m: 0, display: 'grid', gap: 0 }}>
      {entries.map(([key, value], index) => (
        <Box
          key={key}
          sx={{
            display: 'grid',
            // Label column on wide screens, stacked on narrow — a field
            // label and a long extracted address side by side at phone
            // width leaves about eight characters for each.
            gridTemplateColumns: { xs: '1fr', sm: 'minmax(140px, 34%) 1fr' },
            gap: { xs: 0.25, sm: 2 },
            py: 1.25,
            borderTop: index === 0 ? 0 : 1,
            borderColor: 'divider',
            alignItems: 'start',
          }}
        >
          <Typography component="dt" variant="body2" color="text.secondary">
            {humanizeFieldName(key)}
          </Typography>
          <Box component="dd" sx={{ m: 0, minWidth: 0 }}>
            <FieldValue value={value} />
          </Box>
        </Box>
      ))}
    </Box>
  )
}
