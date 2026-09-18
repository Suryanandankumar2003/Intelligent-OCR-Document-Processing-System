"""
Business logic for classifying a document's type from its already
extracted OCR text, via Vertex AI's Gemini content generation API.

Kept independent of FastAPI, the same pattern as `ocr_service.py`: it
takes a plain string and returns a plain dict, so it can be
unit-tested or reused without touching HTTP concerns.

--- How classification works ---------------------------------------------

This sends the OCR text to Gemini with a prompt (see
`services/prompts/classification_prompt.py`) that constrains it to a
fixed label set and instructs it to answer with a single JSON object.
Passing `response_mime_type="application/json"` makes Gemini guarantee
syntactically valid JSON back (the same role Mistral's `json_object`
mode played), so parsing here only has to handle *semantic* mismatches
(a missing key, an invented label) — not malformed JSON. Unlike
extraction, this deliberately does not also pass a `response_json_schema`:
classification's shape is fixed and simple enough that the prompt's own
description is sufficient, and extraction is where a schema actually
earns its keep (four different field sets to keep the model to exactly).
"""
import json
import logging

import httpx
from google.genai import errors, types

from core.config import get_settings
from core.document_types import DocumentType
from core.exceptions import (
    ClassificationAuthenticationError,
    ClassificationParsingError,
    ClassificationProcessingError,
    ClassificationRateLimitError,
    ClassificationTimeoutError,
    EmptyExtractedTextError,
)
from core.vertex_client import get_vertex_client
from services.prompts.classification_prompt import build_classification_prompt

logger = logging.getLogger(__name__)
settings = get_settings()


def _translate_sdk_error(exc: errors.APIError) -> ClassificationProcessingError:
    """Map a Vertex AI SDK error to one of our classification-specific exceptions."""
    if exc.code in (401, 403):
        return ClassificationAuthenticationError()
    if exc.code == 429:
        return ClassificationRateLimitError()
    return ClassificationProcessingError(exc.message or str(exc))


def _parse_model_response(content: str) -> dict:
    """
    Turn Gemini's raw JSON string into a validated {document_type, confidence} dict.

    Two separate failure modes are handled here on purpose:
      * malformed JSON (shouldn't happen with response_mime_type=
        "application/json", but a model can still misbehave) ->
        ClassificationParsingError.
      * a label outside our fixed set -> silently normalized to UNKNOWN
        rather than raised, since an unrecognized label is a valid
        outcome of classification (the document really doesn't match
        any known type), not a system failure.
    """
    try:
        payload = json.loads(content)
    except (json.JSONDecodeError, TypeError) as exc:
        raise ClassificationParsingError(f"response was not valid JSON: {content!r}") from exc

    raw_type = payload.get("document_type")
    try:
        document_type = DocumentType(raw_type)
    except ValueError:
        logger.warning("Vertex AI returned an unrecognized document_type %r; using Unknown", raw_type)
        document_type = DocumentType.UNKNOWN

    confidence = payload.get("confidence")
    if confidence is None:
        raise ClassificationParsingError("response is missing a 'confidence' field")

    return {"document_type": document_type, "confidence": str(confidence)}


async def classify_extracted_text(extracted_text: str) -> dict:
    """
    Classify OCR text into one of the supported document types.

    Returns a dict matching `schemas.classification.DocumentClassificationResponse`.
    Raises a `ClassificationError` subclass on any validation/upstream failure;
    the route layer relies on the global handlers registered in `app.py`
    instead of its own try/except.
    """
    if not extracted_text or not extracted_text.strip():
        raise EmptyExtractedTextError()

    # See VERTEX_CLASSIFICATION_MAX_TEXT_CHARS in core/config.py for why
    # this is capped rather than sent in full.
    truncated_text = extracted_text[: settings.VERTEX_CLASSIFICATION_MAX_TEXT_CHARS]
    system_instruction, user_content = build_classification_prompt(truncated_text)
    client = get_vertex_client()

    try:
        response = await client.aio.models.generate_content(
            model=settings.VERTEX_CLASSIFICATION_MODEL,
            contents=user_content,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                response_mime_type="application/json",
                # Classification should be deterministic and literal,
                # not creative — temperature=0 minimizes run-to-run
                # variance for the same input text.
                temperature=0,
                http_options=types.HttpOptions(timeout=settings.VERTEX_CLASSIFICATION_TIMEOUT_SECONDS * 1000),
            ),
        )
    except errors.APIError as exc:
        raise _translate_sdk_error(exc) from exc
    except httpx.TimeoutException as exc:
        raise ClassificationTimeoutError() from exc
    except httpx.HTTPError as exc:
        raise ClassificationProcessingError(str(exc)) from exc

    content = response.text
    if not isinstance(content, str):
        raise ClassificationParsingError(f"unexpected content type: {type(content).__name__}")

    result = _parse_model_response(content)

    logger.info(
        "Classified document as '%s' (confidence=%s)",
        result["document_type"].value,
        result["confidence"],
    )

    return result
