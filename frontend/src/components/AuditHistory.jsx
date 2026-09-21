/**
 * The Audit History panel: everything that has happened to this
 * document, as one chronological list a reviewer can read top to bottom.
 *
 * Replaces the earlier `CorrectionHistory`, and is a strict superset of
 * it. That component showed the `field_corrections` rows the review
 * payload already carried, which answered "what values changed" and
 * could not answer "who signed this off, and when" — because an approval
 * changes no value and therefore writes no correction row (see
 * backend/database/crud.py:save_review_decision on why inventing one
 * would make the trail say something untrue). The two halves now live in
 * two tables and are merged server-side; this renders the result.
 *
 * --- Collapsed by default, loaded on expand --------------------------
 *
 * The history is evidence to be consulted, not the thing a reviewer is
 * working on — the fields are. So the panel starts closed, and
 * `useDocumentAudit` does not fetch until it is opened, which keeps the
 * review screen's first paint to the one request it actually needs.
 *
 * --- Two kinds of row, one list --------------------------------------
 *
 * An action ("Document approved") and a field change ("'vendor_name'
 * changed") are visibly different — different icon, different colour,
 * and only the change shows a before and after — but they are one
 * sequence, because a reviewer asking what happened to this document
 * does not think of them as two lists to merge by eye.
 */
import { useState } from 'react'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Chip,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ArrowRightAltIcon from '@mui/icons-material/ArrowRightAlt'
import EditNoteIcon from '@mui/icons-material/EditNote'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import CancelIcon from '@mui/icons-material/Cancel'
import SaveIcon from '@mui/icons-material/Save'
import HistoryIcon from '@mui/icons-material/History'
import { useDocumentAudit } from '../hooks/useDocumentAudit'
import { humanizeFieldName } from '../utils/fieldLabels'

const EMPTY_DISPLAY = '— not found —'

/**
 * The icon and tone for one entry.
 *
 * Keyed on `event_type` rather than on `kind`, because the three actions
 * are not interchangeable: an approval and a rejection are opposite
 * outcomes, and giving them the same neutral icon would make a rejected
 * document look, at a glance, exactly like an approved one.
 */
const ENTRY_STYLE = {
  'Document Approved': { icon: CheckCircleIcon, color: 'success.main' },
  'Document Rejected': { icon: CancelIcon, color: 'error.main' },
  'Review Saved': { icon: SaveIcon, color: 'primary.main' },
}

const FIELD_CHANGE_STYLE = { icon: EditNoteIcon, color: 'text.secondary' }

function formatValue(value) {
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : EMPTY_DISPLAY
  if (value === null || value === undefined || value === '') return EMPTY_DISPLAY
  return String(value)
}

function formatTimestamp(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function AuditEntry({ entry }) {
  const style = entry.kind === 'action' ? (ENTRY_STYLE[entry.event_type] ?? FIELD_CHANGE_STYLE) : FIELD_CHANGE_STYLE
  const Icon = style.icon

  return (
    <Box
      component="li"
      sx={{
        display: 'flex',
        gap: 1.5,
        pb: 1.5,
        borderBottom: 1,
        borderColor: 'divider',
        '&:last-of-type': { borderBottom: 0, pb: 0 },
      }}
    >
      <Icon fontSize="small" sx={{ color: style.color, mt: 0.25, flexShrink: 0 }} />

      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="subtitle2" sx={{ mb: 0.25 }}>
          {entry.kind === 'field_change'
            ? humanizeFieldName(entry.field_name)
            : entry.summary}
        </Typography>

        {entry.kind === 'field_change' && (
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ alignItems: 'center', flexWrap: 'wrap' }}
          >
            {/* Struck through, because this is what the value *was* —
                and specifically what the model originally read, not what
                the previous correction left behind. See
                backend/services/review_service.py on why every entry
                cites the same original. */}
            <Typography
              variant="body2"
              sx={{ color: 'text.secondary', textDecoration: 'line-through' }}
            >
              {formatValue(entry.original_value)}
            </Typography>
            <ArrowRightAltIcon
              fontSize="small"
              sx={{ color: 'text.disabled' }}
              aria-label="changed to"
            />
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {formatValue(entry.updated_value)}
            </Typography>
          </Stack>
        )}

        {entry.changed_fields?.length > 0 && (
          <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.5 }}>
            {entry.changed_fields.map((field) => (
              <Chip key={field} label={humanizeFieldName(field)} size="small" variant="outlined" />
            ))}
          </Stack>
        )}

        <Typography
          component="time"
          dateTime={entry.occurred_at}
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 0.5 }}
        >
          {formatTimestamp(entry.occurred_at)}
        </Typography>
      </Box>
    </Box>
  )
}

export default function AuditHistory({ filename, refreshToken }) {
  const [isOpen, setIsOpen] = useState(false)
  const { audit, isLoading, error } = useDocumentAudit(filename, {
    enabled: isOpen,
    refreshToken,
  })

  // Shown on the closed summary once it is known. Before the first
  // expand there is no count, and inventing a placeholder number would
  // be worse than showing none — this panel's whole job is not
  // misstating what happened.
  const total = audit?.total_entries

  return (
    // `&::before` is MUI's divider line above an accordion; hidden
    // because this one sits alone under a form, not in a stack of
    // siblings that needs separating.
    <Accordion
      disableGutters
      expanded={isOpen}
      onChange={(_event, expanded) => setIsOpen(expanded)}
      sx={{ '&::before': { display: 'none' }, borderRadius: 2 }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <HistoryIcon fontSize="small" sx={{ color: 'text.secondary' }} />
          <Typography variant="subtitle2">Audit history</Typography>
          {total !== undefined && <Chip label={total} size="small" />}
        </Stack>
      </AccordionSummary>

      <AccordionDetails sx={{ pt: 0 }}>
        {error && (
          <Alert severity="warning" variant="outlined">
            {error}
          </Alert>
        )}

        {isLoading && !audit && (
          <Stack spacing={1.5} aria-busy="true" aria-label="Loading audit history">
            {Array.from({ length: 3 }, (_, index) => (
              <Box key={index}>
                <Skeleton variant="text" width="45%" height={18} />
                <Skeleton variant="text" width="70%" height={16} />
              </Box>
            ))}
          </Stack>
        )}

        {audit && audit.entries.length === 0 && (
          <Typography variant="caption" color="text.secondary">
            Nothing has been changed or decided on this document yet.
          </Typography>
        )}

        {audit && audit.entries.length > 0 && (
          <>
            <Stack component="ol" spacing={1.5} sx={{ listStyle: 'none', m: 0, p: 0 }}>
              {audit.entries.map((entry, index) => (
                <AuditEntry
                  // No stable id comes back — an entry is either a
                  // correction row or a log row, and the merged list
                  // deliberately does not expose which table it came
                  // from. The position plus the timestamp is unique in
                  // practice and the list is never reordered in place.
                  key={`${entry.occurred_at}-${entry.kind}-${index}`}
                  entry={entry}
                />
              ))}
            </Stack>

            {audit.total_entries > audit.entries.length && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                Showing the {audit.entries.length} most recent of {audit.total_entries} entries.
              </Typography>
            )}
          </>
        )}
      </AccordionDetails>
    </Accordion>
  )
}
