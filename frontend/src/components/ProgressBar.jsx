/**
 * A generic, determinate progress bar. Used today for the file-upload
 * byte progress inside PipelineSteps, but takes no knowledge of that —
 * just a percentage and an optional label — so it's reusable anywhere
 * else a 0–100 value needs a visual bar.
 */
import './ProgressBar.css'

export default function ProgressBar({ percent, label }) {
  // Clamped so a stray/rounding value from an event handler can never
  // render the fill outside the track (e.g. 100.4% or a transient -1%).
  const clamped = Math.min(100, Math.max(0, percent))

  return (
    <div
      className="progress-bar"
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="progress-bar__track">
        <div className="progress-bar__fill" style={{ width: `${clamped}%` }} />
      </div>
      {label && <span className="progress-bar__label">{label}</span>}
    </div>
  )
}
