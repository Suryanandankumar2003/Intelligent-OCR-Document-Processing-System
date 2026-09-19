"""
Prompt template for document-type classification via Vertex AI's Gemini
content generation API.

Kept separate from `services/classification_service.py` so the wording
can be iterated on without touching request/response plumbing, and so
there is one obvious place to look when tuning model *behavior* instead
of code behavior. This module has no dependency on the `google-genai`
package or FastAPI — it only builds plain strings — so it can be
imported and unit-tested (e.g. snapshot-testing the prompt text) in
isolation.
"""
from core.document_types import DocumentType

# Rendered once at import time, not per-request: the label list only
# changes if `DocumentType` changes, so there is no reason to rebuild
# this string on every classification call.
_SUPPORTED_TYPES = ", ".join(f'"{doc_type.value}"' for doc_type in DocumentType)

CLASSIFICATION_SYSTEM_PROMPT = (
    "You are a document classification engine for an OCR pipeline. You "
    "read the raw OCR text of a scanned document and decide which of a "
    "fixed set of document types it belongs to. You never invent a type "
    "outside that set, and you never output anything besides the JSON "
    "object described below.\n\n"
    f"Supported document types: {_SUPPORTED_TYPES}.\n\n"
    "Classification rules:\n"
    '- "PAN Card": An Indian Permanent Account Number card issued by the '
    "Income Tax Department. Look for a 10-character alphanumeric PAN "
    '(e.g. ABCDE1234F), the phrase "Income Tax Department", "Permanent '
    'Account Number", or "Government of India" next to a PAN-shaped '
    "number.\n"
    '- "Aadhaar Card": An Indian Aadhaar identity document issued by '
    'UIDAI. Look for a 12-digit Aadhaar number, "UIDAI", or "Unique '
    'Identification Authority of India".\n'
    '- "Invoice": A commercial billing document. Look for terms like '
    '"Invoice No", "Bill To", "Invoice Date", line items with '
    "quantities and prices, tax amounts, or a total amount due.\n"
    '- "Medical Prescription": A prescription written by a doctor. Look '
    'for drug/medicine names, dosage instructions, "Rx", a doctor\'s '
    "name or registration number, or patient diagnosis notes.\n"
    '- "Test Report Form": A laboratory Test Report Form (TRF) that '
    "accompanies a specimen sent for diagnostic testing. Look for a "
    '"TRF" barcode/number, a "Client Code"/"Client Name" pair near the '
    'top, a "Specimen Type" or "Specimen Collection" checkbox section '
    "(e.g. Serum, Plasma, WB-EDTA), a referring doctor field, and test "
    "names/codes for the panel being ordered.\n"
    '- "Unknown": Use this whenever the text does not clearly match any '
    "of the above, or the text is too sparse or garbled to tell.\n\n"
    "Respond with ONLY a single JSON object — no markdown code fences, "
    "no explanation before or after it — matching exactly this shape:\n"
    '{"document_type": "<one of the supported types above, verbatim>", '
    '"confidence": "<your confidence as a decimal string between '
    '"0.00" and "1.00">"}'
)


def build_classification_prompt(extracted_text: str) -> tuple[str, str]:
    """
    Build the (system_instruction, user_content) pair for a single
    classification call.

    Returns plain strings, not SDK types (`types.Content`,
    `types.Part`), so this module — the one place prompt wording lives —
    has no dependency on the `google-genai` package; the request-shaping
    detail of how Vertex AI's `GenerateContentConfig` wants these values
    belongs to `services/classification_service.py`, the only module
    that actually talks to Vertex AI. Returned as a tuple rather than a
    single combined string because Gemini treats `system_instruction`
    and `contents` as separate fields, not one chat transcript.
    """
    user_content = (
        "Classify the following OCR-extracted document text.\n\n"
        "--- OCR TEXT START ---\n"
        f"{extracted_text}\n"
        "--- OCR TEXT END ---"
    )
    return CLASSIFICATION_SYSTEM_PROMPT, user_content
