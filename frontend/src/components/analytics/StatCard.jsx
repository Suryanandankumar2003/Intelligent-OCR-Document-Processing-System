/**
 * One headline number — the dataviz skill's "stat tile" form: a
 * sentence-case label with no trailing colon, then the value large and
 * semibold, with the supporting detail beneath it.
 *
 * `value === null` renders "No data yet" instead of the value slot —
 * every metric here can legitimately have nothing to show (e.g. average
 * processing time before any extraction has ever succeeded), and that's
 * a different, calmer message than a stray "0" or "NaN" would be.
 *
 * The optional `tone` tints the icon only, never the number itself: a
 * success rate painted red would be read as an error state, when what it
 * actually means is "this figure is low" — the icon carries that without
 * making the value itself look broken.
 */
import { Box, Card, CardContent, Stack, Typography } from '@mui/material'

export default function StatCard({ label, value, hint, icon: Icon, tone = 'primary' }) {
  return (
    <Card sx={{ height: '100%' }}>
      <CardContent>
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}
        >
          <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0 }}>
            {label}
          </Typography>
          {Icon && (
            <Box
              sx={{
                width: 32,
                height: 32,
                borderRadius: 1.5,
                display: 'grid',
                placeItems: 'center',
                flexShrink: 0,
                color: `${tone}.main`,
                bgcolor: (theme) => `${theme.palette[tone].main}1a`,
              }}
            >
              <Icon fontSize="small" />
            </Box>
          )}
        </Stack>

        <Typography
          variant="h2"
          component="p"
          sx={{
            mt: 1,
            // Proportional (not tabular) figures: this is a large
            // standalone number, not a column that has to align with
            // others, and proportional spacing reads better at this size.
            fontVariantNumeric: 'proportional-nums',
            color: value === null || value === undefined ? 'text.disabled' : 'text.primary',
            fontSize: value === null || value === undefined ? '1.125rem' : undefined,
            fontWeight: value === null || value === undefined ? 500 : 700,
          }}
        >
          {value ?? 'No data yet'}
        </Typography>

        {hint && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {hint}
          </Typography>
        )}
      </CardContent>
    </Card>
  )
}
