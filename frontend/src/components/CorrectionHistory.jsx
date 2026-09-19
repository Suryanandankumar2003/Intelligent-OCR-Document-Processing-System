/**
 * The audit trail: every correction saved for this document, oldest
 * first, as "extracted value -> corrected value" with a timestamp.
 *
 * Collapsed by default. The history is what makes the review auditable
 * rather than merely editable, but it is evidence to be consulted, not
 * the thing a reviewer is working on — the fields are.
 *
 * Note the two values shown are the *original extraction* and the
 * correction, not "before and after this particular edit". A field
 * corrected three times produces three entries that all cite the same
 * original, because the question this answers is "how far has this
 * drifted from what the model read off the page", which is what the
 * backend anchors every record to (see backend/services/review_service.py).
 */
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Chip,
  Stack,
  Typography,
} from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ArrowRightAltIcon from '@mui/icons-material/ArrowRightAlt'
import { humanizeFieldName } from '../utils/fieldLabels'

const EMPTY_DISPLAY = '— not found —'

function formatValue(value) {
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : EMPTY_DISPLAY
  if (value === null || value === undefined || value === '') return EMPTY_DISPLAY
  return value
}

function formatTimestamp(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export default function CorrectionHistory({ corrections }) {
  if (corrections.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary">
        No corrections have been saved for this document.
      </Typography>
    )
  }

  return (
    // `&::before` is MUI's divider line above an accordion; hidden
    // because this one sits alone under a form, not in a stack of
    // siblings that needs separating.
    <Accordion disableGutters sx={{ '&::before': { display: 'none' }, borderRadius: 2 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="subtitle2">Correction history</Typography>
          <Chip label={corrections.length} size="small" />
        </Stack>
      </AccordionSummary>

      <AccordionDetails sx={{ pt: 0 }}>
        <Stack component="ol" spacing={1.5} sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {corrections.map((correction) => (
            <Box
              component="li"
              key={correction.id}
              sx={{ pb: 1.5, borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0, pb: 0 } }}
            >
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                {humanizeFieldName(correction.field_name)}
              </Typography>

              <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography
                  variant="body2"
                  sx={{ color: 'text.secondary', textDecoration: 'line-through' }}
                >
                  {formatValue(correction.original_value)}
                </Typography>
                <ArrowRightAltIcon fontSize="small" sx={{ color: 'text.disabled' }} aria-label="corrected to" />
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {formatValue(correction.corrected_value)}
                </Typography>
              </Stack>

              <Typography
                component="time"
                dateTime={correction.corrected_at}
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mt: 0.5 }}
              >
                {formatTimestamp(correction.corrected_at)}
              </Typography>
            </Box>
          ))}
        </Stack>
      </AccordionDetails>
    </Accordion>
  )
}
