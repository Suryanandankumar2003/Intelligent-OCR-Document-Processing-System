"""
CRUD (Create, Read, Update, Delete) operations for the `Document` table.

Every function takes a plain SQLAlchemy `Session` as its first argument
and returns plain ORM objects (or `None`/a list of them) — no FastAPI
imports, no HTTP concerns — the same "framework-agnostic" rule the
`services/` layer follows, so this module can be unit-tested against an
in-memory SQLite DB without spinning up the API.

--- Transaction boundaries ------------------------------------------------

Each write function (`create_document`, `save_extraction_result`,
`delete_document`) commits its own change and is therefore its own
transaction. That's a deliberate simplification: nothing in this app
currently needs several of these calls to succeed or fail together
atomically. If a future feature does need that, build it with
`db.add()`/`db.flush()` directly against the `Session` rather than
composing these helpers (composing them would commit partial state
before the "atomic" operation finishes).

Every commit is wrapped so a database-level failure (disk full, the
SQLite file locked by another process, a constraint violation) surfaces
as `core.exceptions.DocumentPersistenceError` — a clean, already-handled
exception type (see `app.py`) — instead of a raw `SQLAlchemyError`
leaking out of the data layer and into a route handler that has no idea
what to do with it.
"""
import logging
from datetime import datetime, timezone
from typing import Iterator, Optional

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from core.document_types import DocumentType
from core.exceptions import DocumentPersistenceError
from core.processing_event import ProcessingStage, ProcessingStatus
from core.review_status import ReviewStatus
from database.models import Document, FieldCorrection, ProcessingEvent

logger = logging.getLogger(__name__)


def _commit(db: Session, document: Document) -> Document:
    """Shared commit/refresh/error-translation path for every write below."""
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Database commit failed for Document(filename=%r)", document.filename)
        raise DocumentPersistenceError(str(exc)) from exc
    db.refresh(document)
    return document


def create_document(
    db: Session,
    *,
    filename: str,
    document_type: DocumentType = DocumentType.UNKNOWN,
    extracted_data: Optional[dict] = None,
    uploaded_at: Optional[datetime] = None,
) -> Document:
    """
    Insert a new Document row.

    Used by `POST /upload` the moment a file is saved to disk:
    `document_type` defaults to `UNKNOWN` and `extracted_data` to `None`
    because neither classification nor extraction has run yet for a
    freshly uploaded file. `uploaded_at` defaults to "now" only as a
    fallback — the upload route always passes the real timestamp it
    already computed while saving the file.
    """
    document = Document(
        filename=filename,
        document_type=document_type,
        extracted_data=extracted_data,
        uploaded_at=uploaded_at or datetime.now(timezone.utc),
    )
    db.add(document)
    return _commit(db, document)


def get_document(db: Session, document_id: int) -> Optional[Document]:
    """Fetch a single Document by its primary key, or None if it doesn't exist."""
    return db.get(Document, document_id)


def get_document_by_filename(db: Session, filename: str) -> Optional[Document]:
    """
    Fetch a single Document by its stored filename, or None.

    This is the lookup every route actually uses in practice: clients
    address a document by the filename `POST /upload` returned, never by
    the internal integer `id`.
    """
    stmt = select(Document).where(Document.filename == filename)
    return db.execute(stmt).scalar_one_or_none()


def list_documents(
    db: Session,
    *,
    skip: int = 0,
    limit: int = 100,
    document_type: Optional[DocumentType] = None,
) -> list[Document]:
    """
    Page through stored documents, most recently uploaded first.

    `document_type` is an optional equality filter (e.g. "show me every
    Invoice") — the one filter an operator browsing this table is most
    likely to want. `skip`/`limit` are plain offset pagination, which is
    adequate at this table's expected size; a cursor-based scheme isn't
    worth the added complexity here.
    """
    stmt = select(Document).order_by(Document.uploaded_at.desc()).offset(skip).limit(limit)
    if document_type is not None:
        stmt = stmt.where(Document.document_type == document_type)
    return list(db.execute(stmt).scalars().all())


def save_extraction_result(
    db: Session,
    *,
    filename: str,
    document_type: DocumentType,
    extracted_data: dict,
) -> Document:
    """
    Persist a field-extraction result for `filename`: this is the "save
    extracted document data" entry point, called by
    `api/routes/extraction.py` right after a successful extraction.

    Updates the existing row in place (every file that reaches
    extraction should already have one, created by `POST /upload`) and
    only falls back to creating a new row if it's somehow missing — e.g.
    a file dropped into `uploads/` without going through the upload
    endpoint, or a database that was reset after files were already on
    disk. `filename` is unique, so this can never create a second row
    for the same physical file: it is always exactly one or the other,
    update or create, never both.
    """
    document = get_document_by_filename(db, filename)
    if document is None:
        return create_document(
            db, filename=filename, document_type=document_type, extracted_data=extracted_data
        )

    document.document_type = document_type
    document.extracted_data = extracted_data
    return _commit(db, document)


def iter_documents_for_export(
    db: Session,
    *,
    document_type: Optional[DocumentType] = None,
    uploaded_from: Optional[datetime] = None,
    uploaded_to: Optional[datetime] = None,
    batch_size: int = 1000,
) -> Iterator[Document]:
    """
    Yield every matching Document, oldest-uploaded first, without ever
    holding more than one `batch_size` chunk of ORM objects in memory —
    the data-access half of "handle large datasets" (the other half,
    keeping the xlsx itself off the memory budget, is
    `services/export_service.py`'s job).

    Deliberately not `list_documents` with `limit` raised: that endpoint
    uses OFFSET/LIMIT paging, which is fine for the page sizes a browsing
    UI asks for (`limit<=500`) but degrades to rescanning and discarding
    an ever-larger prefix of the table as OFFSET grows — quadratic work
    for a full-table export. This instead uses keyset pagination: each
    batch asks for "the next `batch_size` rows after the last id I saw",
    which costs the same (an index seek) whether it's the first batch or
    the thousandth. `id` is the key, not `uploaded_at`, because it's the
    one column guaranteed unique — paging on a timestamp that two
    documents could share risks silently skipping or repeating a row at
    a batch boundary.
    """
    last_seen_id = 0
    while True:
        stmt = select(Document).where(Document.id > last_seen_id).order_by(Document.id.asc()).limit(batch_size)
        if document_type is not None:
            stmt = stmt.where(Document.document_type == document_type)
        if uploaded_from is not None:
            stmt = stmt.where(Document.uploaded_at >= uploaded_from)
        if uploaded_to is not None:
            stmt = stmt.where(Document.uploaded_at <= uploaded_to)

        batch = list(db.execute(stmt).scalars().all())
        if not batch:
            return

        yield from batch
        last_seen_id = batch[-1].id

        # A short batch means this was the last page — skip the query
        # that would otherwise confirm it, since the filtered `WHERE`
        # clauses above mean a full batch doesn't itself guarantee more
        # rows exist, but a short one always means none do.
        if len(batch) < batch_size:
            return


def save_review(
    db: Session,
    *,
    document: Document,
    reviewed_data: dict,
    corrections: list[dict],
) -> Document:
    """
    Persist one review save: the reviewer's approved field set plus the
    audit trail of what they changed.

    Three things happen together here — `reviewed_data` is written,
    the document is marked `REVIEWED`, and one `FieldCorrection` row is
    appended per entry in `corrections` — and they happen in a single
    transaction, built with `db.add()` against the session directly
    rather than by calling the other write helpers in this module. That
    is exactly the case this module's docstring describes: composing
    those helpers would commit the document update before the audit rows
    were written, leaving a window where the data says it was corrected
    but nothing records what the original values were.

    `corrections` may legitimately be empty: a reviewer who reads the
    extracted fields and finds nothing to fix has still reviewed the
    document, and gets the status change with no audit rows.

    Each correction dict is `{"field_name": str, "original_value": Any,
    "corrected_value": Any}`, as produced by
    `services.review_service.apply_corrections`.
    """
    document.reviewed_data = reviewed_data
    document.review_status = ReviewStatus.REVIEWED
    document.reviewed_at = datetime.now(timezone.utc)

    for correction in corrections:
        db.add(
            FieldCorrection(
                document_id=document.id,
                field_name=correction["field_name"],
                original_value=correction["original_value"],
                corrected_value=correction["corrected_value"],
            )
        )

    return _commit(db, document)


def list_field_corrections(db: Session, document_id: int) -> list[FieldCorrection]:
    """
    The full correction history for one document, oldest first.

    Chronological rather than newest-first because this is read as a
    story of how the data got to its current state — and because a field
    corrected more than once only makes sense read in the order the
    changes happened.
    """
    stmt = (
        select(FieldCorrection)
        .where(FieldCorrection.document_id == document_id)
        .order_by(FieldCorrection.corrected_at.asc(), FieldCorrection.id.asc())
    )
    return list(db.execute(stmt).scalars().all())


def delete_document(db: Session, document: Document) -> None:
    """
    Delete a Document row.

    Takes the ORM object itself, not an id/filename, so the caller has
    already looked it up (typically via `get_document_by_filename`) and
    can return a 404 *before* ever reaching this function — this
    function has no "not found" case of its own to report.
    """
    try:
        db.delete(document)
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Database delete failed for Document(filename=%r)", document.filename)
        raise DocumentPersistenceError(str(exc)) from exc


def record_processing_event(
    db: Session,
    *,
    filename: str,
    stage: ProcessingStage,
    status: ProcessingStatus,
    duration_ms: int,
    started_at: datetime,
    error_type: Optional[str] = None,
) -> Optional[ProcessingEvent]:
    """
    Record one pipeline-stage attempt for the analytics dashboard.

    Deliberately breaks this module's usual "raise `DocumentPersistenceError`
    on write failure" rule: every other function here writes data the
    request cannot correctly respond without (an upload's own record, a
    reviewer's correction), so a write failure has to stop the request.
    A processing event is telemetry *about* a request that has already
    succeeded or failed on its own terms — losing one to a database
    hiccup should cost the dashboard one data point, not turn an
    otherwise-successful OCR call into a 500. So this logs and swallows
    instead of raising, and returns `None` on failure rather than a
    `ProcessingEvent` the caller has no need to act on either way.
    """
    event = ProcessingEvent(
        filename=filename,
        stage=stage,
        status=status,
        duration_ms=duration_ms,
        error_type=error_type,
        started_at=started_at,
    )
    db.add(event)
    try:
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        logger.exception(
            "Failed to record processing event (filename=%r, stage=%r, status=%r) — dropping it",
            filename,
            stage.value,
            status.value,
        )
        return None
    db.refresh(event)
    return event
