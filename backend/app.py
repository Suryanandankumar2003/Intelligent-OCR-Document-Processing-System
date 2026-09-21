"""
FastAPI application entrypoint.

Responsible only for wiring things together: creating the app instance,
attaching middleware, mounting routers, and running startup tasks.
Business logic lives in `services/`, persistence in `database/`, and
HTTP contracts in `api/` — this file stays thin on purpose.
"""
import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from api.router import api_router
from core.config import get_settings
from core.exceptions import (
    BatchError,
    BatchFileNotFoundError,
    BatchNotFoundError,
    BatchTooLargeError,
    ClassificationAuthenticationError,
    ClassificationError,
    ClassificationParsingError,
    ClassificationProcessingError,
    ClassificationRateLimitError,
    ClassificationTimeoutError,
    DocumentNotYetExtractedError,
    DocumentPersistenceError,
    DocumentUploadError,
    EmptyBatchError,
    EmptyExtractedTextError,
    EmptyFileError,
    ExtractionAuthenticationError,
    ExtractionError,
    ExtractionParsingError,
    ExtractionProcessingError,
    ExtractionRateLimitError,
    ExtractionTimeoutError,
    ExtractionUnsupportedDocumentTypeError,
    FileSaveError,
    FileTooLargeError,
    NothingToRetryError,
    OCRAuthenticationError,
    OCRDocumentNotFoundError,
    OCRError,
    OCRProcessingError,
    OCRRateLimitError,
    OCRTimeoutError,
    ReviewError,
    ReviewValidationError,
    UnsupportedFileTypeError,
    UnsupportedOCRFileTypeError,
    VertexAIConfigurationError,
)
from database.init_db import init_db

settings = get_settings()

logging.basicConfig(level=logging.DEBUG if settings.DEBUG else logging.INFO)
logger = logging.getLogger(__name__)


def register_exception_handlers(app: FastAPI) -> None:
    """
    Map each custom exception type to an HTTP response in one place.

    Handlers are checked most-specific-first, so a subclass registered
    here (e.g. `FileTooLargeError`) takes priority over the catch-all
    `DocumentUploadError` handler below it — every route that raises
    these gets a consistent `{"detail": "..."}` shape without needing
    its own try/except block.
    """

    @app.exception_handler(UnsupportedFileTypeError)
    async def handle_unsupported_type(request: Request, exc: UnsupportedFileTypeError) -> JSONResponse:
        return JSONResponse(status_code=415, content={"detail": str(exc)})

    @app.exception_handler(FileTooLargeError)
    async def handle_too_large(request: Request, exc: FileTooLargeError) -> JSONResponse:
        return JSONResponse(status_code=413, content={"detail": str(exc)})

    @app.exception_handler(EmptyFileError)
    async def handle_empty_file(request: Request, exc: EmptyFileError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(FileSaveError)
    async def handle_save_error(request: Request, exc: FileSaveError) -> JSONResponse:
        logger.exception("Unexpected error while saving upload: %s", exc)
        return JSONResponse(status_code=500, content={"detail": "Could not save the uploaded file."})

    @app.exception_handler(DocumentUploadError)
    async def handle_generic_upload_error(request: Request, exc: DocumentUploadError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    # --- Vertex AI configuration ---
    #
    # Shared by OCR, classification, and extraction (see
    # core/vertex_client.py) — one handler instead of three, since
    # "Vertex AI isn't configured" is one fact regardless of which
    # feature's call surfaced it.

    @app.exception_handler(VertexAIConfigurationError)
    async def handle_vertex_config_error(request: Request, exc: VertexAIConfigurationError) -> JSONResponse:
        logger.error("Vertex AI misconfigured: %s", exc)
        return JSONResponse(status_code=500, content={"detail": str(exc)})

    # --- OCR ---
    #
    # These map mostly to 5xx: an OCR failure means our request to a
    # downstream dependency (Vertex AI) failed, not that the caller sent
    # a bad request (the two 4xx exceptions below are the exceptions to
    # that: an unknown filename or an unsupported stored file type are
    # genuinely the caller's mistake).

    @app.exception_handler(OCRDocumentNotFoundError)
    async def handle_ocr_not_found(request: Request, exc: OCRDocumentNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @app.exception_handler(UnsupportedOCRFileTypeError)
    async def handle_ocr_unsupported_type(request: Request, exc: UnsupportedOCRFileTypeError) -> JSONResponse:
        return JSONResponse(status_code=415, content={"detail": str(exc)})

    @app.exception_handler(OCRAuthenticationError)
    async def handle_ocr_auth_error(request: Request, exc: OCRAuthenticationError) -> JSONResponse:
        logger.error("Vertex AI OCR authentication failed: %s", exc)
        return JSONResponse(status_code=502, content={"detail": str(exc)})

    @app.exception_handler(OCRRateLimitError)
    async def handle_ocr_rate_limit(request: Request, exc: OCRRateLimitError) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    @app.exception_handler(OCRTimeoutError)
    async def handle_ocr_timeout(request: Request, exc: OCRTimeoutError) -> JSONResponse:
        return JSONResponse(status_code=504, content={"detail": str(exc)})

    @app.exception_handler(OCRProcessingError)
    async def handle_ocr_processing_error(request: Request, exc: OCRProcessingError) -> JSONResponse:
        logger.exception("OCR processing failed: %s", exc)
        return JSONResponse(status_code=502, content={"detail": str(exc)})

    @app.exception_handler(OCRError)
    async def handle_generic_ocr_error(request: Request, exc: OCRError) -> JSONResponse:
        logger.exception("Unhandled OCR error: %s", exc)
        return JSONResponse(status_code=502, content={"detail": str(exc)})

    # --- Classification ---
    #
    # Same pattern as OCR above: these map mostly to 5xx because a
    # classification failure means our request to Vertex AI failed, not
    # that the caller sent a bad request. `EmptyExtractedTextError` is
    # the exception — classifying a document with no OCR text is the
    # caller's mistake.

    @app.exception_handler(EmptyExtractedTextError)
    async def handle_empty_extracted_text(request: Request, exc: EmptyExtractedTextError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(ClassificationAuthenticationError)
    async def handle_classification_auth_error(
        request: Request, exc: ClassificationAuthenticationError
    ) -> JSONResponse:
        logger.error("Vertex AI classification authentication failed: %s", exc)
        return JSONResponse(status_code=502, content={"detail": str(exc)})

    @app.exception_handler(ClassificationRateLimitError)
    async def handle_classification_rate_limit(
        request: Request, exc: ClassificationRateLimitError
    ) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    @app.exception_handler(ClassificationTimeoutError)
    async def handle_classification_timeout(request: Request, exc: ClassificationTimeoutError) -> JSONResponse:
        return JSONResponse(status_code=504, content={"detail": str(exc)})

    @app.exception_handler(ClassificationParsingError)
    async def handle_classification_parsing_error(
        request: Request, exc: ClassificationParsingError
    ) -> JSONResponse:
        logger.exception("Classification response parsing failed: %s", exc)
        return JSONResponse(status_code=502, content={"detail": str(exc)})

    @app.exception_handler(ClassificationProcessingError)
    async def handle_classification_processing_error(
        request: Request, exc: ClassificationProcessingError
    ) -> JSONResponse:
        logger.exception("Classification processing failed: %s", exc)
        return JSONResponse(status_code=502, content={"detail": str(exc)})

    @app.exception_handler(ClassificationError)
    async def handle_generic_classification_error(request: Request, exc: ClassificationError) -> JSONResponse:
        logger.exception("Unhandled classification error: %s", exc)
        return JSONResponse(status_code=502, content={"detail": str(exc)})

    # --- Field extraction ---
    #
    # Same pattern as classification above. `ExtractionUnsupportedDocumentTypeError`
    # is the one 4xx exception here (422): the request was well-formed,
    # but there is no field schema for the resolved/requested document
    # type (e.g. Unknown) — nothing about retrying or fixing the server
    # config would change that.
    # `EmptyExtractedTextError` is already registered above and is reused
    # as-is (extraction raises the very same exception type).

    @app.exception_handler(ExtractionUnsupportedDocumentTypeError)
    async def handle_extraction_unsupported_type(
        request: Request, exc: ExtractionUnsupportedDocumentTypeError
    ) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": str(exc)})

    @app.exception_handler(ExtractionAuthenticationError)
    async def handle_extraction_auth_error(request: Request, exc: ExtractionAuthenticationError) -> JSONResponse:
        logger.error("Vertex AI extraction authentication failed: %s", exc)
        return JSONResponse(status_code=502, content={"detail": str(exc)})

    @app.exception_handler(ExtractionRateLimitError)
    async def handle_extraction_rate_limit(request: Request, exc: ExtractionRateLimitError) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    @app.exception_handler(ExtractionTimeoutError)
    async def handle_extraction_timeout(request: Request, exc: ExtractionTimeoutError) -> JSONResponse:
        return JSONResponse(status_code=504, content={"detail": str(exc)})

    @app.exception_handler(ExtractionParsingError)
    async def handle_extraction_parsing_error(request: Request, exc: ExtractionParsingError) -> JSONResponse:
        logger.exception("Extraction response parsing failed: %s", exc)
        return JSONResponse(status_code=502, content={"detail": str(exc)})

    @app.exception_handler(ExtractionProcessingError)
    async def handle_extraction_processing_error(request: Request, exc: ExtractionProcessingError) -> JSONResponse:
        logger.exception("Extraction processing failed: %s", exc)
        return JSONResponse(status_code=502, content={"detail": str(exc)})

    @app.exception_handler(ExtractionError)
    async def handle_generic_extraction_error(request: Request, exc: ExtractionError) -> JSONResponse:
        logger.exception("Unhandled extraction error: %s", exc)
        return JSONResponse(status_code=502, content={"detail": str(exc)})

    # --- Review / corrections ---
    #
    # Both 4xx, unlike the families above: saving a correction never
    # calls Vertex AI, so there is no downstream dependency here that
    # could fail on our behalf. 409 for "the document exists but hasn't
    # been extracted yet" (the request is premature, and extracting
    # makes the same call work), 422 for values that don't satisfy the
    # document type's field schema.

    @app.exception_handler(DocumentNotYetExtractedError)
    async def handle_not_yet_extracted(request: Request, exc: DocumentNotYetExtractedError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(ReviewValidationError)
    async def handle_review_validation_error(request: Request, exc: ReviewValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": str(exc)})

    @app.exception_handler(ReviewError)
    async def handle_generic_review_error(request: Request, exc: ReviewError) -> JSONResponse:
        logger.exception("Unhandled review error: %s", exc)
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    # --- Batch processing ---
    #
    # Every member is 4xx. A *file* failing inside a batch never reaches
    # here at all — it is recorded on its `batch_files` row and the batch
    # continues — so everything in this family describes a request that
    # is wrong, not a document that went wrong.

    @app.exception_handler(BatchNotFoundError)
    async def handle_batch_not_found(request: Request, exc: BatchNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @app.exception_handler(BatchFileNotFoundError)
    async def handle_batch_file_not_found(request: Request, exc: BatchFileNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @app.exception_handler(BatchTooLargeError)
    async def handle_batch_too_large(request: Request, exc: BatchTooLargeError) -> JSONResponse:
        # 413, matching the single-file `FileTooLargeError` above: too
        # many files and too many bytes are the same class of problem
        # from the caller's side.
        return JSONResponse(status_code=413, content={"detail": str(exc)})

    @app.exception_handler(EmptyBatchError)
    async def handle_empty_batch(request: Request, exc: EmptyBatchError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(NothingToRetryError)
    async def handle_nothing_to_retry(request: Request, exc: NothingToRetryError) -> JSONResponse:
        # 409, not 400: the request is well-formed and the batch exists —
        # it is the batch's current state that makes the operation
        # inapplicable. Same reasoning as `DocumentNotYetExtractedError`.
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(BatchError)
    async def handle_generic_batch_error(request: Request, exc: BatchError) -> JSONResponse:
        logger.exception("Unhandled batch error: %s", exc)
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    # --- Database ---
    #
    # A write failure here is unambiguously our side (disk full, the
    # SQLite file locked, a constraint violation) rather than the
    # caller's request being wrong, so this is always 500.

    @app.exception_handler(DocumentPersistenceError)
    async def handle_document_persistence_error(request: Request, exc: DocumentPersistenceError) -> JSONResponse:
        logger.exception("Document persistence failed: %s", exc)
        return JSONResponse(status_code=500, content={"detail": str(exc)})


def _log_startup() -> None:
    """
    Write one `System Event` row recording that the API came up.

    The reason this is worth a row: a gap in the log is ambiguous.
    Nothing happening because nobody used the system looks exactly like
    nothing happening because the system was down, and a startup marker
    is what separates the two — it turns "no events between 18:00 and
    09:00" into "no events overnight, and the API was running the whole
    time" or "the API was restarted at 08:59, which is why the batch
    that was running at 18:00 has files stuck in Processing".

    Its own session, opened and closed here, because this runs at
    startup where there is no request and therefore no `get_db`
    dependency to yield one. Wrapped in a blanket `except` on top of the
    best-effort write underneath it: a logging failure must not stop the
    application from starting, which is the one thing that would make
    this observability feature strictly worse than not having it.
    """
    from core.log_events import LogEventType
    from database.session import SessionLocal
    from services.event_log import log_event

    db = SessionLocal()
    try:
        log_event(
            db,
            event_type=LogEventType.SYSTEM_EVENT,
            message=f"{settings.APP_NAME} {settings.APP_VERSION} started.",
            details={
                "environment": settings.ENVIRONMENT,
                "debug": settings.DEBUG,
                "upload_dir": str(settings.UPLOAD_DIR),
                "batch_inline_fallback": settings.BATCH_INLINE_FALLBACK,
            },
        )
    except Exception:  # noqa: BLE001 - a log row is never a reason to fail startup
        logger.exception("Could not record the startup event")
    finally:
        db.close()


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.APP_NAME,
        version=settings.APP_VERSION,
        debug=settings.DEBUG,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        # A cross-origin response only exposes a handful of "safelisted"
        # headers to JavaScript; everything else is readable by the
        # browser but invisible to `fetch`/Axios unless the server names
        # it here. Content-Disposition is not safelisted, so without this
        # the xlsx download would arrive with its server-chosen filename
        # (`documents_export_<timestamp>.xlsx`) stripped from the
        # frontend's view, and the browser would save it under a generic
        # name. Note `allow_headers=["*"]` above does not cover this —
        # that governs *request* headers the client may send.
        expose_headers=["Content-Disposition"],
    )

    register_exception_handlers(app)

    app.include_router(api_router, prefix=settings.API_V1_PREFIX)

    @app.on_event("startup")
    def on_startup() -> None:
        settings.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        init_db()
        _log_startup()

    @app.on_event("shutdown")
    def on_shutdown() -> None:
        """
        Stop the inline batch executor, if one was ever started.

        Does not wait for queued files: a batch can have hours of work
        outstanding, and a Ctrl-C that blocks on it is not a shutdown.
        Files left mid-flight stay `Processing` and are recovered by a
        batch retry, which is exactly the case
        `batch_dispatch.retry_batch` handles.
        """
        from services.batch_dispatch import shutdown_inline_pool

        shutdown_inline_pool(wait=False)

    return app


app = create_app()
