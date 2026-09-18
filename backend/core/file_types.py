"""
Single source of truth for which document types this system accepts.

Shared by `services/upload_service.py` (validating an incoming upload)
and `services/ocr_service.py` (re-deriving a stored file's content-type
from its extension, since the extension is all that's preserved once a
file is written to disk under its generated unique name).
"""
from pathlib import Path

# Whitelist of accepted MIME types, each mapped to the file extensions it
# may legitimately arrive with. Checking both the declared content-type
# AND the extension is a cheap way to catch obvious mismatches (e.g. a
# ".exe" renamed to claim "application/pdf"). It is not a substitute for
# real content sniffing (e.g. python-magic / libmagic) — flagged as a
# follow-up hardening step, not implemented here to avoid adding a
# native/system dependency at this stage.
ALLOWED_CONTENT_TYPES: dict[str, set[str]] = {
    "application/pdf": {".pdf"},
    "image/png": {".png"},
    "image/jpeg": {".jpg", ".jpeg"},
}

# Inverse of the mapping above: extension -> canonical content-type.
# Built once at import time so looking up a stored file's content-type
# from its (already-validated) extension is an O(1) dict lookup.
EXTENSION_TO_CONTENT_TYPE: dict[str, str] = {
    extension: content_type
    for content_type, extensions in ALLOWED_CONTENT_TYPES.items()
    for extension in extensions
}


def extension_of(filename: str) -> str:
    return Path(filename).suffix.lower()
