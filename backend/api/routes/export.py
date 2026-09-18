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
from database import crud
from database.session import get_db
from services.export_service import write_documents_xlsx

router = APIRouter(prefix="/documents", tags=["Export"])

_XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@router.get(
    "/export/xlsx",
    response_class=FileResponse,
    summary="Download an xlsx export of every processed document",
)
def export_documents_xlsx(
    document_type: Optional[DocumentType] = Query(
        default=None, description="Only export documents of this type. Omitted: every type."
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
    """
    documents = crud.iter_documents_for_export(
        db, document_type=document_type, uploaded_from=uploaded_from, uploaded_to=uploaded_to
    )

    fd, tmp_path = tempfile.mkstemp(suffix=".xlsx", prefix="documents_export_")
    os.close(fd)  # Only the path is needed; openpyxl opens and writes the file itself.
    destination = Path(tmp_path)

    write_documents_xlsx(documents, destination)

    download_name = f"documents_export_{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.xlsx"
    return FileResponse(
        destination,
        media_type=_XLSX_MEDIA_TYPE,
        filename=download_name,
        background=BackgroundTask(destination.unlink, missing_ok=True),
    )
