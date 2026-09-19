/**
 * The document types a human can manually assign to a document the
 * classifier couldn't identify.
 *
 * Loaded from the backend (`GET /document-types`) because that list is
 * derived from extraction's own schema map — a frontend copy would be one
 * deploy away from offering a type extraction doesn't support, which is
 * the 422 this whole flow exists to avoid.
 *
 * `FALLBACK_TYPES` covers the one case where a stale list beats no list:
 * the request itself failing. The selector stays usable, and picking a
 * type that has since stopped being supported fails with the backend's
 * own message rather than silently doing nothing.
 */
import { useEffect, useState } from 'react'
import { listExtractableDocumentTypes } from '../api/documents'

const FALLBACK_TYPES = [
  'PAN Card',
  'Aadhaar Card',
  'Invoice',
  'Medical Prescription',
  'Test Report Form',
]

export function useExtractableDocumentTypes() {
  const [documentTypes, setDocumentTypes] = useState(FALLBACK_TYPES)

  useEffect(() => {
    let ignore = false

    listExtractableDocumentTypes()
      .then((types) => {
        if (!ignore && Array.isArray(types) && types.length > 0) setDocumentTypes(types)
      })
      .catch(() => {
        // Intentionally silent: the fallback list is already on screen, so
        // there is nothing the user could do about this and nothing about
        // their document has gone wrong.
      })

    return () => {
      ignore = true
    }
  }, [])

  return documentTypes
}
