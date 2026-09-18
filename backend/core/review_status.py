"""
Single source of truth for where a document sits in the human-review
workflow.

Mirrors `core.document_types.DocumentType`'s pattern: one enum shared by
the model column (`database/models.py`), the API contract
(`schemas/review.py`), and the persistence layer (`database/crud.py`),
so all three stay in sync by construction rather than by convention.

The workflow itself is deliberately two-state. A document is either
still showing raw AI output that nobody has signed off on
(`PENDING_REVIEW`, the state every row starts in at upload time), or a
human has looked at it and saved the field set they consider correct
(`REVIEWED`). "Reviewed" does not imply anything was actually changed —
a reviewer confirming the AI got everything right is just as much a
completed review as one who fixed four fields, and downstream consumers
asking "is this data human-verified yet?" get the same yes either way.
"""
from enum import Enum


class ReviewStatus(str, Enum):
    PENDING_REVIEW = "Pending Review"
    REVIEWED = "Reviewed"
