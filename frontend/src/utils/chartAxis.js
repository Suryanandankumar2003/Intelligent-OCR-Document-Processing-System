/**
 * "Nice" axis-tick computation shared by every chart on the analytics
 * dashboard, so a y-axis always lands on round numbers (0 / 5 / 10, not
 * 0 / 3.7 / 7.4) regardless of what the data's actual max happens to be
 * — the dataviz skill's "round to clean numbers, thousands-comma'd" rule.
 */

function niceStep(rawStep) {
  if (rawStep <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const residual = rawStep / magnitude
  let niceResidual
  if (residual <= 1) niceResidual = 1
  else if (residual <= 2) niceResidual = 2
  else if (residual <= 5) niceResidual = 5
  else niceResidual = 10
  return niceResidual * magnitude
}

/** `maxValue` -> `{ max, ticks }` where `ticks` are evenly spaced, round numbers from 0 to `max` (inclusive). */
export function computeYAxis(maxValue, targetTickCount = 4) {
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return { max: 1, ticks: [0, 1] }
  }
  const step = niceStep(maxValue / targetTickCount)
  const max = Math.ceil(maxValue / step) * step
  const ticks = []
  for (let value = 0; value <= max + step / 2; value += step) {
    ticks.push(Math.round(value))
  }
  return { max, ticks }
}
