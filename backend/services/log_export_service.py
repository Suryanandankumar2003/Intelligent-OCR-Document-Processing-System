"""
Business logic for the logs xlsx export: turning a stream of
`ApplicationLog` rows into a spreadsheet without ever holding the whole
export in memory.

The same shape as `services/export_service.py` — write-only workbook,
fixed chunk size, one flat row per record — and deliberately not a
generalization of it. That module's real work is the part this one has
no equivalent of: reconciling four different document types' field sets
into one stable column list, and normalizing every flavor of "missing"
pandas can introduce. A log row is already flat and already has fixed
columns. Sharing a base class between them would mean parameterizing
away the only interesting thing either of them does, and would leave two
callers wondering which of the shared code's branches applied to them.

What *is* shared is the memory contract, because it is the one property
both exports actually have to hold: `write_only=True` flushes each row
to a temp file as it is appended rather than keeping every cell alive
until save, so memory stays bounded by the current chunk however many
rows the export covers. That matters more here than there — this is the
table that grows by several rows per file per batch, so it is the one an
operator is most likely to export a million rows of.
"""
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet

from database.models import ApplicationLog

logger = logging.getLogger(__name__)

# The seven columns the logs screen shows, in the order it shows them,
# followed by two the screen cannot: the batch an event belonged to, and
# its structured payload.
#
# Those two exist because the reason to export logs at all is almost
# always to investigate a failure somewhere other than in this
# application — in a mail thread, a ticket, a spreadsheet someone is
# filtering by hand — and a failure row whose `details_json` was dropped
# on the way out has lost the part that says which stage, which error
# type, and which of the batch's four hundred files. Rebuilding that by
# cross-referencing the id against the running system is exactly the
# work an export is meant to save.
HEADERS = (
    "Timestamp",
    "Event Type",
    "Category",
    "Filename",
    "Status",
    "Message",
    "Processing Time (s)",
    "Batch ID",
    "Details",
)

# How many ORM rows are turned into sheet rows before the next chunk is
# read. Matches `services/export_service.py:CHUNK_SIZE` so both exports
# have the same memory profile; there is no reason for them to differ
# and a reader comparing the two should not have to wonder why they do.
CHUNK_SIZE = 1000

# `details_json` is free-form and occasionally large (a rejected batch
# upload lists every rejected filename). Excel's own hard ceiling is
# 32,767 characters per cell, and a cell anywhere near it is unreadable
# anyway, so the payload is truncated well below it with a marker that
# says so rather than being silently cut.
MAX_DETAILS_CHARS = 2000


def _as_naive_datetime(value: Optional[datetime]) -> Optional[datetime]:
    """openpyxl refuses a timezone-aware datetime outright; keep the wall-clock value, drop the tzinfo."""
    if value is None or value.tzinfo is None:
        return value
    return value.replace(tzinfo=None)


def _format_details(details: Optional[dict[str, Any]]) -> str:
    """
    One cell's worth of `details_json`.

    Compact JSON rather than a pretty-printed block: a spreadsheet cell
    renders newlines as one tall row that pushes every other row off the
    screen, and the payloads here are a handful of keys, which reads
    fine on one line. `ensure_ascii=False` so a name with an accent in
    it survives as itself rather than as `\\u00e9`.
    """
    if not details:
        return ""
    try:
        text = json.dumps(details, ensure_ascii=False, separators=(", ", ": "), default=str)
    except (TypeError, ValueError):
        # `default=str` handles almost everything, but a payload with a
        # circular reference would still raise — and an export must not
        # fail over one unprintable cell.
        logger.warning("Could not serialize log details for export; writing a placeholder")
        return "(unserializable)"
    if len(text) > MAX_DETAILS_CHARS:
        return f"{text[:MAX_DETAILS_CHARS]}… (truncated)"
    return text


def _row(entry: ApplicationLog) -> list[Any]:
    """One `ApplicationLog` -> one sheet row, in `HEADERS` order."""
    return [
        _as_naive_datetime(entry.created_at),
        entry.event_type.value,
        entry.event_category.value,
        # Empty rather than "None": a blank cell is how every other
        # column in this workbook spells "no value", and a literal
        # "None" in a filterable column becomes a filter option people
        # then have to reason about.
        entry.filename or "",
        entry.status.value,
        entry.message or "",
        entry.processing_time if entry.processing_time is not None else "",
        entry.batch_id or "",
        _format_details(entry.details_json),
    ]


def _chunked(entries: Iterable[ApplicationLog], size: int) -> Iterator[list[ApplicationLog]]:
    """Group an iterable into fixed-size lists, without assuming it supports slicing or has a length."""
    chunk: list[ApplicationLog] = []
    for entry in entries:
        chunk.append(entry)
        if len(chunk) >= size:
            yield chunk
            chunk = []
    if chunk:
        yield chunk


def _write_header(sheet: Worksheet) -> None:
    """
    Append the bold header row.

    A write-only sheet keeps no cells to style after the fact — each row
    is flushed the moment `append()` returns — so a styled cell has to be
    built with its style already on it (`WriteOnlyCell`), unlike a normal
    worksheet's `ws["A1"].font = ...`.
    """
    bold = Font(bold=True)
    cells = []
    for header in HEADERS:
        cell = WriteOnlyCell(sheet, value=header)
        cell.font = bold
        cells.append(cell)
    sheet.append(cells)


# Per-column widths, because the defaults make this particular sheet
# unusable: a timestamp column at Excel's default width shows `######`,
# and a message column at that width hides the one thing the row is for.
_COLUMN_WIDTHS = (22, 24, 16, 34, 12, 70, 18, 34, 60)


def write_logs_xlsx(entries: Iterable[ApplicationLog], destination: Path) -> int:
    """
    Stream `entries` into a `.xlsx` workbook at `destination`, returning
    the number of rows written (the header does not count).

    No pandas here, unlike the documents export. That module uses a
    `DataFrame` per chunk to reindex wildly varying row dicts onto one
    stable column list; these rows are built from fixed attributes in a
    fixed order, so there is nothing to reindex and a frame would be pure
    overhead — an import, an allocation and a `Timestamp`-to-`datetime`
    conversion per cell, to solve a problem this export does not have.
    """
    workbook = Workbook(write_only=True)
    sheet = workbook.create_sheet("Logs")
    _write_header(sheet)
    # Freezes the header row so it stays visible while scrolling — on a
    # nine-column sheet that is read by scanning downwards, this is the
    # difference between a usable export and one you have to keep
    # scrolling back up in.
    sheet.freeze_panes = "A2"
    for index, width in enumerate(_COLUMN_WIDTHS, start=1):
        sheet.column_dimensions[get_column_letter(index)].width = width

    row_count = 0
    for chunk in _chunked(entries, CHUNK_SIZE):
        for entry in chunk:
            sheet.append(_row(entry))
            row_count += 1

    workbook.save(destination)
    logger.info("Wrote %d log row(s) to xlsx export at %s", row_count, destination)
    return row_count
