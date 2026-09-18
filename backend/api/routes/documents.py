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
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from core.document_types import DocumentType
from database import crud
from database.session import get_db
from schemas.document import DocumentRecordResponse

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
