/**
 * Application shell: a header with the product name/subtitle, a
 * top-level tab between the two things this app does — process a
 * document, or look at how the pipeline is performing — and whichever
 * screen that tab selects.
 *
 * Still one piece of state per level rather than a router (see the
 * reasoning this comment used to carry when there were only two
 * screens): nothing here needs to be linkable or survive a reload yet.
 * `activeTab` picks between "process" and "analytics"; `reviewing` is a
 * second, independent piece of state nested *inside* the process tab —
 * reviewing a document is a detail view within "process a document",
 * not a sibling of it, so switching to the Analytics tab and back
 * doesn't lose your place in a review.
 */
import { useState } from 'react'
import AnalyticsPage from './pages/AnalyticsPage'
import ReviewPage from './pages/ReviewPage'
import UploadPage from './pages/UploadPage'
import './App.css'

const TABS = [
  { key: 'process', label: 'Process Documents' },
  { key: 'analytics', label: 'Analytics' },
]

export default function App() {
  const [activeTab, setActiveTab] = useState('process')
  const [reviewing, setReviewing] = useState(null)

  return (
    <div className="app">
      <header className="app__header">
        <h1>Intelligent OCR Document Processing</h1>
        <p className="app__subtitle">
          Upload a PAN card, Aadhaar card, invoice, or prescription to extract and classify its contents
        </p>
        <nav className="app__nav" aria-label="Main">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`app__nav-tab${activeTab === tab.key ? ' app__nav-tab--active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="app__main">
        {activeTab === 'analytics' ? (
          <AnalyticsPage />
        ) : reviewing ? (
          <ReviewPage
            key={reviewing.filename}
            filename={reviewing.filename}
            ocrText={reviewing.ocrText}
            onBack={() => setReviewing(null)}
          />
        ) : (
          <UploadPage onReview={(filename, ocrText) => setReviewing({ filename, ocrText })} />
        )}
      </main>
    </div>
  )
}
