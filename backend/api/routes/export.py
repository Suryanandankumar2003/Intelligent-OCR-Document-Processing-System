"""
Bulk export endpoint: every processed document — filename, document
type, its (reviewed, or original) extracted fields, and when it was
created — as one downloadable `.xlsx` inventory.

The one HTTP-facing piece of the export feature. As with every other
route module, this file's job stops at request/response plumbing:
`database.crud.iter_documents_for_export` decides which rows and in
what batches, `services.export_service.write_documents_xlsx` decides
what the spreadsheet looks like, and this module just wires a request's
query params to the first and the second's output to a response.
"""
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask

from core.document_types import DocumentType
from core.log_events import LogEventType
from core.review_status import ReviewStatus
from database import crud
from database.session import get_db
from services.event_log import track_event
from services.export_service import iter_matching_search, write_documents_xlsx

router = APIRouter(prefix="/documents", tags=["Export"])

_XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _download_name(document_type: Optional[DocumentType], review_status: Optional[ReviewStatus]) -> str:
    """
    A filename that says what's in the file, not just when it was made.

    This is the name the browser actually saves the download under (via
    `Content-Disposition`, which the frontend reads — see `app.py`'s
    `expose_headers`), so a reviewer who exports "approved invoices"
    twice a week ends up with a folder they can read, rather than a pile
    of identical `documents_export_*.xlsx`. The free-text `search` filter
    is deliberately left out of the name: it's arbitrary user input, and
    sanitizing it into something safe on every filesystem is more risk
    than the extra word is worth.
    """
    parts = ["documents_export"]
    if review_status is not None:
        parts.append(review_status.value)
    if document_type is not None:
        parts.append(document_type.value)
    parts.append(f"{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}")
    # Spaces would land in the header's quoted filename legally, but
    # they survive the round-trip badly across browsers and shells.
    return "_".join(part.replace(" ", "-") for part in parts) + ".xlsx"


# Declared on a router that `api/router.py` includes *before*
# `documents.router`, which owns `GET /documents/{filename}` under the
# same prefix. Starlette matches routes in registration order, so that
# order is what guarantees this endpoint is reached rather than being
# swallowed as a document whose filename happens to be "export" — and
# it's why this file's router must keep being included first.
@router.get(
    "/export/xlsx",
    response_class=FileResponse,
    summary="Download an xlsx export of the matching processed documents",
)
def export_documents_xlsx(
    document_type: Optional[DocumentType] = Query(
        default=None, description="Only export documents of this type. Omitted: every type."
    ),
    review_status: Optional[ReviewStatus] = Query(
        default=None,
        description="Only export documents in this review state. Omitted: every state.",
    ),
    search: Optional[str] = Query(
        default=None,
        description=(
            "Only export documents whose filename or extracted field values contain this text "
            "(case-insensitive). Matches the documents list screen's search box exactly."
        ),
    ),
    uploaded_from: Optional[datetime] = Query(
        default=None, description="Only export documents uploaded on or after this timestamp."
    ),
    uploaded_to: Optional[datetime] = Query(
        default=None, description="Only export documents uploaded on or before this timestamp."
    ),
    db: Session = Depends(get_db),
) -> FileResponse:
    """
    Builds the workbook to a temporary file and streams that file back —
    never an in-memory buffer. `write_documents_xlsx` already keeps the
    *writing* side bounded (see its docstring); returning a `FileResponse`
    over a real path is what keeps the *sending* side bounded too, since
    Starlette streams a file back in chunks instead of holding the whole
    response body in memory the way returning `bytes` would.

    The temp file is removed once the response has been sent
    (`BackgroundTask`, which Starlette runs after the last chunk goes
    out) — so a failed or abandoned download doesn't leak a file, but the
    file also isn't deleted out from under a download that's still in
    progress.

    Every filter is optional and they compose, which is what lets one
    endpoint serve all three things the documents screen offers: no
    params at all is "export everything", the screen's active filters
    passed through is "export what I'm looking at", and
    `review_status=Reviewed` alone is "export the approved set".
    """
    documents = crud.iter_documents_for_export(
        db,
        document_type=document_type,
        review_status=review_status,
        uploaded_from=uploaded_from,
        uploaded_to=uploaded_to,
    )
    # Wraps the iterator rather than consuming it — the export stays
    # streaming end to end. See `iter_matching_search` for why this one
    # filter isn't a WHERE clause like the others.
    documents = iter_matching_search(documents, search)

    fd, tmp_path = tempfile.mkstemp(suffix=".xlsx", prefix="documents_export_")
    os.close(fd)  # Only the path is needed; openpyxl opens and writes the file itself.
    destination = Path(tmp_path)

    # Logged as a started/completed pair, because an export is the one
    # read-only operation in this system that can take long enough to be
    # abandoned halfway. A lone `Export Started` with no partner is how
    # an operator finds out that the download they thought was slow was
    # actually a request that died — a distinction a single completion
    # row could not make.
    #
    # The filters go in `details` on both rows, so a support question of
    # the form "the spreadsheet I pulled on Tuesday was missing things"
    # is answerable from the log rather than from memory.
    filters_used = {
        "document_type": document_type.value if document_type else None,
        "review_status": review_status.value if review_status else None,
        # Recorded as a flag, not a value: it is free-text the operator
        # typed, and an audit log is not the place to accumulate a
        # searchable history of what people looked for.
        "search_applied": bool(search and search.strip()),
        "uploaded_from": uploaded_from.isoformat() if uploaded_from else None,
        "uploaded_to": uploaded_to.isoformat() if uploaded_to else None,
    }
    with track_event(
        db,
        started=LogEventType.EXPORT_STARTED,
        completed=LogEventType.EXPORT_COMPLETED,
        start_message="Document export started.",
        success_message="Document export completed.",
        document_type=document_type,
    ) as details:
        details.update({"format": "xlsx", "filters": filters_used})
        # The row count is only known once the workbook is written, which
        # is exactly what the mutable `details` dict `track_event` yields
        # exists for — the completion row carries it, the start row
        # could not have.
        details["row_count"] = write_documents_xlsx(documents, destination)

    return FileResponse(
        destination,
        media_type=_XLSX_MEDIA_TYPE,
        filename=_download_name(document_type, review_status),
        background=BackgroundTask(destination.unlink, missing_ok=True),
    )
