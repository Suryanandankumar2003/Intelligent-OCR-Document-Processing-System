/**
 * Loading placeholders shaped like the content they stand in for.
 *
 * --- Why these and not a spinner -------------------------------------
 *
 * A spinner says "wait"; a skeleton says "wait, and here is what is
 * coming". On screens whose layout is known in advance — a table with
 * six columns, four stat cards, a two-pane review — drawing that layout
 * greyed out means the page doesn't jump when data lands, because the
 * boxes were already the right size. That reflow is the actual cost a
 * spinner hides, and it's worst on exactly the screens that take longest
 * to load.
 *
 * Each skeleton below is therefore matched to a specific screen's
 * structure rather than being one generic "loading box" reused three
 * times — a skeleton whose shape doesn't match what replaces it is just
 * a spinner that flickers.
 *
 * Note they're all `aria-hidden` by way of MUI's `Skeleton`, which
 * renders decorative elements; the screens that use them also mark the
 * region `aria-busy`, so a screen reader is told "loading" once rather
 * than reading out a dozen empty boxes.
 */
import { Box, Card, CardContent, Skeleton, Stack, TableCell, TableRow } from '@mui/material'

/** Rows for the documents table, sized to its six columns. */
export function TableRowsSkeleton({ rows = 6, columns = 6 }) {
  return Array.from({ length: rows }, (_, rowIndex) => (
    <TableRow key={rowIndex}>
      {Array.from({ length: columns }, (_, columnIndex) => (
        <TableCell key={columnIndex}>
          <Skeleton
            variant="text"
            // Varied widths, because a grid of identical bars reads as a
            // loading *pattern* rather than as placeholder text.
            width={columnIndex === 0 ? '80%' : `${45 + ((rowIndex + columnIndex) % 4) * 12}%`}
            height={20}
          />
        </TableCell>
      ))}
    </TableRow>
  ))
}

/** The four headline numbers at the top of the analytics dashboard. */
export function StatCardsSkeleton({ count = 4 }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' },
      }}
    >
      {Array.from({ length: count }, (_, index) => (
        <Card key={index}>
          <CardContent>
            <Skeleton variant="text" width="65%" height={18} />
            <Skeleton variant="text" width="45%" height={38} sx={{ my: 0.5 }} />
            <Skeleton variant="text" width="55%" height={14} />
          </CardContent>
        </Card>
      ))}
    </Box>
  )
}

/** A chart card: title line plus a block the height of the plot area. */
export function ChartSkeleton({ height = 260 }) {
  return (
    <Card>
      <CardContent>
        <Skeleton variant="text" width={180} height={24} sx={{ mb: 2 }} />
        <Skeleton variant="rounded" height={height} />
      </CardContent>
    </Card>
  )
}

/** The whole analytics dashboard: cards, two charts, and the stage table. */
export function AnalyticsSkeleton() {
  return (
    <Stack spacing={2.5} aria-busy="true" aria-label="Loading analytics">
      <StatCardsSkeleton />
      <Box
        sx={{
          display: 'grid',
          gap: 2.5,
          gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 5fr) minmax(0, 7fr)' },
        }}
      >
        <ChartSkeleton height={280} />
        <ChartSkeleton height={280} />
      </Box>
      <ChartSkeleton height={180} />
    </Stack>
  )
}

/** The review screen's two panes, in the proportions the real layout uses. */
export function ReviewSkeleton() {
  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2.5,
        gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) minmax(0, 1fr)' },
      }}
      aria-busy="true"
      aria-label="Loading document"
    >
      <Card>
        <CardContent>
          <Skeleton variant="text" width={140} height={24} sx={{ mb: 2 }} />
          <Skeleton variant="rounded" height={420} />
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <Skeleton variant="text" width={160} height={24} sx={{ mb: 2 }} />
          <Stack spacing={2.5}>
            {Array.from({ length: 5 }, (_, index) => (
              <Box key={index}>
                <Skeleton variant="text" width={110} height={16} sx={{ mb: 0.75 }} />
                <Skeleton variant="rounded" height={40} />
              </Box>
            ))}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  )
}
