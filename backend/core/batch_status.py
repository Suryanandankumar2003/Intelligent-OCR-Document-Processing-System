"""
Single source of truth for where a batch — and each file inside it —
sits in the asynchronous processing workflow.

Mirrors the pattern `core/document_types.py` and `core/review_status.py`
already established: one enum shared by the model column
(`database/models.py`), the API contract (`schemas/batch.py`), and the
persistence layer (`database/batch_crud.py`), so all three stay in sync
by construction rather than by convention.

--- Why two enums and not one -----------------------------------------

A batch and a file in it fail differently, and collapsing them would
lose the distinction the whole feature exists to make. A *file* either
worked or it didn't. A *batch* of 100 files where 3 failed is neither
"Completed" nor "Failed" — it is `PARTIALLY_COMPLETED`, and that is the
single most common real outcome once you process documents in bulk. A
shared enum would force that case to be spelled as a lie in one
direction or the other.

--- Terminal states ---------------------------------------------------

`BatchStatus.COMPLETED`, `FAILED` and `PARTIALLY_COMPLETED` are terminal
in the sense that no worker will advance them on its own — but they are
not frozen: retrying failed files moves a batch back to `PROCESSING`
(see `database/batch_crud.py:recompute_batch_progress`). `FAILED` means
every file failed, not that the batch is unrecoverable.
"""
from enum import Enum


class BatchStatus(str, Enum):
    PENDING = "Pending"
    PROCESSING = "Processing"
    COMPLETED = "Completed"
    FAILED = "Failed"
    PARTIALLY_COMPLETED = "Partially Completed"


class BatchFileStatus(str, Enum):
    PENDING = "Pending"
    PROCESSING = "Processing"
    SUCCESS = "Success"
    FAILED = "Failed"


# The states a file can be (re)queued from. A file that is PENDING was
# never picked up; one that FAILED can be retried. PROCESSING and SUCCESS
# are deliberately excluded — that exclusion is the compare-and-set guard
# that stops two workers from processing the same file twice (see
# `database/batch_crud.py:claim_batch_file`).
RETRYABLE_FILE_STATUSES = (BatchFileStatus.PENDING, BatchFileStatus.FAILED)

# Statuses that mean "this batch still has work in flight or waiting",
# used by the progress stream to decide when it can stop polling.
ACTIVE_BATCH_STATUSES = (BatchStatus.PENDING, BatchStatus.PROCESSING)
