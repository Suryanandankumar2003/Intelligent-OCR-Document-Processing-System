"""
Timestamp helper shared by the response schemas.

SQLite has no timezone-aware type, so a `datetime` stored as UTC (and
`CURRENT_TIMESTAMP`, which is UTC) comes back naive, and serializes to an
ISO string with no offset — which any client that parses it, including
`new Date(...)` in a browser, reads as *local* time. That silently shifts
every timestamp the UI renders by the viewer's UTC offset. Stamping the
known timezone back on at the API boundary is what makes the value
unambiguous on the wire.

Lives in its own module because both `schemas/review.py` and
`schemas/document.py` need it, and a second copy of a four-line
correctness fix is exactly the kind of duplication that gets fixed in one
place and forgotten in the other.
"""
from datetime import datetime, timezone
from typing import Optional


def as_utc(value: Optional[datetime]) -> Optional[datetime]:
    """Label a naive timestamp read back from the database as UTC."""
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)
