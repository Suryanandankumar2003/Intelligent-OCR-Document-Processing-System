/**
 * Displays the raw OCR text Vertex AI extracted, in a scrollable
 * fixed-height monospace block — a multi-page document's text can run
 * to thousands of characters, and this keeps that from pushing the rest
 * of the results panel far down the page.
 *
 * Includes a copy-to-clipboard button, since the practical reason to
 * show raw OCR text at all is usually to grab a piece of it (an ID
 * number, an address) rather than to read the whole block start to
 * finish.
 */
import { useState } from 'react'
import './OcrTextPanel.css'

export default function OcrTextPanel({ text }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text ?? '')
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied by the browser or OS sandbox;
      // the button simply not flipping to "Copied!" is an acceptable
      // degraded state here, not worth a full error banner over.
    }
  }

  return (
    <div className="ocr-text-panel">
      <div className="ocr-text-panel__header">
        <h3>OCR Text</h3>
        <button type="button" className="ocr-text-panel__copy" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="ocr-text-panel__body">{text || 'No text extracted.'}</pre>
    </div>
  )
}
