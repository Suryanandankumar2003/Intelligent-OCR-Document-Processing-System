"""Pydantic schemas for the document-upload and document-record API contracts."""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from core.document_types import DocumentType


class UploadResponse(BaseModel):
    """Metadata returned to the client after a file is stored successfully."""

    filename: str = Field(..., description="Unique name the file was stored under on disk")
    original_filename: str = Field(..., description="Original filename supplied by the client")
    content_type: str = Field(..., description="MIME type reported for the uploaded file")
    size_bytes: int = Field(..., description="File size in bytes")
    uploaded_at: datetime = Field(..., description="UTC timestamp when the file was stored")


class DocumentRecordResponse(BaseModel):
    """
    A persisted `database.models.Document` row, as returned by the
    document-records endpoints (`api/routes/documents.py`).

    `model_config = ConfigDict(from_attributes=True)` is what lets this
    schema be built directly from a SQLAlchemy ORM instance — e.g.
    `return document` in a route with this as its `response_model` —
    instead of requiring the route to manually unpack the ORM object
    into a dict first. Without it, Pydantic only accepts dict-like
    input, not arbitrary objects with matching attributes.
    """

    id: int = Field(..., description="Internal database primary key")
    filename: str = Field(..., description="Unique name the file was stored under on disk")
    document_type: DocumentType = Field(..., description="Classified document type; Unknown until classified")
    extracted_data: Optional[dict] = Field(
        default=None, description="Extracted fields for this document type; null until extraction has run"
    )
    uploaded_at: datetime = Field(..., description="When the underlying file was uploaded")
    created_at: datetime = Field(..., description="When this database row was first written")
    updated_at: datetime = Field(..., description="When this database row was last modified")

    model_config = ConfigDict(from_attributes=True)
