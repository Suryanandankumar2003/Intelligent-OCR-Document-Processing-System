"""
The full single-document pipeline — OCR, classification, extraction — as
one callable, so the batch worker and the interactive API run the same
code rather than two implementations that drift.

--- What this is, and what it replaces --------------------------------

Until now the pipeline existed only as a *sequence of HTTP calls* made
by the frontend: `useDocumentPipeline` calls `/upload`, then `/ocr`,
then `/classify`, then `/extract`. That is a perfectly good design for
an interactive screen — each step's result appears the moment it lands,
and a failure names the step that failed — but it is not something a
Celery task can reuse, because the composition lives in JavaScript.

So the composition moves here. The three services are unchanged and
still know nothing about each other; this module is the one place that
knows the order.

--- One OCR call, not three -------------------------------------------

The existing routes each run OCR themselves: `/classify` OCRs and then
classifies, `/extract` OCRs and then (maybe) classifies and then
extracts. Driven from the frontend, processing one document therefore
costs **three** OCR calls against Vertex AI — the expensive stage, run
twice for nothing.

That was an acceptable inefficiency for one document at a time. At 500
documents it is 1000 wasted multimodal calls, and it is the single
largest cost and latency item in the whole batch feature. This function
runs OCR once and threads the transcript through the other two stages,
so a batched document costs one third of what an interactive one does.

The interactive routes are deliberately left alone — changing them would
alter the behaviour of a working screen for no benefit to it.

--- Unknown is an outcome, not a failure ------------------------------

The classifier may legitimately answer `Unknown`, and extraction has no
field schema for it. `useDocumentPipeline` already treats that as a
terminal, non-error state the user can act on. This module takes the
same position: a document that OCRs and classifies cleanly but has no
extractable type returns `success=True` with `extracted_data=None` and
`document_type=Unknown`. It is not a failed file — nothing went wrong,
the transcript and the verdict are both saved, and a human can assign a
type from the review screen afterwards. Marking it `FAILED` would put it
in the retry queue, where retrying would produce `Unknown` again,
forever.
"""
import logging
import time
from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from core.document_types import DocumentType
from core.processing_event import ProcessingStage
from database import crud
from database.models import Document
from services.classification_service import classify_extracted_text
from services.extraction_service import extract_fields
from services.ocr_service import extract_text_from_stored_file

logger = logging.getLogger(__name__)


@dataclass
class PipelineResult:
    """
    What one document's run produced.

    A dataclass rather than a dict because two callers read it — the
    Celery task and the inline executor — and a typo in a dict key would
    surface as a silently missing value in a database column rather than
    an `AttributeError`.
    """

    filename: str
    document_type: DocumentType
    ocr_text: str
    extracted_data: Optional[dict]
    document_id: Optional[int]
    processing_time_seconds: float

    @property
    def is_extracted(self) -> bool:
        return self.extracted_data is not None


async def process_document(
    db: Session,
    *,
    filename: str,
    track_stage=None,
) -> PipelineResult:
    """
    Run the whole pipeline for one already-stored file and persist
    everything it produces.

    `filename` is the generated unique name on disk, the same value the
    upload service returns and `documents.filename` holds — never a
    client-supplied name.

    `track_stage` is an optional `(stage) -> context manager` used to time
    and record each stage as a `ProcessingEvent`, so batch runs feed the
    existing analytics dashboard exactly as interactive runs do. It is a
    parameter rather than an import because
    `api/processing_metrics.track_processing_stage` needs a `Session` and
    a filename bound to it, and because passing `None` gives tests a
    pipeline with no telemetry side effects.

    Raises whatever the underlying services raise — every exception in
    `core/exceptions.py` is already a sentence written to be shown to a
    person, which is exactly what the caller stores in
    `batch_files.error_message`. Catching here would throw that away.
    """
    started = time.perf_counter()

    def staged(stage: ProcessingStage):
        """The caller's tracker, or a no-op context manager when there isn't one."""
        if track_stage is None:
            from contextlib import nullcontext

            return nullcontext()
        return track_stage(stage)

    # --- 1. OCR, once ---------------------------------------------------
    with staged(ProcessingStage.OCR):
        ocr_result = await extract_text_from_stored_file(filename)
    ocr_text = ocr_result["extracted_text"]
    crud.save_ocr_text(db, filename=filename, ocr_text=ocr_text)

    # --- 2. Classification ----------------------------------------------
    with staged(ProcessingStage.CLASSIFICATION):
        classification = await classify_extracted_text(ocr_text)
    document_type = classification["document_type"]
    crud.save_classification_result(db, filename=filename, document_type=document_type)

    # --- 3. Extraction, when the type has a field schema ----------------
    #
    # Checked before the call rather than after catching its 422: the
    # answer is already known here, and a request whose only possible
    # outcome is a rejection is one that shouldn't be sent. Same reasoning
    # `useDocumentPipeline` applies on the frontend.
    if document_type == DocumentType.UNKNOWN:
        logger.info("Document '%s' classified as Unknown; skipping extraction", filename)
        document = crud.get_document_by_filename(db, filename)
        return PipelineResult(
            filename=filename,
            document_type=document_type,
            ocr_text=ocr_text,
            extracted_data=None,
            document_id=document.id if document else None,
            processing_time_seconds=round(time.perf_counter() - started, 3),
        )

    with staged(ProcessingStage.EXTRACTION):
        fields = await extract_fields(document_type, ocr_text)

    extracted_data = fields.model_dump(mode="json", by_alias=True)
    document: Optional[Document] = crud.save_extraction_result(
        db,
        filename=filename,
        document_type=document_type,
        extracted_data=extracted_data,
    )

    elapsed = round(time.perf_counter() - started, 3)
    logger.info(
        "Pipeline completed for '%s': type=%s, %d field(s), %.3fs",
        filename,
        document_type.value,
        len(extracted_data),
        elapsed,
    )

    return PipelineResult(
        filename=filename,
        document_type=document_type,
        ocr_text=ocr_text,
        extracted_data=extracted_data,
        document_id=document.id if document else None,
        processing_time_seconds=elapsed,
    )
