"""
Which document types can actually be field-extracted.

Exists for the manual-classification control on the frontend: when the
classifier answers `Unknown`, a human picks the type themselves, and the
list they choose from has to be exactly the set extraction has a field
schema for. Hardcoding that list in the frontend is what would make it
possible to offer a type the backend then rejects with a 422 — the very
failure this endpoint's caller is trying to avoid — so the set is served
from `EXTRACTION_MODEL_BY_TYPE`, the same mapping extraction itself
checks.

`DocumentType.UNKNOWN` is absent by construction rather than by a filter:
it has no entry in that mapping, which is precisely what "not
extractable" means here.
"""
from fastapi import APIRouter

from core.document_types import DocumentType
from services.extraction_service import EXTRACTION_MODEL_BY_TYPE

router = APIRouter(tags=["Document Types"])


@router.get(
    "/document-types",
    response_model=list[DocumentType],
    summary="List the document types that support field extraction",
)
def list_extractable_document_types() -> list[DocumentType]:
    """Ordered by the `DocumentType` enum, so the list a client renders is stable between calls."""
    return [document_type for document_type in DocumentType if document_type in EXTRACTION_MODEL_BY_TYPE]
