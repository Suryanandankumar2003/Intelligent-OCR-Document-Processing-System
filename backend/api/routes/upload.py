"""Document upload endpoint. No OCR/classification/extraction happens
here — this stage accepts, validates, and stores the raw file, and
records a Document row for it in the database."""
import time

from fastapi import APIRouter, Depends, File, UploadFile, status
from sqlalchemy.orm import Session

from core.log_events import LogEventType, LogStatus
from database import crud
from database.session import get_db
from schemas.document import UploadResponse
from services.batch_service import sanitize_display_name
from services.event_log import describe_exception, log_event
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

    --- The log rows ---------------------------------------------------

    Three events are possible here and all three are recorded: the
    upload started, it completed, or it was rejected. The rejection is
    the one worth having. Every other stage of the pipeline is reachable
    from a `Document` row, so a failure there is findable later by
    looking the document up; a rejected upload creates no row and leaves
    no file, so without this entry the only evidence that someone tried
    to upload a 40 MB TIFF at 4pm is a 415 in a web server access log
    nobody keeps.

    Written with `log_event` directly rather than through
    `services.event_log.track_event`, because that wrapper files a
    failure as `ERROR` and this one has a more specific event type for
    it. The name the log records is the *client's* filename, run through
    `sanitize_display_name` — the same treatment batch uploads give it
    (see `services/batch_service.py` for why a client-supplied name is
    never trusted raw), and the only name that exists at all when the
    rejection happens before a stored name is generated.
    """
    original_name = sanitize_display_name(file.filename or "")
    log_event(
        db,
        event_type=LogEventType.UPLOAD_STARTED,
        status=LogStatus.STARTED,
        message=f"Upload started for '{original_name}'.",
        details={"original_filename": original_name, "content_type": file.content_type},
    )

    clock_start = time.perf_counter()
    try:
        metadata = await save_uploaded_file(file)
    except Exception as exc:
        log_event(
            db,
            event_type=LogEventType.UPLOAD_REJECTED,
            status=LogStatus.FAILURE,
            message=f"Upload rejected for '{original_name}': {describe_exception(exc)}",
            details={
                "original_filename": original_name,
                "content_type": file.content_type,
                "error_type": type(exc).__name__,
            },
            processing_time=round(time.perf_counter() - clock_start, 3),
        )
        raise

    document = crud.create_document(db, filename=metadata["filename"], uploaded_at=metadata["uploaded_at"])

    log_event(
        db,
        event_type=LogEventType.UPLOAD_COMPLETED,
        status=LogStatus.SUCCESS,
        message=f"Uploaded '{original_name}' as '{metadata['filename']}'.",
        filename=metadata["filename"],
        document_id=document.id,
        document_type=document.document_type,
        details={
            "original_filename": original_name,
            "content_type": metadata.get("content_type"),
            "size_bytes": metadata.get("size_bytes"),
        },
        processing_time=round(time.perf_counter() - clock_start, 3),
    )

    return UploadResponse(**metadata)
