"""
Business logic for storing an uploaded document on disk.

Kept independent of FastAPI's request/response cycle (it only takes an
`UploadFile` and returns a plain dict) so it can be unit-tested or reused
by a future OCR pipeline without touching HTTP concerns.
"""
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

import aiofiles
from fastapi import UploadFile

from core.config import get_settings
from core.exceptions import (
    EmptyFileError,
    FileSaveError,
    FileTooLargeError,
    UnsupportedFileTypeError,
)
from core.file_types import ALLOWED_CONTENT_TYPES, extension_of

logger = logging.getLogger(__name__)
settings = get_settings()

# Read/write in fixed-size chunks instead of loading the whole file into
# memory, so a large upload can't exhaust server RAM.
CHUNK_SIZE_BYTES = 1024 * 1024  # 1 MB


def _validate_file(upload: UploadFile) -> str:
    """Return the validated lowercase extension, or raise UnsupportedFileTypeError."""
    filename = upload.filename or "unnamed file"
    extension = extension_of(filename)
    allowed_extensions = ALLOWED_CONTENT_TYPES.get(upload.content_type or "")

    if not allowed_extensions or extension not in allowed_extensions:
        raise UnsupportedFileTypeError(upload.content_type or "unknown", filename)

    return extension


def _build_unique_filename(extension: str) -> str:
    """
    Generate a collision-safe filename for disk storage.

    Deliberately does NOT reuse any part of the client-supplied filename:
    that value is untrusted and using it directly in a filesystem path is
    a classic path-traversal / overwrite vector (e.g. "../../app.py").
    The original name is preserved only as metadata, never as a path.
    """
    return f"{uuid.uuid4().hex}{extension}"


def _safe_delete(path: Path) -> None:
    """Best-effort cleanup of a partially written file; never raises."""
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("Could not remove partial upload at %s", path, exc_info=True)


async def save_uploaded_file(upload: UploadFile) -> dict:
    """
    Validate, stream to disk, and describe an uploaded file.

    Returns a dict matching `schemas.document.UploadResponse`.
    Raises a `DocumentUploadError` subclass on any validation/IO failure;
    the caller (route layer) does not need its own try/except because
    `app.py` registers global handlers for these exception types.
    """
    extension = _validate_file(upload)
    stored_filename = _build_unique_filename(extension)
    destination = settings.UPLOAD_DIR / stored_filename
    max_size_bytes = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024
    original_filename = upload.filename or stored_filename
    total_bytes = 0

    try:
        async with aiofiles.open(destination, "wb") as buffer:
            while chunk := await upload.read(CHUNK_SIZE_BYTES):
                total_bytes += len(chunk)
                if total_bytes > max_size_bytes:
                    raise FileTooLargeError(original_filename, settings.MAX_UPLOAD_SIZE_MB)
                await buffer.write(chunk)
    except FileTooLargeError:
        _safe_delete(destination)
        raise
    except OSError as exc:
        _safe_delete(destination)
        raise FileSaveError(original_filename) from exc
    finally:
        await upload.close()

    if total_bytes == 0:
        _safe_delete(destination)
        raise EmptyFileError(original_filename)

    logger.info("Stored upload '%s' as '%s' (%d bytes)", original_filename, stored_filename, total_bytes)

    return {
        "filename": stored_filename,
        "original_filename": original_filename,
        "content_type": upload.content_type or "application/octet-stream",
        "size_bytes": total_bytes,
        "uploaded_at": datetime.now(timezone.utc),
    }
