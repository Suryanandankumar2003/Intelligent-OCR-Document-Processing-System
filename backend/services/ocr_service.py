"""
Business logic for running OCR (via Vertex AI's Gemini multimodal
content generation) against a document already saved by
`services/upload_service.py`.

Like `upload_service`, this stays independent of FastAPI: it takes a
plain stored filename and returns a plain dict, so it can be unit-tested
or reused (e.g. by a background worker) without touching HTTP concerns.

--- How OCR is done here ------------------------------------------------

Unlike Mistral (which had a dedicated `client.ocr.process` endpoint),
Vertex AI has no separate "OCR API" in this SDK — Gemini models read
documents/images directly as multimodal input. So "running OCR" here
means: read the stored file's bytes, hand them to Gemini as an inline
`Part` alongside a prompt asking it to transcribe the text verbatim, and
take the model's text response as the extraction result. Gemini accepts
a PDF's bytes directly (it processes every page internally) or an
image's bytes — no per-page chunking needed on our side either way.

Page counting works differently too: Gemini's response doesn't report
"pages processed" the way Mistral's OCR response did, so PDF page counts
here come from `pypdf` reading the file's own page tree directly (an
authoritative local fact, not something worth asking the model to
report and risk it getting wrong). A single image is always 1 page.
"""
import logging
import time
from io import BytesIO
from pathlib import Path

import aiofiles
import httpx
from google.genai import errors, types
from pypdf import PdfReader

from core.config import get_settings
from core.exceptions import (
    OCRAuthenticationError,
    OCRDocumentNotFoundError,
    OCRProcessingError,
    OCRRateLimitError,
    OCRTimeoutError,
    UnsupportedOCRFileTypeError,
)
from core.file_types import EXTENSION_TO_CONTENT_TYPE
from core.vertex_client import get_vertex_client

logger = logging.getLogger(__name__)
settings = get_settings()

OCR_PROMPT = (
    "Transcribe every piece of text visible in this document, exactly as "
    "it appears, preserving reading order and line breaks. Do not "
    "summarize, translate, or add commentary — output only the "
    "transcribed text, nothing else."
)


def _resolve_stored_path(stored_filename: str) -> Path:
    """
    Turn a client-supplied filename into a safe path inside UPLOAD_DIR.

    `Path(...).name` strips any directory components (e.g. "../../x"
    becomes "x"), which is what prevents this filename — taken from a
    URL path parameter — from being used to read files outside the
    uploads folder.
    """
    safe_name = Path(stored_filename).name
    file_path = settings.UPLOAD_DIR / safe_name

    if not file_path.is_file():
        raise OCRDocumentNotFoundError(safe_name)

    return file_path


def _count_pages(raw_bytes: bytes, content_type: str) -> int:
    """A single image is always 1 page; a PDF's page count comes from its own page tree."""
    if content_type != "application/pdf":
        return 1
    return len(PdfReader(BytesIO(raw_bytes)).pages)


def _translate_sdk_error(exc: errors.APIError, filename: str) -> OCRProcessingError:
    """Map a Vertex AI SDK error to one of our OCR-specific exceptions."""
    if exc.code in (401, 403):
        return OCRAuthenticationError()
    if exc.code == 429:
        return OCRRateLimitError()
    return OCRProcessingError(filename, exc.message or str(exc))


async def extract_text_from_stored_file(stored_filename: str) -> dict:
    """
    Run OCR (Gemini multimodal transcription) on a file previously saved
    via the upload endpoint.

    Returns a dict matching `schemas.ocr.OCRResultResponse`. Raises an
    `OCRError` subclass on any validation/upstream failure; the route
    layer relies on the global handlers registered in `app.py` instead
    of its own try/except.
    """
    file_path = _resolve_stored_path(stored_filename)

    content_type = EXTENSION_TO_CONTENT_TYPE.get(file_path.suffix.lower())
    if content_type is None:
        raise UnsupportedOCRFileTypeError(file_path.name)

    async with aiofiles.open(file_path, "rb") as source:
        raw_bytes = await source.read()

    client = get_vertex_client()
    document_part = types.Part.from_bytes(data=raw_bytes, mime_type=content_type)

    started_at = time.perf_counter()
    try:
        response = await client.aio.models.generate_content(
            model=settings.VERTEX_OCR_MODEL,
            contents=[document_part, OCR_PROMPT],
            config=types.GenerateContentConfig(
                temperature=0,
                http_options=types.HttpOptions(timeout=settings.VERTEX_OCR_TIMEOUT_SECONDS * 1000),
            ),
        )
    except errors.APIError as exc:
        raise _translate_sdk_error(exc, file_path.name) from exc
    except httpx.TimeoutException as exc:
        raise OCRTimeoutError(file_path.name) from exc
    except httpx.HTTPError as exc:
        raise OCRProcessingError(file_path.name, str(exc)) from exc
    processing_time_seconds = round(time.perf_counter() - started_at, 3)

    extracted_text = response.text or ""
    page_count = _count_pages(raw_bytes, content_type)

    logger.info(
        "OCR completed for '%s': %d page(s) in %.3fs",
        file_path.name,
        page_count,
        processing_time_seconds,
    )

    return {
        "filename": file_path.name,
        "model": response.model_version or settings.VERTEX_OCR_MODEL,
        "extracted_text": extracted_text,
        "page_count": page_count,
        "processing_time_seconds": processing_time_seconds,
    }
