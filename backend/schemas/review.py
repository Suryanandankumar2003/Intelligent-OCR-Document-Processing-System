"""
Pydantic schemas for the document-review API contract (see
`api/routes/review.py`).

Deliberately generic over field names: `corrected_fields`,
`original_data`, and `reviewed_data` are all `dict[str, Any]` rather
than the four document-type-specific models in `schemas/extraction.py`.
That isn't a loss of validation — the route hands the merged result to
those exact models before anything is stored (see
`services/review_service.py`) — it's what keeps one review endpoint
working for all four document types, and for a fifth added later,
without a `Union` of four request bodies that a client would have to
pick between.
"""
from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from core.document_types import DocumentType
from core.review_status import ReviewStatus
from schemas.timestamps import as_utc


class DocumentReviewUpdate(BaseModel):
    """
    Request body for `PATCH /documents/{filename}/review`.

    A partial update, as PATCH implies: `corrected_fields` carries only
    the fields the reviewer actually changed, not the whole field set.
    That's not just payload size — it's what makes the audit trail
    meaningful. If clients sent every field on every save, the server
    could not tell a field that was deliberately edited from one that
    was merely re-submitted unchanged, and a second save would re-log
    corrections the reviewer never made.
    """

    corrected_fields: dict[str, Any] = Field(
        ...,
        description="Field name -> corrected value, for each field the reviewer changed.",
        examples=[{"pan_number": "ABCDE1234F", "name": "Priya Sharma"}],
    )

    @field_validator("corrected_fields")
    @classmethod
    def _reject_empty(cls, value: dict[str, Any]) -> dict[str, Any]:
        """An empty correction set is a client bug, not a no-op review.

        Marking a document reviewed with nothing to change is a real
        workflow action, but it's a different one — it shouldn't be
        expressible as an accidental empty PATCH body.
        """
        if not value:
            raise ValueError("corrected_fields must contain at least one field.")
        return value


class ReviewDecision(str, Enum):
    """
    The verdict a reviewer can record on a document, as the client sends it.

    Intentionally its own two-value enum rather than reusing
    `ReviewStatus` directly in the request body. `ReviewStatus` includes
    `PENDING_REVIEW`, which is the state a document starts in, not a
    decision anyone can make — accepting it here would mean an endpoint
    called "decision" that can un-review a document as a side effect of
    a client typo. The mapping to the stored status lives in the route.
    """

    APPROVE = "approve"
    REJECT = "reject"


class DocumentReviewDecision(BaseModel):
    """
    Request body for `POST /documents/{filename}/review/decision`.

    The other half of the workflow `DocumentReviewUpdate` above
    deliberately refuses: that schema rejects an empty `corrected_fields`
    because "marking a document reviewed with nothing to change is a real
    workflow action, but it's a different one". This is that other
    action, given its own endpoint and its own body rather than being
    smuggled in as an empty PATCH — so the two are distinguishable in
    logs, in the OpenAPI schema, and to any client reading either one.
    """

    decision: ReviewDecision = Field(
        ...,
        description="approve: the field set is signed off as correct. reject: the extraction is unusable.",
        examples=["approve"],
    )


class FieldCorrectionRecord(BaseModel):
    """One audit-trail entry — a `database.models.FieldCorrection` row as returned to the client."""

    id: int = Field(..., description="Internal database primary key for this audit row")
    field_name: str = Field(..., description="Schema field name that was corrected, e.g. 'pan_number'")
    original_value: Optional[Any] = Field(
        default=None, description="What AI extraction originally produced for this field"
    )
    corrected_value: Optional[Any] = Field(default=None, description="What the reviewer changed it to")
    corrected_at: datetime = Field(..., description="When this correction was saved (UTC)")

    model_config = ConfigDict(from_attributes=True)

    @field_validator("corrected_at")
    @classmethod
    def _stamp_utc(cls, value: datetime) -> datetime:
        return as_utc(value)


class DocumentReviewResponse(BaseModel):
    """
    Everything the review screen needs for one document: the original
    extraction, the current corrected values, where it sits in the
    workflow, and the full history of how it got there.

    Returned by both review endpoints (GET and PATCH) so the client
    renders from one shape either way and never has to merge a partial
    PATCH response into the state it already had.
    """

    filename: str = Field(..., description="Unique stored filename this review belongs to")
    document_type: DocumentType = Field(..., description="Document type whose field schema these values follow")
    original_data: dict[str, Any] = Field(
        ..., description="Field values exactly as AI extraction produced them; never modified by a review"
    )
    reviewed_data: dict[str, Any] = Field(
        ..., description="Current values: original_data with every saved correction applied"
    )
    ocr_text: Optional[str] = Field(
        default=None,
        description="Stored OCR transcript for this document; null if OCR predates transcript storage",
    )
    review_status: ReviewStatus = Field(..., description="Pending Review until a reviewer has saved at least once")
    reviewed_at: Optional[datetime] = Field(
        default=None, description="When the document was last reviewed (UTC)"
    )
    corrections: list[FieldCorrectionRecord] = Field(
        default_factory=list, description="Full correction audit trail, oldest first"
    )

    @field_validator("reviewed_at")
    @classmethod
    def _stamp_utc(cls, value: Optional[datetime]) -> Optional[datetime]:
        return as_utc(value)
