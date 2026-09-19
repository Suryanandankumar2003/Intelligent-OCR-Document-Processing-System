"""
Accepting and storing a multi-file batch upload.

The bulk counterpart to `services/upload_service.py`, and deliberately
not a loop over it: the two have different failure contracts, and that
difference is the whole design.

--- Why one bad file must not fail the request ------------------------

`save_uploaded_file` raises on an invalid file, because a single-file
upload with an invalid file has nothing left to do. A 200-file batch
with three `.docx` files in it has 197 perfectly good documents, and
rejecting the whole request would make the operator find and remove the
three by hand before retrying a multi-hundred-megabyte upload. So this
module *collects* rejections instead of raising them: every accepted file
is stored, every rejected one is reported back with the reason, and the
batch is created from whatever was accepted. The only cases that fail the
request outright are "no usable files at all" and "more files than the
per-request cap", because neither leaves anything to process.

--- Filenames --------------------------------------------------------

Same rule as the single-file service, and it matters more here because a
batch is a far more attractive place to hide one hostile name among
hundreds: the stored name is a freshly generated UUID plus the validated
extension, and the client's name is kept only as metadata
(`batch_files.original_filename`), never as a path component. There is no
code path in which a client-supplied string reaches the filesystem.
"""
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

import aiofiles
from fastapi import UploadFile

from core.config import get_settings
from core.exceptions import BatchTooLargeError, EmptyBatchError
from core.file_types import ALLOWED_CONTENT_TYPES, extension_of

logger = logging.getLogger(__name__)
settings = get_settings()

# Same chunk size as the single-file service: read and write in fixed
# blocks so a 500-file upload never holds more than one chunk of one file
# in memory, regardless of how large any of them are.
CHUNK_SIZE_BYTES = 1024 * 1024

# Control characters and the printable characters Windows forbids in a
# filename. Applied only to the *display* copy of the client's name — the
# stored path never contains any of it — so this is defence in depth
# against the name later being rendered, logged, or exported, not the
# thing preventing traversal.
_UNSAFE_DISPLAY_CHARS = set('<>:"/\\|?*') | {chr(code) for code in range(32)}


@dataclass
class RejectedFile:
    """One file that never made it into the batch, and why."""

    original_filename: str
    reason: str


@dataclass
class StagedBatch:
    """Everything `POST /batches/upload` needs after the files are on disk."""

    accepted: list[dict] = field(default_factory=list)
    rejected: list[RejectedFile] = field(default_factory=list)

    @property
    def total_bytes(self) -> int:
        return sum(entry["size_bytes"] for entry in self.accepted)


def sanitize_display_name(name: str) -> str:
    """
    Reduce a client-supplied filename to something safe to store and
    render.

    Strips directory components first (`Path(...).name`, which turns
    `../../etc/passwd` into `passwd` and `C:\\evil\\x.pdf` into `x.pdf`),
    then removes control and shell-hostile characters, then caps the
    length to fit the column.

    This value is *never* used to build a path — see the module
    docstring. It exists so the details page can show an operator the
    name they recognize.
    """
    base = Path(name or "").name
    cleaned = "".join(ch for ch in base if ch not in _UNSAFE_DISPLAY_CHARS).strip()
    # `.strip(". ")` because Windows silently drops trailing dots and
    # spaces, which is how "CON.pdf " and "CON.pdf" become the same name.
    cleaned = cleaned.strip(". ")
    return cleaned[:255] or "unnamed"


def _validate(upload: UploadFile) -> tuple[bool, str]:
    """
    Check one file's declared type against the whitelist. Returns
    `(is_valid, extension_or_reason)`.

    Both the content-type and the extension must agree, the same
    belt-and-braces check `core/file_types.py` documents: it catches an
    `.exe` renamed to claim `application/pdf`, which is the cheap half of
    the problem. It is not content sniffing, and the module-level comment
    in `core/file_types.py` already records that as the known gap.
    """
    filename = upload.filename or "unnamed"
    extension = extension_of(filename)
    allowed = ALLOWED_CONTENT_TYPES.get(upload.content_type or "")

    if not allowed:
        return False, f"Unsupported file type '{upload.content_type or 'unknown'}'. Use PDF, PNG, or JPG."
    if extension not in allowed:
        return False, f"Extension '{extension or '(none)'}' does not match content type '{upload.content_type}'."
    return True, extension


def _safe_delete(path: Path) -> None:
    """Best-effort cleanup of a partially written file; never raises."""
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("Could not remove partial batch upload at %s", path, exc_info=True)


async def _store_one(upload: UploadFile, extension: str) -> tuple[str, int]:
    """
    Stream one validated file to disk under a generated name. Returns
    `(stored_filename, size_bytes)`.

    Enforces the size cap *while streaming* rather than trusting a
    declared `content-length`: the header is client-supplied, and the
    point of the cap is to bound what an untrusted client can write to
    the disk. Exceeding it aborts mid-write and removes the partial file,
    so a hostile 10 GB upload costs one chunk of disk, not ten gigabytes.
    """
    stored_filename = f"{uuid.uuid4().hex}{extension}"
    destination = settings.UPLOAD_DIR / stored_filename
    max_bytes = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024
    total = 0

    try:
        async with aiofiles.open(destination, "wb") as buffer:
            while chunk := await upload.read(CHUNK_SIZE_BYTES):
                total += len(chunk)
                if total > max_bytes:
                    _safe_delete(destination)
                    raise ValueError(
                        f"File exceeds the maximum allowed size of {settings.MAX_UPLOAD_SIZE_MB} MB."
                    )
                await buffer.write(chunk)
    except OSError as exc:
        _safe_delete(destination)
        raise ValueError("Could not be saved to disk.") from exc

    if total == 0:
        _safe_delete(destination)
        raise ValueError("File is empty.")

    return stored_filename, total


async def stage_batch_files(uploads: Sequence[UploadFile]) -> StagedBatch:
    """
    Validate and store every file in a batch upload.

    Returns a `StagedBatch` carrying both halves of the outcome. Raises
    only for the two conditions that leave nothing to do:
    `BatchTooLargeError` (checked before a single byte is written, so an
    oversized request costs nothing) and `EmptyBatchError`.

    Files are stored sequentially rather than concurrently. It is
    tempting to `asyncio.gather` them, and it would be slower: this is
    bound by sequential writes to one local disk, and running 500 of them
    at once means 500 open file handles competing for the same spindle or
    SSD queue, with every one of them holding a chunk in memory.
    """
    if not uploads:
        raise EmptyBatchError()
    if len(uploads) > settings.MAX_BATCH_FILES:
        raise BatchTooLargeError(len(uploads), settings.MAX_BATCH_FILES)

    staged = StagedBatch()

    for upload in uploads:
        display_name = sanitize_display_name(upload.filename or "")
        try:
            is_valid, extension_or_reason = _validate(upload)
            if not is_valid:
                staged.rejected.append(RejectedFile(display_name, extension_or_reason))
                continue

            stored_filename, size_bytes = await _store_one(upload, extension_or_reason)
            staged.accepted.append(
                {
                    "filename": stored_filename,
                    "original_filename": display_name,
                    "size_bytes": size_bytes,
                }
            )
        except ValueError as exc:
            # Every per-file storage failure lands here as a rejection
            # rather than an exception, which is what keeps the other 499
            # files moving.
            staged.rejected.append(RejectedFile(display_name, str(exc)))
        except Exception as exc:  # noqa: BLE001 - one unexpected file must not sink the batch
            logger.exception("Unexpected error staging '%s'", display_name)
            staged.rejected.append(RejectedFile(display_name, f"Unexpected error: {exc}"))
        finally:
            await upload.close()

    if not staged.accepted:
        raise EmptyBatchError()

    logger.info(
        "Staged batch upload: %d accepted, %d rejected, %.1f MB total",
        len(staged.accepted),
        len(staged.rejected),
        staged.total_bytes / (1024 * 1024),
    )
    return staged


def default_batch_name() -> str:
    """A timestamped name for a batch the client didn't name, e.g. "Batch 2026-09-20 01:15"."""
    return f"Batch {datetime.now(timezone.utc):%Y-%m-%d %H:%M}"


def resolve_batch_name(supplied: str | None) -> str:
    """Trim and cap a client-supplied batch name, or fall back to the timestamped default."""
    cleaned = (supplied or "").strip()
    return cleaned[:200] if cleaned else default_batch_name()
