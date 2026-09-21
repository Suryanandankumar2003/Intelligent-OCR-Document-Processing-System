"""
Aggregates every route module under a single APIRouter so `app.py` only
has to include one object. New feature routers (e.g. documents, ocr)
get registered here, not in app.py.
"""
from fastapi import APIRouter

from api.routes import (
    analytics,
    batches,
    classification,
    document_types,
    documents,
    export,
    extraction,
    health,
    logs,
    ocr,
    review,
    upload,
)

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(document_types.router)
api_router.include_router(upload.router)
api_router.include_router(ocr.router)
api_router.include_router(classification.router)
api_router.include_router(extraction.router)
api_router.include_router(review.router)
api_router.include_router(export.router)
api_router.include_router(analytics.router)
# Its own `/logs` prefix, so there is no collision to order around —
# the specific-before-generic ordering that matters for this router is
# internal to it (`/logs/analytics` before `/logs/{log_id}`), and is
# handled where those routes are declared.
api_router.include_router(logs.router)
# Registered before `documents.router` for the same reason `export` is:
# that router owns `/documents/{filename}` and would otherwise shadow a
# sibling path. Batches live under their own `/batches` prefix, so there
# is no collision today — the position simply keeps every
# specific-before-generic router together.
api_router.include_router(batches.router)
api_router.include_router(documents.router)
