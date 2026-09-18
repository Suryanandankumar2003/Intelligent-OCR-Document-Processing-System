"""
Single source of truth for how one attempt at one pipeline stage is
described — mirrors `core.document_types.DocumentType`'s pattern: shared
enums used by the model column (`database/models.py:ProcessingEvent`),
the API contract (`schemas/analytics.py`), and the instrumentation that
records events (`api/processing_metrics.py`), so all three stay in sync
by construction.

Three stages, because that's the shape of the actual pipeline
(`api/routes/ocr.py`, `classification.py`, `extraction.py` each call one
of `services.ocr_service` / `classification_service` / `extraction_service`):
Vertex AI is asked to read the page, then to name the document type, then
to pull out its fields. Each is a separate call to a downstream
dependency with its own failure modes, so each gets its own row —
tracking only one combined "did the whole request succeed" outcome would
hide *which* stage a failure came from, which is the entire point of
recording these.
"""
from enum import Enum


class ProcessingStage(str, Enum):
    OCR = "OCR"
    CLASSIFICATION = "Classification"
    EXTRACTION = "Extraction"


class ProcessingStatus(str, Enum):
    SUCCESS = "Success"
    FAILURE = "Failure"
