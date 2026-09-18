/**
 * Turns a backend field key into a label a person can read.
 *
 * Shared by the read-only results table and the review screen so the
 * same field is never called two different things in two places — the
 * kind of inconsistency that makes a reviewer wonder whether they're
 * looking at the same data.
 *
 * The map only covers the cases a mechanical snake_case-to-Title-Case
 * conversion gets wrong (acronyms, abbreviations). Everything else —
 * including a field added by a fifth document type later — falls
 * through to that conversion and still renders sensibly, which is what
 * keeps this from being a list that must be updated in lockstep with
 * backend/schemas/extraction.py.
 */
const FIELD_LABELS = {
  name: 'Name',
  father_name: "Father's Name",
  dob: 'Date of Birth',
  pan_number: 'PAN Number',
  gender: 'Gender',
  aadhaar_number: 'Aadhaar Number',
  invoice_number: 'Invoice Number',
  vendor_name: 'Vendor Name',
  invoice_date: 'Invoice Date',
  total_amount: 'Total Amount',
  patient_name: 'Patient Name',
  doctor_name: 'Doctor Name',
  date: 'Date',
  medicines: 'Medicines',
}

export function humanizeFieldName(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key]
  return key
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
