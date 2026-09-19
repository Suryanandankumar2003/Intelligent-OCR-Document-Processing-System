/**
 * The editable field set at the centre of the review screen: every
 * field the backend extracted, rendered as an input a reviewer can
 * correct, with the model's original value kept visible next to
 * anything that's been changed.
 *
 * Generic over field names, the same way the read-only table is: it
 * renders whatever keys the document's field set actually has rather
 * than hardcoding five layouts, so a sixth document type added to
 * backend/schemas/extraction.py becomes editable here for free. The only
 * distinction it draws is between a scalar (one input) and a list like a
 * prescription's `medicines` (a multiline field, one entry per line).
 *
 * Presentation only. The edit buffer, the diff against what's stored,
 * and the "which fields do we send" rule all live in `useReviewDraft` —
 * this component reads them and renders. That split is what lets the
 * Save/Approve/Reject bar at the bottom of the screen sit outside this
 * component while still acting on the same edits.
 */
import { Box, Chip, InputAdornment, Stack, TextField, Tooltip, Typography } from '@mui/material'
import HistoryIcon from '@mui/icons-material/History'
import { humanizeFieldName } from '../utils/fieldLabels'
import { EMPTY_DISPLAY, formatForDisplay } from '../hooks/useReviewDraft'

export default function DocumentReviewForm({ fields, onFieldChange, disabled }) {
  return (
    <Stack spacing={2.5} component="fieldset" sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
      {fields.map((field) => {
        const { name, isList, text, hasUnsavedEdit, isCorrected, originalValue } = field

        return (
          <Box key={name}>
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 0.75 }}
              useFlexGap
            >
              <Typography
                component="label"
                htmlFor={`review-field-${name}`}
                variant="subtitle2"
                sx={{ color: 'text.secondary' }}
              >
                {humanizeFieldName(name)}
              </Typography>

              {/* Two different facts, never merged into one badge:
                  "Corrected" means the stored value already differs from
                  what the model read, "Unsaved" means this input differs
                  from what's stored. A field can legitimately be both. */}
              {isCorrected && (
                <Chip
                  label="Corrected"
                  size="small"
                  color="success"
                  variant="outlined"
                  icon={<HistoryIcon />}
                />
              )}
              {hasUnsavedEdit && <Chip label="Unsaved" size="small" color="warning" />}
            </Stack>

            <TextField
              id={`review-field-${name}`}
              value={text}
              onChange={(event) => onFieldChange(name, event.target.value)}
              disabled={disabled}
              fullWidth
              multiline={isList}
              minRows={isList ? 3 : undefined}
              placeholder={isList ? 'One per line' : EMPTY_DISPLAY}
              // A subtle tint rather than a border color change: at five
              // to ten fields on screen, an outline swap on every edited
              // input turns the pane into a grid of alarms.
              sx={{
                '& .MuiOutlinedInput-root': {
                  bgcolor: hasUnsavedEdit ? 'action.hover' : 'background.paper',
                },
              }}
              slotProps={{
                input: isList
                  ? undefined
                  : {
                      endAdornment: hasUnsavedEdit ? (
                        <InputAdornment position="end">
                          <Tooltip title="Edited — not saved yet">
                            <Box
                              sx={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                bgcolor: 'warning.main',
                              }}
                            />
                          </Tooltip>
                        </InputAdornment>
                      ) : null,
                    },
              }}
            />

            {isCorrected && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mt: 0.5 }}
              >
                Extracted value:{' '}
                <Box component="span" sx={{ color: 'text.primary', fontWeight: 550 }}>
                  {formatForDisplay(originalValue)}
                </Box>
              </Typography>
            )}
          </Box>
        )
      })}
    </Stack>
  )
}
