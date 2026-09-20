"""
Read and delete endpoints over persisted `Document` records — the
browsable CRUD surface for whatever the upload/extraction pipeline has
saved to the database so far.

The "Create" and "Update" halves of CRUD are deliberately not exposed
here as generic endpoints: a Document row is only ever meaningfully
created by `POST /upload` (a new record needs an actual uploaded file
behind it) and only ever meaningfully updated by `POST
/documents/{filename}/extract` (its "update" is specifically "attach an
extraction result"). Exposing raw create/update endpoints here would let
a client write a Document row with no matching file on disk, which
isn't a state this system should be able to get into.
"""
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from core.config import get_settings
from core.document_types import DocumentType
from core.file_types import EXTENSION_TO_CONTENT_TYPE
from database import crud
from database.session import get_db
from schemas.document import DocumentRecordResponse

settings = get_settings()

router = APIRouter(prefix="/documents", tags=["Document Records"])


@router.get(
    "",
    response_model=list[DocumentRecordResponse],
    summary="List stored document records",
)
def list_document_records(
    skip: int = Query(default=0, ge=0, description="Number of records to skip"),
    limit: int = Query(default=100, ge=1, le=500, description="Maximum number of records to return"),
    document_type: Optional[DocumentType] = Query(
        default=None, description="Filter to only this document type"
    ),
    db: Session = Depends(get_db),
) -> list[DocumentRecordResponse]:
    """Most recently uploaded first. See `database.crud.list_documents`."""
    return crud.list_documents(db, skip=skip, limit=limit, document_type=document_type)


@router.get(
    "/{filename}",
    response_model=DocumentRecordResponse,
    summary="Get a stored document record",
)
def get_document_record(filename: str, db: Session = Depends(get_db)) -> DocumentRecordResponse:
    document = crud.get_document_by_filename(db, filename)
    if document is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"No document record found for '{filename}'.")
    return document


@router.get(
    "/{filename}/file",
    summary="Serve the original uploaded file",
    response_class=FileResponse,
    responses={
        200: {"content": {"application/pdf": {}, "image/png": {}, "image/jpeg": {}}},
        404: {"description": "No such file in uploads/"},
    },
)
def get_document_file(filename: str) -> FileResponse:
    """
    Return the stored file itself — the scan or PDF the operator
    uploaded — so the review screen can show the source next to the
    fields extracted from it.

    --- Why this reads the disk, not the database ----------------------

    Deliberately keyed on the file existing rather than on a `Document`
    row existing. The resource here *is* the file: a batch file that
    failed before extraction has no document record and is exactly the
    case someone most wants to look at. Every other endpoint in this
    module is about the record, which is why this one says so.

    --- Path safety ----------------------------------------------------

    `filename` arrives from the URL, so `Path(...).name` strips any
    directory components before it is joined to `UPLOAD_DIR` — the same
    guard `services/ocr_service.py:_resolve_stored_path` applies, and the
    reason `../../` in this parameter reaches nothing. The extension is
    then checked against the upload allow-list, so this can only ever
    serve the three types the system accepts, whatever else may have
    ended up in that folder.

    --- Inline, and cached ---------------------------------------------

    `Content-Disposition: inline` lets the browser render the file in
    place instead of downloading it, which is the whole point. Stored
    names are generated UUIDs and a given name's bytes never change, so
    the response is immutable and says so: without that, every remount
    of the review screen re-fetches a multi-megabyte scan.
    """
    safe_name = Path(filename).name
    file_path = settings.UPLOAD_DIR / safe_name

    content_type = EXTENSION_TO_CONTENT_TYPE.get(file_path.suffix.lower())
    if content_type is None or not file_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No uploaded file found for '{safe_name}'.",
        )

    return FileResponse(
        file_path,
        media_type=content_type,
        headers={
            "Content-Disposition": f'inline; filename="{safe_name}"',
            "Cache-Control": "private, max-age=3600, immutable",
        },
    )


@router.delete(
    "/{filename}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a stored document record",
)
def delete_document_record(filename: str, db: Session = Depends(get_db)) -> None:
    """
    Deletes the database *record* only — it does not remove the file
    from `uploads/`. Kept that way for now: this endpoint exists to
    exercise/expose the CRUD "delete" operation on document metadata;
    coupling it to filesystem cleanup is a separate concern with its own
    failure modes (e.g. what happens if the file is gone but the delete
    was meant to be metadata-only) that isn't needed yet.
    """
    document = crud.get_document_by_filename(db, filename)
    if document is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"No document record found for '{filename}'.")
    crud.delete_document(db, document)
