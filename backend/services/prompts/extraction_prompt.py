"""
Prompt templates and JSON Schema definitions for per-document-type
structured field extraction via Vertex AI's Gemini content generation
API.

Kept separate from `services/extraction_service.py`, same rationale as
`classification_prompt.py`: prompt/schema wording can be tuned without
touching request/response plumbing. This module has no dependency on
the `google-genai` package or FastAPI — it only builds plain dicts and
strings — so it can be imported and unit-tested in isolation.

--- "Structured extraction" ------------------------------------------

This uses Gemini's JSON-schema response mode (`response_mime_type=
"application/json"` plus `response_json_schema={...}`), which accepts
standard JSON Schema (a documented, explicit subset — see
`GenerateContentConfig.response_json_schema` in the `google-genai`
package) rather than the OpenAPI-flavored `response_schema` the SDK also
offers. It constrains the model to the exact property names and types
declared below, so a field that isn't present in the schema literally
cannot appear in the output, and every declared field is guaranteed
present (as its value or `null`) rather than sometimes-omitted. That is
what makes the four schemas below a reliable place to encode "handle
missing values": a nullable field is written as `"anyOf": [{"type":
"string"}, {"type": "null"}]` (the form Gemini's documented JSON Schema
subset explicitly supports — a bare `"type": ["string", "null"]` union
is not listed as supported) — the model is structurally required to
emit `null` rather than omit the key, so
`services/extraction_service.py` never has to guess whether a missing
key meant "not found" or "the model forgot to include it".
"""
from core.document_types import DocumentType

_BASE_INSTRUCTIONS = (
    "You are a field extraction engine for an OCR pipeline. You are given "
    "the raw OCR text of a single {document_type} and must extract a fixed "
    "set of fields from it, following the JSON schema you were given.\n\n"
    "Rules:\n"
    "- Extract values exactly as they appear in the text; do not guess, "
    "translate, or reformat them, unless a field's description says "
    "otherwise.\n"
    "- If a field is not present in the text, or you are not confident the "
    "value is correct, set it to null (or an empty array, for list "
    "fields) — never invent or hallucinate a value.\n"
    "- Respond with ONLY a single JSON object matching the schema. No "
    "markdown code fences, no commentary before or after it."
)

# Shorthand used by every nullable string field below, so each schema
# reads as "a string, or missing" without repeating the anyOf shape four
# times per schema. Deliberately a function (not a shared dict literal)
# so each field gets its own dict instance — schema dicts get mutated by
# some JSON Schema tooling, and sharing one instance across 16 field
# slots would make that mutation cross-contaminate unrelated fields.
def _nullable_string(description: str) -> dict:
    return {"description": description, "anyOf": [{"type": "string"}, {"type": "null"}]}


PAN_CARD_SCHEMA = {
    "type": "object",
    "properties": {
        "name": _nullable_string("Full name of the PAN card holder, exactly as printed"),
        "father_name": _nullable_string("Father's name as printed on the card"),
        "dob": _nullable_string("Date of birth as printed on the card, e.g. DD/MM/YYYY"),
        "pan_number": _nullable_string("10-character alphanumeric PAN, e.g. ABCDE1234F"),
    },
    "required": ["name", "father_name", "dob", "pan_number"],
    "additionalProperties": False,
}

AADHAAR_CARD_SCHEMA = {
    "type": "object",
    "properties": {
        "name": _nullable_string("Full name as printed on the Aadhaar card"),
        "dob": _nullable_string("Date of birth as printed, e.g. DD/MM/YYYY"),
        "gender": _nullable_string("Gender as printed, e.g. Male, Female, Other"),
        "aadhaar_number": _nullable_string("12-digit Aadhaar number, digits only or grouped in 4s"),
    },
    "required": ["name", "dob", "gender", "aadhaar_number"],
    "additionalProperties": False,
}

INVOICE_SCHEMA = {
    "type": "object",
    "properties": {
        "invoice_number": _nullable_string("Invoice/bill number"),
        "vendor_name": _nullable_string("Name of the vendor/seller issuing the invoice"),
        "invoice_date": _nullable_string("Date the invoice was issued, as printed"),
        "total_amount": _nullable_string("Final total amount due, including currency symbol if printed"),
    },
    "required": ["invoice_number", "vendor_name", "invoice_date", "total_amount"],
    "additionalProperties": False,
}

PRESCRIPTION_SCHEMA = {
    "type": "object",
    "properties": {
        "patient_name": _nullable_string("Patient's full name"),
        "doctor_name": _nullable_string("Prescribing doctor's full name"),
        "date": _nullable_string("Date the prescription was written, as printed"),
        "medicines": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Medicine names (with dosage/instructions if present); empty array if none found",
        },
    },
    "required": ["patient_name", "doctor_name", "date", "medicines"],
    "additionalProperties": False,
}

# json_schema per supported document type.
_SCHEMA_BY_TYPE: dict[DocumentType, dict] = {
    DocumentType.PAN_CARD: PAN_CARD_SCHEMA,
    DocumentType.AADHAAR_CARD: AADHAAR_CARD_SCHEMA,
    DocumentType.INVOICE: INVOICE_SCHEMA,
    DocumentType.MEDICAL_PRESCRIPTION: PRESCRIPTION_SCHEMA,
}


def get_extraction_schema(document_type: DocumentType) -> dict:
    """Return the JSON schema for a supported document type.

    Raises `KeyError` for `DocumentType.UNKNOWN` (or any type without a
    defined field set) — `services/extraction_service.py` catches that
    and translates it into `ExtractionUnsupportedDocumentTypeError`,
    keeping "which types are extractable" defined in exactly one place:
    the `_SCHEMA_BY_TYPE` map above.
    """
    return _SCHEMA_BY_TYPE[document_type]


def build_extraction_prompt(document_type: DocumentType, extracted_text: str) -> tuple[str, str]:
    """
    Build the (system_instruction, user_content) pair for a single
    extraction call.

    Returns plain strings, not SDK types, for the same reason as
    `classification_prompt.build_classification_prompt`: this module
    stays free of any dependency on the `google-genai` package.
    """
    system_instruction = _BASE_INSTRUCTIONS.format(document_type=document_type.value)
    user_content = (
        f"Extract fields from the following {document_type.value} OCR text.\n\n"
        "--- OCR TEXT START ---\n"
        f"{extracted_text}\n"
        "--- OCR TEXT END ---"
    )
    return system_instruction, user_content
