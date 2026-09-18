"""OCR endpoint. Runs OCR (Vertex AI/Gemini) against a file already
stored by the upload endpoint — it does not accept a fresh file upload
itself."""
from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from api.processing_metrics import track_processing_stage
from core.processing_event import ProcessingStage
from database.session import get_db
from schemas.ocr import OCRResultResponse
from services.ocr_service import extract_text_from_stored_file

router = APIRouter(tags=["OCR"])


@router.post(
    "/documents/{filename}/ocr",
    response_model=OCRResultResponse,
    status_code=status.HTTP_200_OK,
    summary="Run OCR on a previously uploaded document",
)
async def run_ocr(filename: str, db: Session = Depends(get_db)) -> OCRResultResponse:
    """
    `filename` is the unique stored name returned by `POST /upload`
    (e.g. "4fb2bb8136b04af7ad4e2a8fbd7a3b5c.pdf"), not the client's
    original filename.

    All validation and error handling live in `services.ocr_service`
    and `core.exceptions` — this route stays a plain pass-through, same
    pattern as `api/routes/upload.py`, aside from `db` and
    `track_processing_stage`: this is one of three call sites that can
    trigger an OCR attempt (see `api/processing_metrics.py`'s
    docstring), and every one of them is timed and recorded the same
    way so the analytics dashboard's OCR success rate reflects all of
    them, not just requests made through this specific endpoint.
    """
    with track_processing_stage(db, filename=filename, stage=ProcessingStage.OCR):
        result = await extract_text_from_stored_file(filename)
    return OCRResultResponse(**result)
