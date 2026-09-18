"""
Human-review endpoints — the correction half of the extraction workflow.

`api/routes/extraction.py` produces the model's first answer; these two
endpoints let a person read it, fix what's wrong, and have both the fix
and what it replaced recorded:

  GET   /documents/{filename}/review  — current state + correction history
  PATCH /documents/{filename}/review  — save corrections

PATCH rather than PUT, and a partial `corrected_fields` body rather than
a whole document: a review is by nature "these three fields were wrong",
and modelling it that way is what lets the server record exactly what
the reviewer touched (see `schemas/review.py`).

Note the division of labour, which follows the same layering the rest of
the backend uses: this module does HTTP concerns only (look the document
up, 404/409 if it isn't reviewable, shape the response),
`services/review_service.py` decides what a correction *means*, and
`database/crud.py` writes it. None of the three knows how the other two
work.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from core.exceptions import DocumentNotYetExtractedError
from database import crud
from database.models import Document, FieldCorrection
from database.session import get_db
from schemas.review import DocumentReviewResponse, DocumentReviewUpdate, FieldCorrectionRecord
from services.review_service import apply_corrections

router = APIRouter(prefix="/documents", tags=["Review"])


def _get_reviewable_document(db: Session, filename: str) -> Document:
    """
    Load the document `filename` addresses, or fail with the right status.

    Two distinct failures, deliberately not collapsed into one: a
    filename with no record is a 404 (nothing here, and nothing the
    caller can do will change that), while a document that exists but
    has never been extracted is a 409 (the resource is real, the request
    is just premature — run extraction and this same call works).
    """
    document = crud.get_document_by_filename(db, filename)
    if document is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"No document record found for '{filename}'."
        )
    if document.extracted_data is None:
        raise DocumentNotYetExtractedError(filename)
    return document


def _build_review_response(
    document: Document, corrections: list[FieldCorrection]
) -> DocumentReviewResponse:
    """Assemble the shared response both endpoints return."""
    return DocumentReviewResponse(
        filename=document.filename,
        document_type=document.document_type,
        original_data=document.extracted_data or {},
        # Falls back to the original extraction for a document nobody has
        # reviewed yet, so the client always has a populated field set to
        # render and never needs a "which one do I show?" branch.
        reviewed_data=document.reviewed_data or document.extracted_data or {},
        review_status=document.review_status,
        reviewed_at=document.reviewed_at,
        corrections=[FieldCorrectionRecord.model_validate(correction) for correction in corrections],
    )


@router.get(
    "/{filename}/review",
    response_model=DocumentReviewResponse,
    summary="Get a document's review state and correction history",
)
def get_document_review(filename: str, db: Session = Depends(get_db)) -> DocumentReviewResponse:
    """
    Everything the review screen needs to render, in one call.

    Exists so the screen is reachable independently of the upload
    pipeline that produced the document — reload the page, or come back
    to a document processed last week, and the corrected values and the
    history behind them are still there.
    """
    document = _get_reviewable_document(db, filename)
    return _build_review_response(document, crud.list_field_corrections(db, document.id))


@router.patch(
    "/{filename}/review",
    response_model=DocumentReviewResponse,
    status_code=status.HTTP_200_OK,
    summary="Save reviewer corrections to a document's extracted fields",
)
def update_document_review(
    filename: str,
    payload: DocumentReviewUpdate,
    db: Session = Depends(get_db),
) -> DocumentReviewResponse:
    """
    Apply `corrected_fields` to the document and record what changed.

    Returns the full post-save state rather than a bare 204, because the
    values the server stores are not always the values the client sent —
    the document type's validators normalize them on the way in (a PAN
    number is upper-cased, a blank field becomes `null`). Handing back
    the stored result lets the screen show what was actually saved
    instead of assuming its own copy is authoritative.

    Idempotent in the way that matters: re-sending the same correction
    for an already-corrected field changes nothing and logs nothing,
    because the values no longer differ from the original extraction.
    """
    document = _get_reviewable_document(db, filename)

    reviewed_data, correction_records = apply_corrections(document, payload.corrected_fields)
    document = crud.save_review(
        db, document=document, reviewed_data=reviewed_data, corrections=correction_records
    )

    return _build_review_response(document, crud.list_field_corrections(db, document.id))
