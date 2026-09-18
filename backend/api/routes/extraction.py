"""Field extraction endpoint. Runs OCR (Vertex AI/Gemini) against a file
already stored by the upload endpoint, classifies its document type
(unless the caller already knows it), extracts the field set defined
for that type, and persists the result to the database."""
from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from api.processing_metrics import track_processing_stage
from core.document_types import DocumentType
from core.processing_event import ProcessingStage
from database import crud
from database.session import get_db
from schemas.extraction import ExtractedFields
from services.classification_service import classify_extracted_text
from services.extraction_service import extract_fields
from services.ocr_service import extract_text_from_stored_file

router = APIRouter(tags=["Extraction"])


@router.post(
    "/documents/{filename}/extract",
    response_model=ExtractedFields,
    status_code=status.HTTP_200_OK,
    summary="Extract structured fields from a previously uploaded document",
)
async def extract_document_fields(
    filename: str,
    document_type: Optional[DocumentType] = Query(
        default=None,
        description=(
            "Already know the document type (e.g. from a prior call to "
            "/classify)? Pass it here to skip re-classifying. Omitted: "
            "the document is classified automatically before extraction."
        ),
    ),
    db: Session = Depends(get_db),
) -> ExtractedFields:
    """
    `filename` is the stored name returned by `POST /upload`, same
    convention as the OCR and classification endpoints.

    Extraction needs to know the document type up front (each type has a
    different field set/schema) — see `services/extraction_service.py`.
    If the caller doesn't supply `document_type`, this classifies the
    document first via `services.classification_service`, reusing the
    same OCR text for both the classification and extraction calls
    rather than running OCR twice.

    `services.extraction_service.extract_fields` itself rejects a
    document type with no defined field schema (`DocumentType.UNKNOWN`
    included) via `ExtractionUnsupportedDocumentTypeError` — that check
    isn't duplicated here, so "which types are extractable" stays
    defined in exactly one place.

    On success, the result is saved via
    `database.crud.save_extraction_result` before being returned — this
    is the "save extracted document data" step. Persistence happens
    here, in the route, rather than inside `extraction_service`, so that
    service stays database-agnostic and independently unit-testable
    (same reasoning `ocr_service`/`classification_service` already
    follow: business logic doesn't know about SQLAlchemy sessions).

    Each stage this route actually runs — OCR always, classification
    only when `document_type` wasn't supplied, extraction always — is
    timed and recorded via `track_processing_stage` for the analytics
    dashboard (`api/processing_metrics.py`). Classification is wrapped
    only inside the `if`, not unconditionally, so the recorded attempt
    count reflects what this route actually did, not what it might have
    done.
    """
    with track_processing_stage(db, filename=filename, stage=ProcessingStage.OCR):
        ocr_result = await extract_text_from_stored_file(filename)

    resolved_type = document_type
    if resolved_type is None:
        with track_processing_stage(db, filename=filename, stage=ProcessingStage.CLASSIFICATION):
            classification = await classify_extracted_text(ocr_result["extracted_text"])
        resolved_type = classification["document_type"]

    with track_processing_stage(db, filename=filename, stage=ProcessingStage.EXTRACTION):
        fields = await extract_fields(resolved_type, ocr_result["extracted_text"])

    crud.save_extraction_result(
        db,
        filename=filename,
        document_type=resolved_type,
        extracted_data=fields.model_dump(mode="json"),
    )

    return fields
