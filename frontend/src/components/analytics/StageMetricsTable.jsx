/**
 * Per-stage detail table: OCR, Classification, and Extraction, each
 * with its attempt/success/failure counts, success rate, and average
 * duration of a successful attempt — the full breakdown the stat cards
 * above only summarize two rows of (OCR and Extraction success rate).
 *
 * A table, not a third chart: this is exactly-three-rows of several
 * precise numbers per row, which a reader scans and compares cell by
 * cell — the case the dataviz skill's own form guidance defers to a
 * table for, rather than forcing it into bars or a grouped chart nobody
 * would read more precisely than the numbers themselves.
 *
 * Every numeric column is right-aligned and set in tabular figures, so
 * digits line up vertically and "1,204" and "998" can be compared by
 * length at a glance — the one typographic detail that decides whether a
 * table of numbers is scannable.
 */
import {
  Box,
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import { formatDurationMs, formatPercent } from '../../utils/analyticsFormat'

/**
 * Bands, not a gradient: a reader comparing three rows needs to know
 * "is this one fine" and a continuous color scale makes that a judgement
 * call at every glance.
 */
function successRateTone(successRate) {
  if (successRate === null) return 'text.disabled'
  if (successRate >= 0.95) return 'success.main'
  if (successRate >= 0.8) return 'warning.main'
  return 'error.main'
}

const NUMERIC_CELL = {
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

export default function StageMetricsTable({ stageMetrics }) {
  return (
    <Card>
      <CardContent sx={{ p: { xs: 2, sm: 2.5 } }}>
        <Typography variant="h4" component="h3" sx={{ mb: 2 }}>
          Pipeline stage detail
        </Typography>

        <TableContainer>
          <Table size="small" sx={{ minWidth: 620 }}>
            <TableHead>
              <TableRow>
                <TableCell>Stage</TableCell>
                <TableCell sx={{ textAlign: 'right' }}>Attempts</TableCell>
                <TableCell sx={{ textAlign: 'right' }}>Successes</TableCell>
                <TableCell sx={{ textAlign: 'right' }}>Failures</TableCell>
                <TableCell sx={{ textAlign: 'right' }}>Success rate</TableCell>
                <TableCell sx={{ textAlign: 'right' }}>Avg. duration</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {stageMetrics.map((row) => (
                <TableRow key={row.stage} hover>
                  <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>
                    {row.stage}
                  </TableCell>
                  <TableCell sx={NUMERIC_CELL}>{row.attempts.toLocaleString()}</TableCell>
                  <TableCell sx={NUMERIC_CELL}>{row.successes.toLocaleString()}</TableCell>
                  <TableCell sx={NUMERIC_CELL}>{row.failures.toLocaleString()}</TableCell>
                  <TableCell sx={NUMERIC_CELL}>
                    {row.success_rate === null ? (
                      <Typography variant="caption" color="text.disabled">
                        No attempts yet
                      </Typography>
                    ) : (
                      <Box
                        component="span"
                        sx={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 0.75,
                          fontWeight: 650,
                          color: successRateTone(row.success_rate),
                        }}
                      >
                        {/* The dot repeats the color as a second visual
                            channel — the figure itself still reads at any
                            color vision, and the dot is what makes the
                            three rows comparable at a glance. */}
                        <Box
                          component="span"
                          sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: 'currentColor' }}
                          aria-hidden="true"
                        />
                        {formatPercent(row.success_rate)}
                      </Box>
                    )}
                  </TableCell>
                  <TableCell sx={NUMERIC_CELL}>
                    {row.average_duration_ms === null ? (
                      <Typography component="span" variant="body2" color="text.disabled">
                        —
                      </Typography>
                    ) : (
                      formatDurationMs(row.average_duration_ms)
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </CardContent>
    </Card>
  )
}
