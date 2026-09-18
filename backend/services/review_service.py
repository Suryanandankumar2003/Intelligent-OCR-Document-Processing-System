"""
Business logic for the human-review step: turning a reviewer's raw
corrections into (a) the validated field set to store and (b) the audit
records describing what changed.

Kept free of FastAPI and of any database writes, the same rule every
other module in `services/` follows: it takes a `Document` and a plain
dict and returns plain data, so the decision of *what* a correction
means is unit-testable without an HTTP request or a transaction. The
route layer (`api/routes/review.py`) is what hands the result to
`database.crud.save_review`.

--- Why corrections are validated, not trusted ---------------------------

A reviewer's input goes through the *same* Pydantic model that validated
the AI's extraction (`EXTRACTION_MODEL_BY_TYPE`), which means a typed
PAN number is format-checked, whitespace is trimmed, "N/A" folds to
`None`, and a prescription's medicines list is normalized — identically
in both directions. Without that, a corrected document could hold values
the extracted one could never have held, and every downstream consumer
would need two sets of assumptions about the same field.

--- What "original" means ------------------------------------------------

Every correction is recorded against `Document.extracted_data`, the
model's untouched first answer — never against whatever the previous
correction left behind. Correcting the same field three times therefore
produces three audit rows that all name the same original value, and the
question "how far is the final data from what the model produced?"
stays answerable by reading any one of them.

--- Strict where extraction is lenient -----------------------------------

`schemas/extraction.py` folds an unusable value (a malformed PAN, a
total with no digits) to `None` rather than raising, because one garbled
field shouldn't fail an otherwise-good extraction of noisy OCR text.
That trade-off is wrong for a human: a reviewer who types an invalid
value and gets "saved" back, with the field silently blanked, has been
told their correction landed when it didn't. So `_reject_discarded_values`
below turns exactly that case — a non-blank submitted value that
validation discarded — into an error naming the field.
"""
import logging
from typing import Any

from pydantic import ValidationError

from core.exceptions import ReviewValidationError
from database.models import Document
from services.extraction_service import EXTRACTION_MODEL_BY_TYPE

logger = logging.getLogger(__name__)


def _is_blank(value: Any) -> bool:
    """True for the values that mean "this field is empty" in any schema."""
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, list):
        return not [item for item in value if not _is_blank(item)]
    return False


def _reject_discarded_values(submitted: dict[str, Any], validated: dict[str, Any]) -> None:
    """Fail if the schema silently dropped a value the reviewer actually typed.

    Clearing a field on purpose is allowed — that's a blank submission
    surviving as a blank value. What isn't allowed is a non-blank
    submission coming out blank, which only happens when a validator
    judged it unusable.
    """
    for field_name, value in submitted.items():
        if field_name not in validated or _is_blank(value):
            continue
        if _is_blank(validated[field_name]):
            raise ReviewValidationError(
                f"'{field_name}' was given as {value!r}, which is not a valid value for this field."
            )


def apply_corrections(
    document: Document, corrected_fields: dict[str, Any]
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    Validate `corrected_fields` for `document` and work out what changed.

    Returns `(reviewed_data, correction_records)`:

      * `reviewed_data` — the complete, validated field set after the
        correction is applied: the same shape extraction produces, ready
        to store as `Document.reviewed_data`. Complete rather than
        partial, so a consumer reading that column never has to merge it
        against anything.
      * `correction_records` — one
        `{"field_name", "original_value", "corrected_value"}` dict per
        field this save actually changed, ready for
        `database.crud.save_review` to persist. `original_value` is
        always the model's original extraction, whatever the field was
        set to in between.

    Only fields named in `corrected_fields` are considered, and among
    those, only ones whose value actually moves. Re-submitting a field
    with the value it already holds is not a correction and produces no
    audit row, so a client that re-saves is safe to run twice. Setting a
    field back to what the model originally said *is* an event and is
    recorded — as a row whose original and corrected values coincide,
    which is precisely what "the reviewer undid this" looks like.

    Raises `ReviewValidationError` if the corrected values don't satisfy
    the document type's schema, or if one of them was discarded by it —
    `app.py` turns both into a 422.
    """
    model_cls = EXTRACTION_MODEL_BY_TYPE.get(document.document_type)
    if model_cls is None:
        # Only reachable for a document whose type has no field schema
        # (i.e. Unknown). Extraction refuses those outright, so such a
        # document can't have `extracted_data` to review in the first
        # place — but failing clearly beats a KeyError if that ever
        # stops being true.
        raise ReviewValidationError(
            f"no field schema is defined for document type '{document.document_type.value}'"
        )

    original_data = document.extracted_data or {}
    current_data = document.reviewed_data or original_data

    # Merge onto the *current* values, not the original ones: a second
    # review must not silently revert the first review's corrections to
    # the model's output just because this request didn't mention them.
    merged = {**current_data, **corrected_fields}

    try:
        validated = model_cls.model_validate(merged)
    except ValidationError as exc:
        raise ReviewValidationError(str(exc)) from exc

    reviewed_data = validated.model_dump(mode="json")
    _reject_discarded_values(corrected_fields, reviewed_data)

    correction_records = [
        {
            "field_name": field_name,
            "original_value": original_data.get(field_name),
            "corrected_value": reviewed_data[field_name],
        }
        # Iterating `corrected_fields` (not `reviewed_data`) is what
        # keeps untouched fields out of the audit trail; the membership
        # check drops any key that isn't part of this document type's
        # schema, since validation above would have discarded it anyway.
        for field_name in corrected_fields
        if field_name in reviewed_data and current_data.get(field_name) != reviewed_data[field_name]
    ]

    logger.info(
        "Applied %d correction(s) to %s (document_type=%s)",
        len(correction_records),
        document.filename,
        document.document_type.value,
    )

    return reviewed_data, correction_records
