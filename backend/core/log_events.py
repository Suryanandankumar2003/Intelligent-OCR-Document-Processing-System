"""
The vocabulary of the application log: what happened, what kind of thing
it was, and how it turned out.

Mirrors the pattern `core/document_types.py`, `core/review_status.py`
and `core/batch_status.py` already establish — one set of enums shared by
the model column (`database/models.py:ApplicationLog`), the API contract
(`schemas/logs.py`), the write path (`services/event_log.py`) and the
query layer (`database/log_crud.py`), so all four stay in sync by
construction rather than by convention.

--- Why a category *and* a type ---------------------------------------

Because they answer different questions and collapsing them would lose
one of the answers. `LogCategory` is the dozen things this platform
*does* — uploads, OCR, extraction, batches, exports — and is what a
filter dropdown offers and what an analytics chart groups by. A category
has to stay a small, stable, readable list.

`LogEventType` is the specific moment inside one of those: OCR didn't
just happen, it *started* and later *completed*. That distinction is the
whole reason durations exist in this table, and it is also what makes a
started-with-no-completion visible as the signature of a process that
died mid-work.

A single enum would force one of the two to be spelled out in the other:
either a category list long enough to be useless as a filter, or an
event list too coarse to time anything.

--- Why the mapping is here and not at the call sites ------------------

`CATEGORY_BY_EVENT` below means a caller names the event and the category
follows. Left to call sites, "OCR Completed" would eventually be written
with category `System` somewhere, and the analytics breakdown would
quietly under-count OCR — a class of bug that is invisible until someone
notices a number is too low and has no way to tell when it started.
"""
from enum import Enum


class LogCategory(str, Enum):
    """The area of the platform an event belongs to."""

    UPLOAD = "Upload"
    OCR = "OCR"
    CLASSIFICATION = "Classification"
    EXTRACTION = "Extraction"
    REVIEW = "Review"
    APPROVAL = "Approval"
    REJECTION = "Rejection"
    BATCH = "Batch"
    RETRY = "Retry"
    EXPORT = "Export"
    ERROR = "Error"
    SYSTEM = "System"


class LogStatus(str, Enum):
    """
    How an event turned out.

    `STARTED` is a real outcome, not a placeholder: it is written before
    the work begins, so an operation that never returns still leaves a
    trace. A log that only records completions cannot distinguish "this
    never ran" from "this ran and died", which is the exact question
    asked of a stuck batch.
    """

    STARTED = "Started"
    SUCCESS = "Success"
    FAILURE = "Failure"
    WARNING = "Warning"


class LogEventType(str, Enum):
    """One specific moment worth recording."""

    # --- Upload ---
    UPLOAD_STARTED = "Upload Started"
    UPLOAD_COMPLETED = "Upload Completed"
    UPLOAD_REJECTED = "Upload Rejected"

    # --- Pipeline ---
    OCR_STARTED = "OCR Started"
    OCR_COMPLETED = "OCR Completed"
    OCR_FAILED = "OCR Failed"
    CLASSIFICATION_STARTED = "Classification Started"
    CLASSIFICATION_COMPLETED = "Classification Completed"
    CLASSIFICATION_FAILED = "Classification Failed"
    EXTRACTION_STARTED = "Extraction Started"
    EXTRACTION_COMPLETED = "Extraction Completed"
    EXTRACTION_FAILED = "Extraction Failed"

    # --- Human review ---
    REVIEW_OPENED = "Review Opened"
    REVIEW_SAVED = "Review Saved"
    DOCUMENT_APPROVED = "Document Approved"
    DOCUMENT_REJECTED = "Document Rejected"

    # --- Batch ---
    BATCH_STARTED = "Batch Started"
    BATCH_FILE_STARTED = "Batch File Started"
    BATCH_FILE_COMPLETED = "Batch File Completed"
    BATCH_FILE_FAILED = "Batch File Failed"
    BATCH_COMPLETED = "Batch Completed"
    BATCH_DELETED = "Batch Deleted"

    # --- Retry ---
    RETRY_STARTED = "Retry Started"
    RETRY_COMPLETED = "Retry Completed"

    # --- Export ---
    EXPORT_STARTED = "Export Started"
    EXPORT_COMPLETED = "Export Completed"

    # --- Catch-alls ---
    ERROR = "Error"
    SYSTEM_EVENT = "System Event"


#: The category each event belongs to. Exhaustive by assertion below, so
#: a new event type cannot be added without being placed.
CATEGORY_BY_EVENT: dict[LogEventType, LogCategory] = {
    LogEventType.UPLOAD_STARTED: LogCategory.UPLOAD,
    LogEventType.UPLOAD_COMPLETED: LogCategory.UPLOAD,
    LogEventType.UPLOAD_REJECTED: LogCategory.UPLOAD,
    LogEventType.OCR_STARTED: LogCategory.OCR,
    LogEventType.OCR_COMPLETED: LogCategory.OCR,
    LogEventType.OCR_FAILED: LogCategory.OCR,
    LogEventType.CLASSIFICATION_STARTED: LogCategory.CLASSIFICATION,
    LogEventType.CLASSIFICATION_COMPLETED: LogCategory.CLASSIFICATION,
    LogEventType.CLASSIFICATION_FAILED: LogCategory.CLASSIFICATION,
    LogEventType.EXTRACTION_STARTED: LogCategory.EXTRACTION,
    LogEventType.EXTRACTION_COMPLETED: LogCategory.EXTRACTION,
    LogEventType.EXTRACTION_FAILED: LogCategory.EXTRACTION,
    LogEventType.REVIEW_OPENED: LogCategory.REVIEW,
    LogEventType.REVIEW_SAVED: LogCategory.REVIEW,
    LogEventType.DOCUMENT_APPROVED: LogCategory.APPROVAL,
    LogEventType.DOCUMENT_REJECTED: LogCategory.REJECTION,
    LogEventType.BATCH_STARTED: LogCategory.BATCH,
    LogEventType.BATCH_FILE_STARTED: LogCategory.BATCH,
    LogEventType.BATCH_FILE_COMPLETED: LogCategory.BATCH,
    LogEventType.BATCH_FILE_FAILED: LogCategory.BATCH,
    LogEventType.BATCH_COMPLETED: LogCategory.BATCH,
    LogEventType.BATCH_DELETED: LogCategory.BATCH,
    LogEventType.RETRY_STARTED: LogCategory.RETRY,
    LogEventType.RETRY_COMPLETED: LogCategory.RETRY,
    LogEventType.EXPORT_STARTED: LogCategory.EXPORT,
    LogEventType.EXPORT_COMPLETED: LogCategory.EXPORT,
    LogEventType.ERROR: LogCategory.ERROR,
    LogEventType.SYSTEM_EVENT: LogCategory.SYSTEM,
}

# Placed at import time rather than trusted: a missing entry would
# otherwise surface as a `KeyError` on the one code path that logs that
# event, which in a best-effort logger is a path nobody exercises until
# production.
assert set(CATEGORY_BY_EVENT) == set(LogEventType), (
    "Every LogEventType needs a category in CATEGORY_BY_EVENT: "
    f"missing {set(LogEventType) - set(CATEGORY_BY_EVENT)}"
)


def category_for(event_type: LogEventType) -> LogCategory:
    """The category an event belongs to. See `CATEGORY_BY_EVENT`."""
    return CATEGORY_BY_EVENT[event_type]


#: Events that mean "something went wrong" by their nature, as opposed
#: to by their status.
#:
#: Both signals exist and they are not redundant. `LogStatus.FAILURE` is
#: the one a query filters on — it is on every failure row whatever the
#: event — while this set is what lets code ask "is this event type
#: inherently a failure" without inspecting a row. The two are kept
#: consistent by the rule that nothing in this set is ever written with
#: any other status.
ERROR_EVENT_TYPES = frozenset(
    {
        LogEventType.ERROR,
        LogEventType.OCR_FAILED,
        LogEventType.CLASSIFICATION_FAILED,
        LogEventType.EXTRACTION_FAILED,
        LogEventType.BATCH_FILE_FAILED,
        LogEventType.UPLOAD_REJECTED,
    }
)

#: Categories whose failures are worth calling out on their own card,
#: because they are the three places this platform actually breaks.
FAILURE_SPOTLIGHT_CATEGORIES = (
    LogCategory.OCR,
    LogCategory.EXTRACTION,
    LogCategory.BATCH,
)

#: The events that make up a document's audit history — the things a
#: *person* did to it, as opposed to the things the pipeline did.
#:
#: `REVIEW_OPENED` is deliberately absent. It is worth logging (it is how
#: you find out a document was looked at and left alone) but it is not a
#: change, and putting a "someone opened this" line between two real
#: actions would bury the trail under the noise of people scrolling past.
REVIEW_ACTION_EVENT_TYPES = (
    LogEventType.REVIEW_SAVED,
    LogEventType.DOCUMENT_APPROVED,
    LogEventType.DOCUMENT_REJECTED,
)

#: How a pipeline stage's start, success and failure are spelled, keyed
#: by the `core.processing_event.ProcessingStage` value the
#: instrumentation already carries.
#:
#: A stage failure gets its own event type rather than being spelled as
#: "OCR Completed, status Failure". Two reasons, and the second is the
#: load-bearing one: a row reading "Completed" next to "Failure" is a
#: contradiction a reader has to resolve every time they scan the table
#: — and, because a category is derived from the event type and nothing
#: else, filing a failure under a generic `ERROR` event would put it in
#: the `Error` category, where the OCR-failures and extraction-failures
#: cards (which group failures *by category*) would never find it.
#:
#: Keyed by the stage's *value* rather than by the enum member so this
#: module keeps importing nothing — `core/log_events.py` is a leaf, and
#: importing `ProcessingStage` here to use it as a key would couple two
#: vocabularies that are deliberately independent (a log event exists for
#: plenty of things that are not pipeline stages, and a stage is measured
#: whether or not anyone is logging).
STAGE_EVENT_TYPES: dict[str, tuple[LogEventType, LogEventType, LogEventType]] = {
    "OCR": (LogEventType.OCR_STARTED, LogEventType.OCR_COMPLETED, LogEventType.OCR_FAILED),
    "Classification": (
        LogEventType.CLASSIFICATION_STARTED,
        LogEventType.CLASSIFICATION_COMPLETED,
        LogEventType.CLASSIFICATION_FAILED,
    ),
    "Extraction": (
        LogEventType.EXTRACTION_STARTED,
        LogEventType.EXTRACTION_COMPLETED,
        LogEventType.EXTRACTION_FAILED,
    ),
}
