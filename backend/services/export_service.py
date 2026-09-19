"""
Business logic for the bulk xlsx export: turning a stream of `Document`
rows into a spreadsheet, one document per row, without ever holding the
whole export in memory.

Framework-agnostic in the same sense every other `services/` module is —
no FastAPI, no HTTP — but it does take a plain `database.models.Document`
per row rather than a schema/dict. `services/review_service.py` already
established that precedent: a `Document` handed to a service is a
read-only data holder at that point, not a live-query handle, since
nothing here calls back into the session that loaded it.

--- Why every document type shares one sheet --------------------------

PAN Card, Aadhaar Card, Invoice, and Medical Prescription each have a
different field set (`schemas/extraction.py`). Rather than one sheet per
type, every field name across all four is a column in one "Documents"
sheet (`_extracted_field_names`); a row for an Invoice simply leaves its
PAN/Aadhaar/Prescription columns blank. That's what makes "export all
processed documents" a single downloadable inventory instead of four
separate files a consumer would have to reassemble themselves, and it
generalizes for free to a fifth document type added later — its fields
just extend the column list, no new sheet-handling code needed.

See `write_documents_xlsx`'s docstring for how the write-only workbook
and per-chunk pandas normalization actually bound memory use.
"""
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

import pandas as pd
from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet

from core.document_types import DocumentType
from database.models import Document
from services.extraction_service import EXTRACTION_MODEL_BY_TYPE

logger = logging.getLogger(__name__)

# Human-readable Excel header for each extracted-field key. A second
# copy of frontend/src/utils/fieldLabels.js's map rather than a shared
# source of truth — nothing before this feature crossed the
# frontend/backend boundary, and duplicating a dozen-entry label map is
# cheaper than building one.
_FIELD_LABELS = {
    "name": "Name",
    "father_name": "Father's Name",
    "dob": "Date of Birth",
    "pan_number": "PAN Number",
    "gender": "Gender",
    "aadhaar_number": "Aadhaar Number",
    "invoice_number": "Invoice Number",
    "vendor_name": "Vendor Name",
    "invoice_date": "Invoice Date",
    "total_amount": "Total Amount",
    "patient_name": "Patient Name",
    "doctor_name": "Doctor Name",
    "date": "Date",
    "medicines": "Medicines",
    "Client_Code": "Client Code",
    "Client_Name": "Client Name",
    # Disambiguated from Prescription's "patient_name" -> "Patient Name"
    # above: without this, the export sheet would carry two columns
    # both headed "Patient Name" with no way to tell them apart.
    "Patient Name": "Patient Name (TRF)",
    "AGE": "Age",
    "Sex": "Sex",
    "Contact_Number": "Contact Number",
    "DOCTOR_NAME": "Referring Doctor",
    "TRF_Number": "TRF Number",
    "TestName": "Test Name",
    "TestCode": "Test Code",
    "SampleCollectionDateTime": "Sample Collection Date/Time",
    "SAMPLE_TYPE": "Sample Type",
}

FIXED_COLUMNS = ("Filename", "Document Type", "Created Date")

# How many ORM rows become one pandas DataFrame before being flushed to
# the sheet. This is the memory/throughput knob "handle large datasets"
# is actually built around: large enough that pandas' vectorized
# reindex/fillna is worth its call overhead, small enough that no matter
# how many million rows the export covers in total, the process only
# ever holds this many document dicts in Python memory at once.
CHUNK_SIZE = 1000


def _extracted_field_names() -> list[str]:
    """
    Every extracted-field key across all four document types, in a
    stable order — PAN Card's fields, then Aadhaar's, then Invoice's,
    then Prescription's — de-duplicating a name (e.g. "name", "dob") the
    moment it's seen a second time rather than giving it a second column.

    Walking `DocumentType` (not `EXTRACTION_MODEL_BY_TYPE.values()`
    directly) is what fixes that order deliberately rather than
    incidentally: dict iteration follows insertion order in Python, but
    pinning the walk to the enum means the column order can't quietly
    reshuffle if that dict is ever redefined differently.
    """
    seen: dict[str, None] = {}
    for document_type in DocumentType:
        model_cls = EXTRACTION_MODEL_BY_TYPE.get(document_type)
        if model_cls is None:
            continue  # DocumentType.UNKNOWN has no field schema.
        for field_name, field_info in model_cls.model_fields.items():
            # A field's alias (e.g. TestReportFormFields.Patient_Name ->
            # "Patient Name") is the key actually stored in
            # extracted_data/reviewed_data (see review_service.py and
            # api/routes/extraction.py, both of which dump by_alias=True),
            # so the column list has to walk by that same key or it would
            # look up a key that's never actually present in the row dict.
            seen.setdefault(field_info.alias or field_name, None)
    return list(seen)


def _format_cell(value: Any) -> Any:
    """
    Normalize one extracted-field value into something a spreadsheet
    cell can hold.

    A list (only `medicines` today, but nothing here assumes that) has
    no native Excel representation, so it's joined into one string —
    with `"; "`, not `", "`, because a single medicine entry can itself
    contain a comma ("500mg, twice daily"). Everything else — including
    `None`, which is how a field extraction couldn't find reads — becomes
    a blank cell rather than the literal text "None".
    """
    if isinstance(value, list):
        return "; ".join(str(item) for item in value if item not in (None, ""))
    if value is None:
        return ""
    return value


def _search_text_for(document: Document) -> str:
    """
    Everything about a document free-text search should match, lowercased:
    its stored filename plus every non-empty current-best field value.

    A deliberate mirror of `frontend/src/utils/documentRecords.js`'s
    `searchTextFor` — same "reviewed or extracted" source, same `"; "`
    join for a list value, same values-only rule (field *keys* are
    excluded, so searching "name" doesn't match every document that
    merely has a name field). The export has to agree with it exactly,
    because "export what I'm looking at" is only true if both sides
    decide "matches" the same way.
    """
    data = document.reviewed_data or document.extracted_data or {}
    values = (str(_format_cell(value)) for value in data.values())
    return " ".join([document.filename, *(value for value in values if value.strip())]).lower()


def iter_matching_search(documents: Iterable[Document], search: Optional[str]) -> Iterator[Document]:
    """
    Narrow a document stream to those matching `search`, or pass it
    through untouched when `search` is empty.

    Applied in Python rather than pushed down into the query, unlike
    every other export filter (`database.crud.iter_documents_for_export`).
    The values being searched live inside a JSON column, and the only
    thing SQL could cheaply do with that column is a `LIKE` over its
    serialized text — which would match field *keys* and JSON punctuation
    as readily as values, giving the export a different notion of
    "matches" than the list screen that triggered it. Scanning in Python
    costs a comparison per row on a scan the export is already doing, and
    keeps the two definitions identical.

    Streaming, not a list comprehension: the whole point of the iterator
    this wraps is that no more than one batch of rows is ever resident,
    and materializing the filtered result here would throw that away.
    """
    if not search or not search.strip():
        yield from documents
        return

    needle = search.strip().lower()
    for document in documents:
        if needle in _search_text_for(document):
            yield document


def _as_naive_datetime(value: Optional[datetime]) -> Optional[datetime]:
    """openpyxl refuses a timezone-aware datetime outright; keep the wall-clock value, drop the tzinfo."""
    if value is None or value.tzinfo is None:
        return value
    return value.replace(tzinfo=None)


def _row_dict(document: Document, field_names: list[str]) -> dict[str, Any]:
    """One `Document` -> one flat dict keyed by final column headers, ready for a pandas DataFrame."""
    # "Current best data" — the same convention the review API uses
    # (docs/architecture.md): a document a human has corrected exports
    # the corrected values; one nobody has reviewed yet exports the raw
    # AI extraction; one that was never extracted at all (still
    # `Unknown`, upload-only) exports blank field columns rather than
    # being left out of the sheet entirely — this is a document
    # inventory, not only an extraction report.
    data = document.reviewed_data or document.extracted_data or {}
    row: dict[str, Any] = {
        "Filename": document.filename,
        "Document Type": document.document_type.value,
        "Created Date": _as_naive_datetime(document.created_at),
    }
    for field_name in field_names:
        row[_FIELD_LABELS.get(field_name, field_name)] = _format_cell(data.get(field_name))
    return row


def _chunked(documents: Iterable[Document], size: int) -> Iterator[list[Document]]:
    """Group an iterable into fixed-size lists, without assuming it supports slicing or has a known length."""
    chunk: list[Document] = []
    for document in documents:
        chunk.append(document)
        if len(chunk) >= size:
            yield chunk
            chunk = []
    if chunk:
        yield chunk


def _write_header(sheet: Worksheet, headers: list[str]) -> None:
    """
    Append a bold header row.

    Write-only sheets have no cells to reach back and style after the
    fact — each row is flushed to a temp file the moment `append()`
    returns — so a styled cell has to be built with its style already
    set (`WriteOnlyCell`) before it's appended, unlike a normal
    worksheet's `ws["A1"].font = ...`.
    """
    bold = Font(bold=True)
    cells = []
    for header in headers:
        cell = WriteOnlyCell(sheet, value=header)
        cell.font = bold
        cells.append(cell)
    sheet.append(cells)


def write_documents_xlsx(documents: Iterable[Document], destination: Path) -> int:
    """
    Stream `documents` into a `.xlsx` workbook at `destination`.

    Returns the number of document rows written (the header doesn't
    count), so the route layer can log or report it without re-deriving
    it from the file.

    --- Why `write_only=True` --------------------------------------------

    A normal `openpyxl.Workbook()` keeps every cell of every sheet as a
    live Python object for the life of the workbook — writing a large
    export would mean the *entire* spreadsheet sitting in memory before
    a single byte reaches disk. `write_only=True` trades the ability to
    read cells back for exactly the property a large export needs: each
    `append()` is flushed to a temporary file immediately, so memory use
    stays bounded by whatever's in the current chunk, not by how many
    rows have been written so far.

    --- Where pandas earns its place -------------------------------------

    Rows arrive from the database already batched (see
    `database.crud.iter_documents_for_export`), and each batch is turned
    into a small `DataFrame` before being written, which buys two things
    a raw loop over dicts would otherwise have to reimplement: `reindex`
    guarantees every batch produces exactly the same columns in the same
    order even if, say, a batch happens to contain no PAN cards (so no
    `pan_number` key ever appears in its row dicts); and replacing
    whatever pandas leaves not-a-number with `""` collapses every flavor
    of "empty" it might introduce (`NaN`, `NaT`, `None`) to the one blank
    cell every other column already uses for "no value" — the same
    single-way-to-spell-missing rule `schemas/extraction.py` applies to
    extraction itself.
    """
    field_names = _extracted_field_names()
    headers = [*FIXED_COLUMNS, *(_FIELD_LABELS.get(name, name) for name in field_names)]

    workbook = Workbook(write_only=True)
    sheet = workbook.create_sheet("Documents")
    _write_header(sheet, headers)
    sheet.freeze_panes = "A2"
    for index, header in enumerate(headers, start=1):
        sheet.column_dimensions[get_column_letter(index)].width = max(len(header) + 2, 14)

    row_count = 0
    for batch in _chunked(documents, CHUNK_SIZE):
        frame = pd.DataFrame([_row_dict(document, field_names) for document in batch])
        frame = frame.reindex(columns=headers)
        frame = frame.where(frame.notna(), "")

        for record in frame.itertuples(index=False, name=None):
            # A DataFrame column of Python `datetime`s comes back out as
            # `pandas.Timestamp` (a `datetime` subclass with extra
            # precision openpyxl doesn't understand) — converted back to
            # a plain `datetime` here rather than left for openpyxl to
            # choke on.
            sheet.append(
                [value.to_pydatetime() if isinstance(value, pd.Timestamp) else value for value in record]
            )
            row_count += 1

    workbook.save(destination)
    logger.info("Wrote %d document row(s) to xlsx export at %s", row_count, destination)
    return row_count
