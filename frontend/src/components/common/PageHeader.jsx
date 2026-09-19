/**
 * The block every screen opens with: a title, a sentence explaining what
 * the screen is for, and the screen's own actions on the right.
 *
 * A component rather than a copied `<Stack>` per page so the four
 * screens agree on the things that are easy to get subtly wrong across
 * files — the gap between title and description, where actions sit at
 * each breakpoint, and the fact that the actions wrap *below* the title
 * on a narrow screen instead of squeezing it.
 *
 * The title is an `<h2>`: the navbar already renders the section name as
 * the page's `<h1>`, and two `<h1>`s on one screen is a heading outline
 * that reads as two documents stitched together.
 */
import { Box, Stack, Typography } from '@mui/material'

export default function PageHeader({ title, description, actions, sx }) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={2}
      sx={{
        alignItems: { xs: 'stretch', sm: 'flex-start' },
        justifyContent: 'space-between',
        mb: 3,
        ...sx,
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h2" component="h2" sx={{ mb: description ? 0.75 : 0 }}>
          {title}
        </Typography>
        {description && (
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: '68ch' }}>
            {description}
          </Typography>
        )}
      </Box>

      {actions && (
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{
            flexWrap: 'wrap',
            flexShrink: 0,
            justifyContent: { xs: 'flex-start', sm: 'flex-end' },
          }}
        >
          {actions}
        </Stack>
      )}
    </Stack>
  )
}
