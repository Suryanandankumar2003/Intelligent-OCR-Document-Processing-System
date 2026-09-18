"""Pydantic schema for the document-classification API contract."""
from pydantic import BaseModel, Field

from core.document_types import DocumentType


class DocumentClassificationResponse(BaseModel):
    """Result of classifying a document's OCR text via Vertex AI.

    Deliberately just these two fields, per the API contract: callers get
    the predicted type and a confidence value, nothing else (no raw model
    output, no prompt echoed back).
    """

    document_type: DocumentType = Field(..., description="Predicted document type")
    confidence: str = Field(
        ..., description="Model's confidence in the prediction, as a decimal string (e.g. \"0.92\")"
    )
