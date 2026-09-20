/**
 * How far a batch has got: a determinate bar, the percentage, and the
 * three counts underneath it.
 *
 * --- Why successes and failures are drawn as two segments ------------
 *
 * A single bar at 100% cannot distinguish "500 files processed" from
 * "497 processed and 3 failed", and those are entirely different
 * outcomes — the second one has work left for a person. Splitting the
 * filled portion into a success segment and a failure segment means the
 * shape of the bar itself carries the outcome, before anyone reads a
 * number. The two segments use the theme's semantic success/error
 * colors, and the counts below repeat them in text, because a color
 * difference alone is not something every reader can see.
 *
 * --- Why the percentage comes from the server ------------------------
 *
 * `progress_percentage` is computed and stored by the backend
 * (`batch_crud.recompute_batch_progress`) rather than derived here from
 * processed/total. One definition of "how far along" avoids the classic
 * split-brain where a page shows 99% next to "500 of 500" because the
 * two were rounded by different code.
 *
 * The bar is `aria-live` and carries a real `aria-valuenow`, so a screen
 * reader following a long batch is told the number as it moves rather
 * than having to re-read the page.
 */
import { Box, LinearProgress, Stack, Typography } from '@mui/material'
import { formatFileCount } from '../../utils/batchStatus'

/** One count under the bar: a colored dot, a number, a label. */
function Legend({ color, value, label }) {
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color, flexShrink: 0 }} />
      <Typography variant="caption" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        {value.toLocaleString()}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Stack>
  )
}

export default function BatchProgressBar({ progress, showLegend = true, height = 8 }) {
  if (!progress) return null

  const {
    total_files: total,
    successful_files: successful,
    failed_files: failed,
    processed_files: processed,
    progress_percentage: percentage,
  } = progress

  // Guarded against a zero-file batch, which cannot happen through the
  // upload endpoint (it rejects an empty batch) but would divide by zero
  // here if it ever did.
  const successShare = total > 0 ? (successful / total) * 100 : 0
  const failedShare = total > 0 ? (failed / total) * 100 : 0
  const remaining = Math.max(0, total - processed)

  return (
    <Box>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'baseline', justifyContent: 'space-between', mb: 0.75 }}
      >
        <Typography variant="body2" color="text.secondary">
          {processed.toLocaleString()} of {formatFileCount(total)} processed
        </Typography>
        <Typography
          variant="body2"
          sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
          aria-hidden="true"
        >
          {percentage.toFixed(percentage === 100 || percentage === 0 ? 0 : 1)}%
        </Typography>
      </Stack>

      <Box
        role="progressbar"
        aria-valuenow={Math.round(percentage)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Batch progress: ${Math.round(percentage)} percent, ${successful} succeeded, ${failed} failed`}
        aria-live="polite"
        sx={{
          position: 'relative',
          height,
          borderRadius: height / 2,
          overflow: 'hidden',
          bgcolor: 'action.hover',
          display: 'flex',
        }}
      >
        {/* Two absolutely-sized segments rather than one LinearProgress
            with a value: MUI's bar has a single fill, and stacking two
            of them would put one on top of the other. A flex row of two
            widths is both simpler and exactly what is meant. */}
        <Box
          sx={{
            width: `${successShare}%`,
            bgcolor: 'success.main',
            transition: 'width 300ms ease',
          }}
        />
        <Box
          sx={{
            width: `${failedShare}%`,
            bgcolor: 'error.main',
            transition: 'width 300ms ease',
          }}
        />
        {/* An indeterminate shimmer over the unfilled remainder while
            files are still in flight — the bar would otherwise look
            identical whether a worker was running or had died. */}
        {remaining > 0 && !progress.is_final && (
          <LinearProgress
            sx={{
              flex: 1,
              height: '100%',
              bgcolor: 'transparent',
              '& .MuiLinearProgress-bar': { bgcolor: 'info.light', opacity: 0.35 },
            }}
          />
        )}
      </Box>

      {showLegend && (
        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap', mt: 1 }}>
          <Legend color="success.main" value={successful} label="succeeded" />
          <Legend color="error.main" value={failed} label="failed" />
          <Legend color="action.disabled" value={remaining} label="remaining" />
        </Stack>
      )}
    </Box>
  )
}
