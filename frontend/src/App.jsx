/**
 * The route table, wrapped in the application shell.
 *
 * Routing, not tab state. The screens used to be picked by two pieces of
 * `useState` here (`activeTab`, plus a nested `reviewing` holding the
 * filename handed over by the upload page), which meant a review screen
 * existed only as long as that state did: no URL to bookmark, nothing to
 * reload, and no way to reach a document processed yesterday. Each screen
 * is now a route, so a document's review screen is addressable by
 * `/documents/{filename}/review` and survives a refresh, and no screen
 * depends on another screen's state to be reachable.
 *
 * Route table:
 *   /                            process one document, or start a batch
 *   /batches                     the batch history
 *   /batches/:batchId            one batch, watched live
 *   /documents                   the persistent, searchable document list
 *   /documents/:filename/review  review one document, standalone
 *   /analytics                   pipeline health dashboard
 *   /logs                        every recorded event, searchable
 *   /logs/:logId                 one event in full, with its related records
 *
 * The chrome around all of them — sidebar, navbar, theme control — lives
 * in `AppLayout`, which wraps the whole `<Routes>` rather than each
 * screen. That's what keeps the sidebar from remounting (and the mobile
 * drawer from slamming shut) on every navigation.
 */
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import AppLayout from './components/layout/AppLayout'
import AnalyticsPage from './pages/AnalyticsPage'
import BatchDetailPage from './pages/BatchDetailPage'
import BatchesPage from './pages/BatchesPage'
import DocumentsPage from './pages/DocumentsPage'
import LogDetailPage from './pages/LogDetailPage'
import LogsPage from './pages/LogsPage'
import ReviewPage from './pages/ReviewPage'
import UploadPage from './pages/UploadPage'

/**
 * Mounts the review screen keyed by the document it's reviewing.
 *
 * Two review URLs are the same route, so React would otherwise keep one
 * mounted across a switch from one document to another — and
 * `useDocumentReview`'s loading state is per-document (it flips to
 * "loaded" once and stays there). Keying makes each document a fresh
 * mount, which is the same guarantee App used to give when it held the
 * reviewed filename in state.
 */
function ReviewRoute() {
  const { filename } = useParams()
  return <ReviewPage key={filename} />
}

/**
 * Mounts the batch details screen keyed by the batch it is showing.
 *
 * Same reason `ReviewRoute` is keyed: two batch URLs are the same route,
 * so React would keep one mounted across a switch from one batch to
 * another — and this screen holds an open SSE connection plus loading
 * state scoped to a single batch id. Keying makes each batch a fresh
 * mount, which closes the previous stream instead of leaving it feeding
 * a screen that has moved on.
 */
function BatchDetailRoute() {
  const { batchId } = useParams()
  return <BatchDetailPage key={batchId} />
}

/**
 * Mounts the log details screen keyed by the entry it is showing.
 *
 * Same reason the other two are keyed: two log URLs are the same route,
 * so React would keep one mounted across a switch from one entry to
 * another — and `useLogDetail` holds loading state scoped to a single
 * id. Reachable from the "related entries" links on the screen itself,
 * which is exactly the navigation that would otherwise show the
 * previous entry while the new one loaded.
 */
function LogDetailRoute() {
  const { logId } = useParams()
  return <LogDetailPage key={logId} />
}

export default function App() {
  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<UploadPage />} />
        <Route path="/batches" element={<BatchesPage />} />
        <Route path="/batches/:batchId" element={<BatchDetailRoute />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/documents/:filename/review" element={<ReviewRoute />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/logs/:logId" element={<LogDetailRoute />} />
        {/* A mistyped or stale URL lands on the upload screen rather
            than a blank page. `replace` keeps the bad URL out of
            history, so Back doesn't bounce straight back into it. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppLayout>
  )
}
