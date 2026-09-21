"""
Human-review endpoints — the correction half of the extraction workflow.

`api/routes/extraction.py` produces the model's first answer; these two
endpoints let a person read it, fix what's wrong, and have both the fix
and what it replaced recorded:

  GET   /documents/{filename}/review           — current state + correction history
  PATCH /documents/{filename}/review           — save corrections
  POST  /documents/{filename}/review/decision  — approve or reject, no data change
  GET   /documents/{filename}/audit            — the full audit history, newest first

PATCH rather than PUT, and a partial `corrected_fields` body rather than
a whole document: a review is by nature "these three fields were wrong",
and modelling it that way is what lets the server record exactly what
the reviewer touched (see `schemas/review.py`).

Note the division of labour, which follows the same layering the rest of
the backend uses: this module does HTTP concerns only (look the document
up, 404/409 if it isn't reviewable, shape the response),
`services/review_service.py` decides what a correction *means*, and
`database/crud.py` writes it. None of the three knows how the other two
work.

--- Why these endpoints write to the application log -------------------

A correction is already audited: `field_corrections` records every value
that changed, and has since before the Logs module existed. What it
cannot record is an action that changed no value — which is exactly what
an approval and a rejection are, and why `save_review_decision`
deliberately writes no correction rows (inventing audit entries saying a
field was "corrected" to the value it already had would make the trail
say something untrue).

That left the two most consequential things a reviewer does invisible to
any history. The log rows written here are where they live, and
`services/audit_service.py` is what merges them back together with the
field changes into the one chronological list the Audit History panel
shows.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from core.exceptions import DocumentNotYetExtractedError
from core.log_events import LogEventType, LogStatus
from core.review_status import ReviewStatus
from database import crud, log_crud
from database.models import Document, FieldCorrection
from database.session import get_db
from schemas.logs import DocumentAuditEntry, DocumentAuditResponse
from schemas.review import (
    DocumentReviewDecision,
    DocumentReviewResponse,
    DocumentReviewUpdate,
    FieldCorrectionRecord,
    ReviewDecision,
)
from services.audit_service import CHANGED_FIELDS_KEY, build_audit_history
from services.event_log import log_event
from services.review_service import apply_corrections

router = APIRouter(prefix="/documents", tags=["Review"])


def _get_reviewable_document(db: Session, filename: str) -> Document:
    """
    Load the document `filename` addresses, or fail with the right status.

    Two distinct failures, deliberately not collapsed into one: a
    filename with no record is a 404 (nothing here, and nothing the
    caller can do will change that), while a document that exists but
    has never been extracted is a 409 (the resource is real, the request
    is just premature — run extraction and this same call works).
    """
    document = crud.get_document_by_filename(db, filename)
    if document is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"No document record found for '{filename}'."
        )
    if document.extracted_data is None:
        raise DocumentNotYetExtractedError(filename)
    return document


def _build_review_response(
    document: Document, corrections: list[FieldCorrection]
) -> DocumentReviewResponse:
    """Assemble the shared response both endpoints return."""
    return DocumentReviewResponse(
        filename=document.filename,
        document_type=document.document_type,
        original_data=document.extracted_data or {},
        # Falls back to the original extraction for a document nobody has
        # reviewed yet, so the client always has a populated field set to
        # render and never needs a "which one do I show?" branch.
        reviewed_data=document.reviewed_data or document.extracted_data or {},
        # Stored at OCR time, so the review screen can show the transcript
        # on a cold load instead of only when the reviewer arrived straight
        # from the pipeline that produced it.
        ocr_text=document.ocr_text,
        review_status=document.review_status,
        reviewed_at=document.reviewed_at,
        corrections=[FieldCorrectionRecord.model_validate(correction) for correction in corrections],
    )


@router.get(
    "/{filename}/review",
    response_model=DocumentReviewResponse,
    summary="Get a document's review state and correction history",
)
def get_document_review(filename: str, db: Session = Depends(get_db)) -> DocumentReviewResponse:
    """
    Everything the review screen needs to render, in one call.

    Exists so the screen is reachable independently of the upload
    pipeline that produced the document — reload the page, or come back
    to a document processed last week, and the corrected values and the
    history behind them are still there.
    """
    document = _get_reviewable_document(db, filename)

    # Recorded because "nobody has looked at this" and "somebody looked
    # at it and left it alone" are different facts about a document
    # sitting in Pending Review, and nothing else in the system can tell
    # them apart. Deliberately kept out of the Audit History panel
    # (`core/log_events.py:REVIEW_ACTION_EVENT_TYPES`): it belongs in the
    # log, not in a trail of changes, where a row per page load would
    # bury the actions between them.
    log_event(
        db,
        event_type=LogEventType.REVIEW_OPENED,
        message=f"Review screen opened for '{filename}'.",
        filename=filename,
        document_id=document.id,
        document_type=document.document_type,
        details={"review_status": document.review_status.value},
    )

    return _build_review_response(document, crud.list_field_corrections(db, document.id))


@router.patch(
    "/{filename}/review",
    response_model=DocumentReviewResponse,
    status_code=status.HTTP_200_OK,
    summary="Save reviewer corrections to a document's extracted fields",
)
def update_document_review(
    filename: str,
    payload: DocumentReviewUpdate,
    db: Session = Depends(get_db),
) -> DocumentReviewResponse:
    """
    Apply `corrected_fields` to the document and record what changed.

    Returns the full post-save state rather than a bare 204, because the
    values the server stores are not always the values the client sent —
    the document type's validators normalize them on the way in (a PAN
    number is upper-cased, a blank field becomes `null`). Handing back
    the stored result lets the screen show what was actually saved
    instead of assuming its own copy is authoritative.

    Idempotent in the way that matters: re-sending the same correction
    for an already-corrected field changes nothing and logs nothing,
    because the values no longer differ from the original extraction.
    """
    document = _get_reviewable_document(db, filename)

    reviewed_data, correction_records = apply_corrections(document, payload.corrected_fields)
    document = crud.save_review(
        db, document=document, reviewed_data=reviewed_data, corrections=correction_records
    )

    # Logged *after* the save, never before: a log line saying a review
    # was saved, written next to a transaction that then failed, is worse
    # than no line at all. The field names ride along in `details` under
    # the key `services/audit_service.py` reads them back from, which is
    # what lets the Audit History panel say "3 fields" on the action row
    # without re-deriving it from the correction rows beneath it.
    #
    # The list can legitimately be empty — every submitted value can
    # normalize back to what was already stored — and that is recorded
    # honestly rather than suppressed, because "the reviewer saved and
    # nothing changed" is a real event.
    changed = [record["field_name"] for record in correction_records]
    log_event(
        db,
        event_type=LogEventType.REVIEW_SAVED,
        message=(
            f"Review saved for '{filename}' with "
            f"{len(changed)} corrected field{'' if len(changed) == 1 else 's'}."
        ),
        filename=filename,
        document_id=document.id,
        document_type=document.document_type,
        details={
            CHANGED_FIELDS_KEY: changed,
            "submitted_fields": sorted(payload.corrected_fields),
            "review_status": document.review_status.value,
        },
    )

    return _build_review_response(document, crud.list_field_corrections(db, document.id))


# The only place the client's vocabulary ("approve"/"reject") is
# translated into the stored workflow state. Kept as a dict at module
# level rather than an if/elif in the handler so that adding a third
# verdict later is one line here plus one enum member, with no branch to
# forget — and so exhaustiveness is visible at a glance.
_STATUS_BY_DECISION = {
    ReviewDecision.APPROVE: ReviewStatus.REVIEWED,
    ReviewDecision.REJECT: ReviewStatus.REJECTED,
}

# The same shape, for the same reason, one layer along: a third verdict
# later is one line here rather than a branch in the handler that
# somebody forgets to extend.
_EVENT_BY_DECISION = {
    ReviewDecision.APPROVE: LogEventType.DOCUMENT_APPROVED,
    ReviewDecision.REJECT: LogEventType.DOCUMENT_REJECTED,
}


@router.post(
    "/{filename}/review/decision",
    response_model=DocumentReviewResponse,
    status_code=status.HTTP_200_OK,
    summary="Approve or reject a document's extracted fields without changing them",
)
def decide_document_review(
    filename: str,
    payload: DocumentReviewDecision,
    db: Session = Depends(get_db),
) -> DocumentReviewResponse:
    """
    Record a verdict on the field set exactly as it currently stands.

    The action PATCH above cannot express. That endpoint is for
    *corrections* and refuses an empty body on purpose, which leaves the
    two most common review outcomes — "the model got this right, sign it
    off" and "this extraction is unusable" — with no way to be recorded.
    This is that way.

    Deliberately writes no `reviewed_data` and logs no `FieldCorrection`
    rows: nothing about the document's data changed, and inventing audit
    entries that say a field was "corrected" to the value it already had
    would make the trail say something untrue. The verdict itself lives
    in `review_status`/`reviewed_at` alone (see
    `database.crud.save_review_decision`).

    POST rather than PATCH because this doesn't patch anything — it
    submits a decision about the resource. Not idempotent-by-accident
    either: re-approving an already-approved document is harmless but
    does move `reviewed_at`, which is correct, since a second reviewer
    signing off is a real event with a real time.

    Returns the same full review state every other endpoint in this
    module returns, so a client renders the result of a decision through
    exactly the path it already uses for a load or a save.
    """
    document = _get_reviewable_document(db, filename)
    document = crud.save_review_decision(
        db, document=document, review_status=_STATUS_BY_DECISION[payload.decision]
    )

    # The only record a decision leaves anywhere other than the two
    # columns it wrote. Approve and reject get their own event types
    # (and therefore their own categories, Approval and Rejection) rather
    # than one "decision" event carrying the verdict in its payload,
    # because the Logs screen's category filter and the analytics
    # breakdown both group on the category — and "show me every
    # rejection" should be a click, not a payload search.
    log_event(
        db,
        event_type=_EVENT_BY_DECISION[payload.decision],
        status=LogStatus.SUCCESS if payload.decision is ReviewDecision.APPROVE else LogStatus.WARNING,
        message=f"Document '{filename}' was {document.review_status.value.lower()}.",
        filename=filename,
        document_id=document.id,
        document_type=document.document_type,
        details={"decision": payload.decision.value, "review_status": document.review_status.value},
    )

    return _build_review_response(document, crud.list_field_corrections(db, document.id))


@router.get(
    "/{filename}/audit",
    response_model=DocumentAuditResponse,
    summary="A document's full audit history — field changes and review actions, newest first",
)
def get_document_audit(
    filename: str,
    limit: int = Query(
        default=100,
        ge=1,
        le=500,
        description="Most recent entries to return. The total is reported separately.",
    ),
    db: Session = Depends(get_db),
) -> DocumentAuditResponse:
    """
    Everything that has happened to this document, as one chronological
    list a reviewer can read top to bottom.

    Deliberately *not* served by `GET .../review`, even though that
    endpoint already returns `corrections` and the two overlap. Three
    reasons, in order of how much they matter:

    1. The review response is what the screen blocks on. Adding a second
       query plus a merge to it would slow the first paint of every
       review for a panel that starts collapsed and is opened for a
       minority of documents.
    2. The audit trail is re-read after every save and every decision,
       to show what just happened. Folding it into the review response
       would mean the only way to refresh it is to refetch the whole
       document.
    3. `corrections` is oldest-first and anchored to the original
       extraction, because it is read as the story of how a value got
       where it is. This is newest-first and interleaved with actions,
       because it is read to find out what happened last. Serving both
       orders from one field would mean one of the two consumers sorting
       the other's list on arrival.

    Unlike the review endpoints, this one does **not** require the
    document to have been extracted. A document that classified as
    Unknown has no fields and no corrections, but it can still have been
    opened, looked at, and rejected — and a 409 here would hide exactly
    the history explaining why it was.
    """
    document = crud.get_document_by_filename(db, filename)
    if document is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"No document record found for '{filename}'."
        )

    corrections = crud.list_field_corrections(db, document.id)
    action_logs = log_crud.list_document_action_logs(db, document_id=document.id, filename=filename)

    entries = build_audit_history(corrections, action_logs, limit=limit)

    return DocumentAuditResponse(
        filename=filename,
        # The total before the cap, so a panel showing the most recent
        # 100 of 340 entries can say so rather than implying there are
        # only 100.
        total_entries=len(corrections) + len(action_logs),
        entries=[DocumentAuditEntry(**entry) for entry in entries],
    )
