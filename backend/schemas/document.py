"""Pydantic schemas for the document-upload and document-record API contracts."""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from core.document_types import DocumentType
from core.review_status import ReviewStatus
from schemas.timestamps import as_utc


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
    # The review columns are part of this record, not just of the review
    # endpoints' own response: a documents list has to be able to show
    # which documents still need a reviewer and let a client filter on
    # that, which is impossible if "reviewed or not" is only readable one
    # document at a time via GET /documents/{filename}/review.
    # `reviewed_data` rides along so a client can show or search "current
    # best data" (`reviewed_data or extracted_data`) — the same
    # convention the review API and the xlsx export already use — instead
    # of showing values a reviewer has already corrected.
    reviewed_data: Optional[dict] = Field(
        default=None, description="Corrected field values; null until a reviewer has saved at least once"
    )
    review_status: ReviewStatus = Field(
        ..., description="Pending Review until a reviewer has saved at least once"
    )
    reviewed_at: Optional[datetime] = Field(
        default=None, description="When this document was last reviewed (UTC)"
    )
    uploaded_at: datetime = Field(..., description="When the underlying file was uploaded")
    created_at: datetime = Field(..., description="When this database row was first written")
    updated_at: datetime = Field(..., description="When this database row was last modified")

    model_config = ConfigDict(from_attributes=True)

    @field_validator("reviewed_at", "uploaded_at", "created_at", "updated_at")
    @classmethod
    def _stamp_utc(cls, value: Optional[datetime]) -> Optional[datetime]:
        # Without this, every timestamp in this response serializes with
        # no offset and a browser renders it shifted by the viewer's UTC
        # offset — see schemas/timestamps.py.
        return as_utc(value)
