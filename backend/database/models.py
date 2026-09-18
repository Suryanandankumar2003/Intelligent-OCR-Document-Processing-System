"""
SQLAlchemy ORM models.

Three tables:

* `documents` — the persistence layer's record of a document as it moves
  through the pipeline: uploaded -> (optionally) classified ->
  (optionally) field-extracted -> (optionally) human-reviewed. One row
  per stored file, keyed by its unique on-disk filename (the same value
  `services.upload_service` generates and every other endpoint already
  addresses a document by).
* `field_corrections` — an append-only audit trail of every field a
  human reviewer changed, one row per corrected field per save.
* `processing_events` — an append-only log of every OCR/classification/
  extraction *attempt*, success or failure, with how long it took. This
  is what the analytics dashboard's timing and success-rate metrics are
  computed from (`database/analytics.py`); nothing above this table
  persists a failure at all, so without it those metrics would be
  uncomputable, not just approximate.

Written in SQLAlchemy 2.0's typed `Mapped`/`mapped_column` style (the
same declarative-mapping style `database/base.py`'s `Base` is set up
for), so each column's Python type is declared once and checked by
static tools, instead of being implicit in the column's SQL type.
"""
from datetime import datetime
from typing import Any, List, Optional

from sqlalchemy import JSON, DateTime
from sqlalchemy import Enum as SQLAlchemyEnum
from sqlalchemy import ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from core.document_types import DocumentType
from core.processing_event import ProcessingStage, ProcessingStatus
from core.review_status import ReviewStatus
from database.base import Base


class Document(Base):
    """
    A processed document record.

    Rows are created by the upload endpoint the moment a file is saved
    to disk (`document_type=UNKNOWN`, `extracted_data=None`, since
    nothing has been classified or extracted yet), and later updated in
    place by the extraction endpoint once that actually runs — see
    `database.crud.save_extraction_result`. `filename` is unique, so a
    file always maps to exactly one row: extraction never creates a
    second row for a document that was already uploaded.

    The review columns (`reviewed_data`, `review_status`, `reviewed_at`)
    are written by `database.crud.save_review` when a human corrects the
    extracted fields. They sit alongside `extracted_data` rather than
    replacing it, so both the model's original answer and the corrected
    one stay readable from the same row.
    """

    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    # The unique stored filename from services.upload_service (e.g.
    # "4fb2bb8136b04af7ad4e2a8fbd7a3b5c.pdf"), never the client's
    # original filename. Unique + indexed: every endpoint (OCR,
    # classify, extract, this table) addresses a document by this value,
    # so lookups by it need to be fast and unambiguous.
    filename: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)

    # Stored as its .value ("PAN Card", not the Python member name
    # "PAN_CARD") via values_callable below, so what's in the database
    # matches what every API response already uses. native_enum=False
    # renders the column as VARCHAR + a CHECK constraint instead of a
    # real SQL ENUM type: SQLite has no native ENUM support anyway, and
    # this way adding a new DocumentType later is a Python code change,
    # not a database migration.
    document_type: Mapped[DocumentType] = mapped_column(
        SQLAlchemyEnum(
            DocumentType,
            name="document_type",
            native_enum=False,
            validate_strings=True,
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
        default=DocumentType.UNKNOWN,
        server_default=DocumentType.UNKNOWN.value,
    )

    # The structured fields extracted for this document (see
    # schemas/extraction.py: PANCardFields / AadhaarCardFields /
    # InvoiceFields / PrescriptionFields, as a plain dict). The shape
    # depends on document_type, so this is intentionally untyped JSON
    # rather than a fixed set of columns — adding a fifth document type
    # later needs a new Pydantic schema, not a new migration. None until
    # extraction has actually run for this document.
    #
    # Treated as immutable once written: the review workflow below never
    # overwrites it, so "what did the model originally say" stays
    # answerable forever — which is what makes the original-vs-modified
    # comparison (and any future accuracy measurement or fine-tuning
    # dataset built from these corrections) possible at all.
    extracted_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # The human-approved field set: `extracted_data` with every saved
    # correction applied, same shape and same validated field names.
    # None until a reviewer has saved at least once, which is why
    # consumers should read "current best data" as
    # `reviewed_data or extracted_data` rather than assuming this is
    # populated. Stored as a separate column rather than by mutating
    # `extracted_data` precisely so the pair can be diffed.
    reviewed_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # Where this document sits in the review workflow — see
    # core/review_status.py. Same enum-column setup as document_type
    # above (stored as its .value, VARCHAR + CHECK rather than a native
    # SQL ENUM), for the same reasons.
    review_status: Mapped[ReviewStatus] = mapped_column(
        SQLAlchemyEnum(
            ReviewStatus,
            name="review_status",
            native_enum=False,
            validate_strings=True,
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
        default=ReviewStatus.PENDING_REVIEW,
        server_default=ReviewStatus.PENDING_REVIEW.value,
    )

    # When a reviewer last saved this document. Business data about the
    # review workflow, deliberately distinct from the `updated_at` audit
    # column below (which also moves for non-review writes, e.g. a
    # re-run of extraction).
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    # When the underlying file was uploaded (set once, at upload time —
    # see api/routes/upload.py). Deliberately distinct from `created_at`
    # below: this is business data describing the document, not a
    # row-lifecycle audit column, even though in practice the two are
    # set within moments of each other today.
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    # Row-lifecycle audit columns — standard production practice so it's
    # always possible to answer "when was this record written/changed",
    # independent of the business-meaning uploaded_at above. Server-side
    # defaults (not Python-side ones) so the timestamp is correct even
    # for a row inserted by something other than this application (e.g.
    # a manual SQL script, or an admin tool run against the same DB).
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Deleting a document takes its correction history with it
    # (`cascade="all, delete-orphan"` on the ORM side, ON DELETE CASCADE
    # on the SQL side), so `DELETE /documents/{filename}` can't leave
    # orphaned audit rows pointing at a document that no longer exists.
    corrections: Mapped[List["FieldCorrection"]] = relationship(
        back_populates="document",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="FieldCorrection.corrected_at",
    )

    def __repr__(self) -> str:
        return f"Document(id={self.id}, filename={self.filename!r}, document_type={self.document_type!r})"


class FieldCorrection(Base):
    """
    One audit-log entry per field a reviewer changed.

    Append-only by design: rows are inserted when a correction is saved
    and never updated or deleted (except by cascade when the parent
    Document goes away). Correcting the same field a second time adds a
    second row rather than overwriting the first, so the full history of
    what a document's data looked like over time is reconstructible —
    the property that separates an auditable review workflow from a
    plain editable form, and the reason the "current" values live on
    `Document.reviewed_data` instead of being derived by replaying these
    rows on every read.
    """

    __tablename__ = "field_corrections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    # Indexed because the only query this table serves is "the history
    # for one document", which the review endpoints run on every read.
    document_id: Mapped[int] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True, nullable=False
    )

    # The key inside the document type's field schema, e.g. "pan_number"
    # — not a display label. Stored as a plain string rather than an
    # enum: the valid set differs per document type and already lives in
    # schemas/extraction.py, and pinning it down here would mean a
    # migration every time a schema gains a field.
    field_name: Mapped[str] = mapped_column(String(100), nullable=False)

    # JSON, not String, because a field's value isn't always a scalar —
    # a prescription's `medicines` is a list — and because JSON null
    # round-trips as a real `None`, keeping "the model found nothing"
    # distinguishable from "the model found an empty string".
    original_value: Mapped[Optional[Any]] = mapped_column(JSON, nullable=True)
    corrected_value: Mapped[Optional[Any]] = mapped_column(JSON, nullable=True)

    corrected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    document: Mapped["Document"] = relationship(back_populates="corrections")

    def __repr__(self) -> str:
        return f"FieldCorrection(document_id={self.document_id}, field_name={self.field_name!r})"


class ProcessingEvent(Base):
    """
    One attempt at one pipeline stage (OCR / classification /
    extraction), success or failure — written by `api/processing_metrics.py`
    around every call to `services.ocr_service`, `classification_service`,
    and `extraction_service`.

    Deliberately *not* linked to `Document` by a foreign key, unlike
    `FieldCorrection` above. `FieldCorrection` describes the review
    history *of* a document, so it's right for that history to disappear
    when the document does (`ondelete="CASCADE"`). This table describes
    the health of the *pipeline* — "how often does OCR succeed", "how
    long does extraction take" — which is operational telemetry, not a
    fact about any single document, and an accurate 30-day success-rate
    trend must stay accurate even if some of the documents it was
    computed from are later deleted. `filename` is stored as a plain
    indexed string for the same reason: it's enough to join back to
    `Document` for analytics that need to (see
    `database/analytics.py:average_processing_time_seconds`), without
    coupling this row's lifetime to that document's.

    Multiple rows can share a `filename`: every endpoint that can trigger
    a given stage is instrumented independently (`POST .../ocr`, and
    also `POST .../classify` and `POST .../extract`, both of which run
    OCR again internally rather than reusing a prior result — an
    existing inefficiency this feature doesn't fix, only observes), and a
    caller retrying a failed request produces a second, separate attempt.
    Each is a real event worth its own row.
    """

    __tablename__ = "processing_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    filename: Mapped[str] = mapped_column(String(255), index=True, nullable=False)

    stage: Mapped[ProcessingStage] = mapped_column(
        SQLAlchemyEnum(
            ProcessingStage,
            name="processing_stage",
            native_enum=False,
            validate_strings=True,
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
    )
    status: Mapped[ProcessingStatus] = mapped_column(
        SQLAlchemyEnum(
            ProcessingStatus,
            name="processing_status",
            native_enum=False,
            validate_strings=True,
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
    )

    # Wall-clock time the attempt took, start to finish (whether it
    # succeeded or failed), in whole milliseconds — enough precision for
    # a Vertex AI call that takes hundreds of milliseconds to tens of
    # seconds, without the storage/portability friction of a
    # sub-millisecond float.
    duration_ms: Mapped[int] = mapped_column(Integer, nullable=False)

    # The failing exception's class name (e.g. "OCRRateLimitError"), not
    # its message — a message is free-form and not group-by-able; a
    # class name is exactly the "what kind of failure" a success-rate
    # breakdown by cause would want to group on. None on success.
    error_type: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)

    # When the attempt began (not when this row was written — the two
    # are only moments apart in practice, but `started_at` is the one
    # that's actually meaningful for the daily trend and is set
    # explicitly by the caller rather than defaulted by the database, so
    # it survives a wrapped operation that ends up erroring out before a
    # row can be written). Indexed: every analytics query that scopes to
    # a date range filters on this column.
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)

    def __repr__(self) -> str:
        return f"ProcessingEvent(filename={self.filename!r}, stage={self.stage!r}, status={self.status!r})"
