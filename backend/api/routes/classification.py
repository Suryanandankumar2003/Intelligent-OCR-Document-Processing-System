"""Document classification endpoint. Runs OCR (Vertex AI/Gemini) against
a file already stored by the upload endpoint, then classifies the
extracted text into one of the supported document types."""
from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from api.processing_metrics import track_processing_stage
from core.processing_event import ProcessingStage
from database import crud
from database.session import get_db
from schemas.classification import DocumentClassificationResponse
from services.classification_service import classify_extracted_text
from services.ocr_service import extract_text_from_stored_file

router = APIRouter(tags=["Classification"])


@router.post(
    "/documents/{filename}/classify",
    response_model=DocumentClassificationResponse,
    status_code=status.HTTP_200_OK,
    summary="Classify a previously uploaded document's type",
)
async def classify_document(filename: str, db: Session = Depends(get_db)) -> DocumentClassificationResponse:
    """
    `filename` is the unique stored name returned by `POST /upload`
    (e.g. "4fb2bb8136b04af7ad4e2a8fbd7a3b5c.pdf"), not the client's
    original filename — same convention as `POST /documents/{filename}/ocr`.

    OCR (`services.ocr_service`) and classification
    (`services.classification_service`) are separate services, each with
    a single responsibility; this route just composes them: extract text,
    then classify it. All validation and error handling live in those
    services and in `core.exceptions` — any failure is turned into the
    appropriate HTTP response by the global handlers registered in
    `app.py`, so this route stays a plain pass-through, aside from `db`
    and `track_processing_stage`: each of the two calls below is timed
    and recorded as its own stage attempt (OCR, then Classification) for
    the analytics dashboard — see `api/processing_metrics.py`.
    """
    with track_processing_stage(db, filename=filename, stage=ProcessingStage.OCR):
        ocr_result = await extract_text_from_stored_file(filename)
    with track_processing_stage(db, filename=filename, stage=ProcessingStage.CLASSIFICATION):
        classification = await classify_extracted_text(ocr_result["extracted_text"])

    # Both results are persisted here, not just returned. A document that
    # classifies as `Unknown` stops at this endpoint — extraction has no
    # field schema for it — so this is the only place its transcript and
    # its verdict can be recorded. Both writes are best-effort and never
    # fail the request; the response carries the same data regardless.
    crud.save_ocr_text(db, filename=filename, ocr_text=ocr_result["extracted_text"])
    crud.save_classification_result(db, filename=filename, document_type=classification["document_type"])

    return DocumentClassificationResponse(**classification)
