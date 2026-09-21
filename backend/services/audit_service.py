"""
Building a document's audit history: one chronological list of
everything a person has done to it.

--- Why this has to merge two tables ----------------------------------

Because the two halves of "what did the reviewer do" are stored
separately, and for good reasons that predate this module.

`field_corrections` holds *values that changed* — one append-only row
per field per save, each anchored to the model's original extraction so
"how far has this drifted from what the machine read" stays answerable
(see `services/review_service.py`). `application_logs` holds *decisions
somebody made* — a save happened, a document was approved, a document was
rejected — which have no field and no value and would have to be faked as
one to live in the corrections table.

Neither table should absorb the other. But a reviewer opening the Audit
History panel is not asking about either table; they are asking what has
happened to this document, and the answer interleaves the two. That
interleaving is this module's entire job, and it is business logic — what
counts as an audit entry, how each one reads, what order they go in —
which is why it is a service and not a query helper or a route.

--- Session-agnostic, like the rest of `services/` ---------------------

It takes ORM rows that somebody else loaded and returns plain
dictionaries. Nothing here calls back into a session, so a `Document`,
a `FieldCorrection` or an `ApplicationLog` handed to it is a read-only
data holder at that point — the same precedent `services/review_service.py`
and `services/export_service.py` already set.
"""
from typing import Any, Iterable, Optional

from core.log_events import LogEventType
from database.models import ApplicationLog, FieldCorrection

#: How each action event reads in the panel. A fixed sentence per event
#: rather than the log's own `message`, which is written for the Logs
#: screen and names the stored filename — information the reviewer
#: looking at that very document does not need repeated on every row.
_ACTION_SUMMARIES = {
    LogEventType.REVIEW_SAVED: "Corrections saved",
    LogEventType.DOCUMENT_APPROVED: "Document approved",
    LogEventType.DOCUMENT_REJECTED: "Document rejected",
}

#: The `details_json` key a review-save event stores its field list under.
#: Named once here and referenced from the review route, so the writer
#: and the reader cannot drift apart into a panel that silently stops
#: showing which fields a save touched.
CHANGED_FIELDS_KEY = "changed_fields"


def _format_value(value: Any) -> Any:
    """
    A field value as the panel should show it.

    A list (a prescription's `medicines`) is joined rather than rendered
    as an array, matching what `CorrectionHistory` on the frontend and
    the xlsx export already do — with `"; "` and not `", "`, because a
    single entry can itself contain a comma ("500mg, twice daily").
    Everything else is passed through untouched, including `None`, which
    the client renders as its own "not found" marker rather than having
    the string "None" invented for it here.
    """
    if isinstance(value, list):
        return "; ".join(str(item) for item in value if item not in (None, ""))
    return value


def _field_change_entry(correction: FieldCorrection) -> dict[str, Any]:
    """One `field_corrections` row as an audit entry."""
    return {
        "kind": "field_change",
        "occurred_at": correction.corrected_at,
        "event_type": None,
        "summary": f"'{correction.field_name}' changed",
        "field_name": correction.field_name,
        "original_value": _format_value(correction.original_value),
        "updated_value": _format_value(correction.corrected_value),
        "changed_fields": None,
    }


def _action_entry(entry: ApplicationLog) -> dict[str, Any]:
    """One review-action log row as an audit entry."""
    details = entry.details_json or {}
    changed = details.get(CHANGED_FIELDS_KEY)
    summary = _ACTION_SUMMARIES.get(entry.event_type, entry.event_type.value)

    # A save that changed nothing is possible (the endpoint refuses an
    # empty body, but every submitted value can normalize back to what
    # was already stored), and saying "3 fields" when the list is empty
    # would be a small lie in the one panel whose whole purpose is not
    # telling them.
    if changed:
        summary = f"{summary} ({len(changed)} field{'' if len(changed) == 1 else 's'})"

    return {
        "kind": "action",
        "occurred_at": entry.created_at,
        "event_type": entry.event_type,
        "summary": summary,
        "field_name": None,
        "original_value": None,
        "updated_value": None,
        "changed_fields": list(changed) if changed else None,
    }


def build_audit_history(
    corrections: Iterable[FieldCorrection],
    action_logs: Iterable[ApplicationLog],
    *,
    limit: Optional[int] = None,
) -> list[dict[str, Any]]:
    """
    Merge the two sources into one list, newest first.

    Newest first, deliberately the opposite of `crud.list_field_corrections`.
    That list is read as the story of how a value got where it is, which
    only makes sense forwards; this panel is opened to find out what
    happened *last*, and a reviewer who has to scroll to the bottom of
    forty entries to see the most recent one will stop opening it.

    Ties are broken by putting the action *after* the field changes it
    describes in chronological order — which, reversed, puts it above
    them. That is not cosmetic: a save writes its correction rows and its
    action row within the same few milliseconds, and on a timestamp
    resolution that coarse an arbitrary tie-break would scatter a save's
    own field changes above and below the line announcing it.

    `limit` caps the result for a panel that does not need a document's
    entire history on first render. It is applied after sorting, so what
    comes back is always the most recent `limit` entries and never an
    arbitrary slice.
    """
    entries = [_field_change_entry(correction) for correction in corrections]
    entries += [_action_entry(entry) for entry in action_logs]

    # `kind == "action"` sorts as 1 and `"field_change"` as 0, so an
    # action ranks after its own field changes before the reverse — see
    # the docstring.
    entries.sort(key=lambda item: (item["occurred_at"], item["kind"] == "action"), reverse=True)

    return entries[:limit] if limit is not None else entries
