/**
 * The review screen's decision bar: Save, Approve, Reject.
 *
 * Spans the bottom of both panes and sticks there, so the three actions
 * are reachable without scrolling back up past a long transcript or a
 * fifteen-field form — on the one screen in this app where the content
 * is guaranteed to be taller than the viewport, an action bar that
 * scrolls away is an action bar you have to go looking for.
 *
 * --- Why three buttons and not one -----------------------------------
 *
 * They are three genuinely different backend operations, not one with
 * options:
 *
 *   * **Save** PATCHes only the fields that changed, leaves the reviewer
 *     on the screen, and is the only one of the three that writes data
 *     or appends to the audit trail. Disabled with nothing to save,
 *     because the endpoint rejects an empty correction set by design.
 *   * **Approve** POSTs a verdict on the fields as they stand. It is
 *     *not* a save: a reviewer who edits and then approves would lose
 *     those edits, so the button saves first when there are unsaved
 *     edits and only records the verdict if that write succeeded.
 *   * **Reject** POSTs the opposite verdict and never saves, because the
 *     edits are exactly what's being judged not worth keeping.
 *
 * Reject asks for confirmation; the other two don't. It's the only one
 * that throws work away, and it's adjacent to the button a reviewer
 * presses dozens of times a day.
 */
import { useState } from 'react'
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material'
import SaveIcon from '@mui/icons-material/Save'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import BlockIcon from '@mui/icons-material/Block'
import UndoIcon from '@mui/icons-material/Undo'

export default function ReviewActionBar({
  editedCount,
  isSaving,
  pendingDecision,
  reviewStatus,
  onSave,
  onDiscard,
  onApprove,
  onReject,
}) {
  const [confirmReject, setConfirmReject] = useState(false)

  // One action at a time: all three hit the same document, and letting a
  // reject land while a save is in flight would make the final state
  // depend on which request the network happened to finish first.
  const isBusy = isSaving || pendingDecision !== null
  const hasEdits = editedCount > 0

  return (
    <>
      <Paper
        elevation={0}
        sx={{
          position: 'sticky',
          bottom: 0,
          zIndex: 2,
          mt: 2.5,
          px: { xs: 2, sm: 2.5 },
          py: 1.75,
          borderRadius: 2,
          // Opaque, not translucent: content scrolls underneath this
          // bar, and a see-through background turns the button labels
          // into a moving jumble as it passes.
          bgcolor: 'background.paper',
          boxShadow: 3,
        }}
      >
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
        >
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography
              variant="body2"
              // `role="status"` so the count is announced when it
              // changes — a sighted reviewer sees the chips on the
              // edited fields, and this is the equivalent for everyone
              // else.
              role="status"
              sx={{
                fontWeight: hasEdits ? 650 : 400,
                color: hasEdits ? 'warning.main' : 'text.secondary',
              }}
            >
              {hasEdits
                ? `${editedCount} unsaved ${editedCount === 1 ? 'change' : 'changes'}`
                : 'No unsaved changes'}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Current status: {reviewStatus}
            </Typography>
          </Box>

          {hasEdits && (
            <Button
              variant="text"
              color="inherit"
              startIcon={<UndoIcon />}
              onClick={onDiscard}
              disabled={isBusy}
            >
              Discard
            </Button>
          )}

          <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', sm: 'block' } }} />

          <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
            {/* `<span>` wrappers: MUI's Tooltip can't attach a listener
                to a disabled button (it fires no pointer events), and
                the explanation is most needed precisely when the button
                is disabled. */}
            <Tooltip
              title={hasEdits ? 'Save your edits and stay here' : 'Nothing has been edited yet'}
            >
              <span>
                <Button
                  variant="outlined"
                  color="primary"
                  startIcon={
                    isSaving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />
                  }
                  onClick={onSave}
                  disabled={!hasEdits || isBusy}
                >
                  {isSaving ? 'Saving…' : 'Save'}
                </Button>
              </span>
            </Tooltip>

            <Tooltip
              title={
                hasEdits
                  ? 'Save your edits, then mark this document reviewed'
                  : 'Mark this document reviewed as-is'
              }
            >
              <span>
                <Button
                  variant="contained"
                  color="success"
                  startIcon={
                    pendingDecision === 'approve' ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      <CheckCircleIcon />
                    )
                  }
                  onClick={onApprove}
                  disabled={isBusy}
                >
                  Approve
                </Button>
              </span>
            </Tooltip>

            <Tooltip title="Mark this extraction unusable">
              <span>
                <Button
                  variant="outlined"
                  color="error"
                  startIcon={
                    pendingDecision === 'reject' ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      <BlockIcon />
                    )
                  }
                  onClick={() => setConfirmReject(true)}
                  disabled={isBusy}
                >
                  Reject
                </Button>
              </span>
            </Tooltip>
          </Stack>
        </Stack>
      </Paper>

      <Dialog open={confirmReject} onClose={() => setConfirmReject(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Reject this extraction?</DialogTitle>
        <DialogContent>
          <DialogContentText variant="body2">
            The document is marked unusable and excluded from the approved export. Nothing is
            deleted — the extraction, the transcript, and the correction history are kept, and you
            can approve it later.
            {hasEdits && (
              <Box component="span" sx={{ display: 'block', mt: 1.5, color: 'warning.main' }}>
                Your {editedCount} unsaved {editedCount === 1 ? 'change' : 'changes'} will not be
                saved.
              </Box>
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setConfirmReject(false)}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => {
              setConfirmReject(false)
              onReject()
            }}
          >
            Reject document
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
