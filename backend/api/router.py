"""
Aggregates every route module under a single APIRouter so `app.py` only
has to include one object. New feature routers (e.g. documents, ocr)
get registered here, not in app.py.
"""
from fastapi import APIRouter

from api.routes import analytics, classification, documents, export, extraction, health, ocr, review, upload

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(upload.router)
api_router.include_router(ocr.router)
api_router.include_router(classification.router)
api_router.include_router(extraction.router)
api_router.include_router(review.router)
api_router.include_router(export.router)
api_router.include_router(analytics.router)
api_router.include_router(documents.router)
