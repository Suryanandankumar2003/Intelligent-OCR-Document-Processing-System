"""Document upload endpoint. No OCR/classification/extraction happens
here — this stage accepts, validates, and stores the raw file, and
records a Document row for it in the database."""
from fastapi import APIRouter, Depends, File, UploadFile, status
from sqlalchemy.orm import Session

from database import crud
from database.session import get_db
from schemas.document import UploadResponse
from services.upload_service import save_uploaded_file

router = APIRouter(tags=["Documents"])


@router.post(
    "/upload",
    response_model=UploadResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Upload a PDF or image document",
)
async def upload_document(file: UploadFile = File(...), db: Session = Depends(get_db)) -> UploadResponse:
    """
    Accepts a single PDF/PNG/JPG/JPEG file, stores it under a generated
    unique name, records a Document row for it (`document_type` defaults
    to Unknown, `extracted_data` to null — neither classification nor
    extraction has run yet), and returns the file's metadata.

    File validation and error handling live in `services.upload_service`
    and `core.exceptions`, unchanged by this route now also touching the
    database — any failure (file or database) is turned into the
    appropriate HTTP response by the global handlers registered in
    `app.py`.
    """
    metadata = await save_uploaded_file(file)
    crud.create_document(db, filename=metadata["filename"], uploaded_at=metadata["uploaded_at"])
    return UploadResponse(**metadata)
