/**
 * What a screen shows when there is genuinely nothing to show.
 *
 * Deliberately not the same thing as an error and not the same thing as
 * loading — which is exactly why it's a component. The three states get
 * confused when each is written ad hoc per screen, and a user who can't
 * tell "no documents match your filters" from "the request failed" will
 * reach for the wrong fix every time.
 *
 * The `action` slot is the part that earns its keep. An empty state that
 * only says "nothing here" leaves the user to work out what would change
 * that; every use of this component in the app passes the next step —
 * clear the filters, process a document — as a real control.
 */
import { Box, Stack, Typography } from '@mui/material'

export default function EmptyState({ icon: Icon, title, description, action, dense = false, sx }) {
  return (
    <Stack
      spacing={1.5}
      sx={{
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        px: 3,
        py: dense ? 4 : 7,
        ...sx,
      }}
    >
      {Icon && (
        <Box
          sx={{
            width: 52,
            height: 52,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            // Tinted rather than filled: an empty state is a calm,
            // expected condition, and a saturated icon badge would give
            // it the visual weight of an alert.
            bgcolor: 'action.hover',
            color: 'text.secondary',
            mb: 0.5,
          }}
        >
          <Icon />
        </Box>
      )}

      <Typography variant="h5" component="p">
        {title}
      </Typography>

      {description && (
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: '46ch' }}>
          {description}
        </Typography>
      )}

      {action && <Box sx={{ pt: 1 }}>{action}</Box>}
    </Stack>
  )
}
