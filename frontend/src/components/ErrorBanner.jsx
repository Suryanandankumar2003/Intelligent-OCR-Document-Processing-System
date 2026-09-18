/**
 * A dismissible inline alert for pipeline failures.
 *
 * Shows the exact message the failing backend call returned (see
 * useDocumentPipeline's extractErrorMessage) rather than a generic
 * "something went wrong" — the FastAPI backend's error responses are
 * already written to be read by a human (e.g. "File exceeds the maximum
 * allowed size of 10 MB.", see backend/core/exceptions.py), so
 * reproducing that wording here would only make it worse.
 */
import './ErrorBanner.css'

export default function ErrorBanner({ message, onDismiss }) {
  return (
    <div className="error-banner" role="alert">
      <span className="error-banner__icon" aria-hidden="true">
        ⚠
      </span>
      <p className="error-banner__message">{message}</p>
      {/* Dismissal is optional: an error the user can recover from
          (a rejected correction they can retype) is dismissible, while
          one that leaves the screen with nothing to show is not —
          a × that clears the last thing on the page is a dead end. */}
      {onDismiss && (
        <button type="button" className="error-banner__dismiss" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  )
}
