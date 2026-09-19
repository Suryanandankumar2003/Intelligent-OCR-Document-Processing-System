"""
Single source of truth for where a document sits in the human-review
workflow.

Mirrors `core.document_types.DocumentType`'s pattern: one enum shared by
the model column (`database/models.py`), the API contract
(`schemas/review.py`), and the persistence layer (`database/crud.py`),
so all three stay in sync by construction rather than by convention.

Every document starts in `PENDING_REVIEW` at upload time, and a human
moves it to exactly one of two terminal states:

* `REVIEWED` — a person has looked at it and signed off on the field set
  as it now stands. This does not imply anything was actually changed: a
  reviewer confirming the AI got everything right is just as much a
  completed review as one who fixed four fields, and downstream consumers
  asking "is this data human-verified yet?" get the same yes either way.
* `REJECTED` — a person has looked at it and judged the extraction
  unusable: the wrong document was uploaded, the scan is illegible, the
  fields are too wrong to be worth correcting by hand.

`REJECTED` is emphatically not "failed to process" — a failure never
reaches this enum at all (it leaves a `ProcessingEvent` row and the
document stays `PENDING_REVIEW`). It is a human verdict on data that
processed perfectly well, which is why it lives here alongside
`REVIEWED` rather than anywhere near the pipeline's error handling.

Both terminal states are reversible in the only sense that matters:
nothing is deleted. A rejected document keeps its extraction, its
transcript, and its correction history, so re-reviewing it later is a
status change and not a re-run.
"""
from enum import Enum


class ReviewStatus(str, Enum):
    PENDING_REVIEW = "Pending Review"
    REVIEWED = "Reviewed"
    REJECTED = "Rejected"
