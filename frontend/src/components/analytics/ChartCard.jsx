/**
 * The frame every chart on the analytics dashboard sits in: a card, a
 * title, an optional control on the right, and the plot area.
 *
 * Exists so the three widgets below it agree on padding, title size, and
 * where a per-chart control goes — the details that look arbitrary in
 * isolation and look broken when three cards disagree about them.
 *
 * `relative` positioning is not cosmetic: the hover tooltip is absolutely
 * positioned, and `useHoverTooltip` measures cursor coordinates against
 * this element's bounding box. Moving that ref anywhere else offsets
 * every tooltip on the page.
 */
import { Box, Card, CardContent, Stack, Typography } from '@mui/material'

export default function ChartCard({ title, action, children, containerRef, sx }) {
  return (
    <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column', ...sx }}>
      <CardContent
        sx={{ p: { xs: 2, sm: 2.5 }, flex: 1, display: 'flex', flexDirection: 'column' }}
      >
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', mb: 2 }}
        >
          <Typography variant="h4" component="h3">
            {title}
          </Typography>
          {action}
        </Stack>

        <Box ref={containerRef} sx={{ position: 'relative', flex: 1 }}>
          {children}
        </Box>
      </CardContent>
    </Card>
  )
}
