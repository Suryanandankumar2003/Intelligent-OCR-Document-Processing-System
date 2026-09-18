"""
Business logic for extracting structured fields from a document's
already-extracted OCR text, via Vertex AI's Gemini content generation
API in JSON-schema mode.

Kept independent of FastAPI, the same pattern as `ocr_service.py` and
`classification_service.py`: it takes plain inputs (a `DocumentType` and
a string) and returns a plain Pydantic model, so it can be unit-tested
or reused without touching HTTP concerns. It also doesn't know *how*
the text was produced or the type was decided — the caller (route
layer) runs OCR/classification first — which keeps this service usable
independently of both.

--- How this differs from classification ---------------------------------

`classification_service` asks a free-form question ("which of these
five labels?") with `response_mime_type="application/json"` alone.
Extraction needs a *fixed, typed field set per document type*, so it
additionally passes `response_json_schema` (see
`services/prompts/extraction_prompt.py` for why that's what "structured
extraction" means here): Gemini is constrained to the exact properties
declared in the schema, with every field either present or explicitly
`null`. That structural guarantee is what lets `schemas/extraction.py`
treat "missing" as a single, always-present `None` rather than an
omitted key it has to special-case.
"""
import json
import logging

import httpx
from google.genai import errors, types
from pydantic import ValidationError

from core.config import get_settings
from core.document_types import DocumentType
from core.exceptions import (
    EmptyExtractedTextError,
    ExtractionAuthenticationError,
    ExtractionParsingError,
    ExtractionProcessingError,
    ExtractionRateLimitError,
    ExtractionTimeoutError,
    ExtractionUnsupportedDocumentTypeError,
)
from core.vertex_client import get_vertex_client
from schemas.extraction import (
    AadhaarCardFields,
    ExtractedFields,
    InvoiceFields,
    PANCardFields,
    PrescriptionFields,
)
from services.prompts.extraction_prompt import build_extraction_prompt, get_extraction_schema

logger = logging.getLogger(__name__)
settings = get_settings()

# Which Pydantic model validates the field set for each document type.
# Lives in the service layer (as opposed to `schemas/extraction.py`)
# because it's a routing decision, not part of the API contract those
# schemas describe — but it is public, because extraction is no longer
# the only thing that needs it: `services/review_service.py` validates a
# reviewer's corrections against the very same model, so a
# human-corrected value is held to exactly the data-quality rules the
# model's own output was. One mapping, so the two can't drift.
EXTRACTION_MODEL_BY_TYPE = {
    DocumentType.PAN_CARD: PANCardFields,
    DocumentType.AADHAAR_CARD: AadhaarCardFields,
    DocumentType.INVOICE: InvoiceFields,
    DocumentType.MEDICAL_PRESCRIPTION: PrescriptionFields,
}


def _translate_sdk_error(exc: errors.APIError) -> ExtractionProcessingError:
    """Map a Vertex AI SDK error to one of our extraction-specific exceptions."""
    if exc.code in (401, 403):
        return ExtractionAuthenticationError()
    if exc.code == 429:
        return ExtractionRateLimitError()
    return ExtractionProcessingError(exc.message or str(exc))


async def extract_fields(document_type: DocumentType, extracted_text: str) -> ExtractedFields:
    """
    Extract the field set defined for `document_type` from `extracted_text`.

    Returns a `PANCardFields` / `AadhaarCardFields` / `InvoiceFields` /
    `PrescriptionFields` instance depending on `document_type` (see
    `schemas/extraction.py`) — never a raw dict, so every caller gets
    validated, missing-value-normalized data by construction.

    Raises:
      * `ExtractionUnsupportedDocumentTypeError` if `document_type` has
        no defined field schema (this includes `DocumentType.UNKNOWN`
        by design — there is nothing meaningful to extract from a
        document we couldn't classify).
      * `EmptyExtractedTextError` if `extracted_text` is blank.
      * An `ExtractionError` subclass for any upstream/parsing failure.

    The route layer relies on the global handlers registered in
    `app.py` instead of its own try/except.
    """
    try:
        model_cls = EXTRACTION_MODEL_BY_TYPE[document_type]
        json_schema = get_extraction_schema(document_type)
    except KeyError:
        raise ExtractionUnsupportedDocumentTypeError(document_type)

    if not extracted_text or not extracted_text.strip():
        raise EmptyExtractedTextError()

    # See VERTEX_EXTRACTION_MAX_TEXT_CHARS in core/config.py for why
    # this is capped rather than sent in full.
    truncated_text = extracted_text[: settings.VERTEX_EXTRACTION_MAX_TEXT_CHARS]
    system_instruction, user_content = build_extraction_prompt(document_type, truncated_text)
    client = get_vertex_client()

    try:
        response = await client.aio.models.generate_content(
            model=settings.VERTEX_EXTRACTION_MODEL,
            contents=user_content,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                response_mime_type="application/json",
                response_json_schema=json_schema,
                # Extraction should read off what's on the page, not
                # creatively fill gaps — temperature=0 minimizes
                # run-to-run variance for the same input text.
                temperature=0,
                http_options=types.HttpOptions(timeout=settings.VERTEX_EXTRACTION_TIMEOUT_SECONDS * 1000),
            ),
        )
    except errors.APIError as exc:
        raise _translate_sdk_error(exc) from exc
    except httpx.TimeoutException as exc:
        raise ExtractionTimeoutError() from exc
    except httpx.HTTPError as exc:
        raise ExtractionProcessingError(str(exc)) from exc

    content = response.text
    if not isinstance(content, str):
        raise ExtractionParsingError(f"unexpected content type: {type(content).__name__}")

    try:
        payload = json.loads(content)
    except (json.JSONDecodeError, TypeError) as exc:
        raise ExtractionParsingError(f"response was not valid JSON: {content!r}") from exc

    try:
        # `model_validate` is where the two validation layers described
        # in schemas/extraction.py's module docstring actually run
        # (blank/placeholder normalization, then format checks).
        fields = model_cls.model_validate(payload)
    except ValidationError as exc:
        raise ExtractionParsingError(
            f"response did not match the {document_type.value} schema: {exc}"
        ) from exc

    logger.info("Extracted fields for document_type=%s", document_type.value)

    return fields
