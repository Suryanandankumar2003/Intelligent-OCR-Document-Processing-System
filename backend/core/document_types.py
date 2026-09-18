"""
Single source of truth for which document types the classifier can
return.

Shared by `schemas/classification.py` (response validation),
`services/prompts/classification_prompt.py` (telling Vertex AI which
labels it is allowed to use), and `services/classification_service.py`
(validating Vertex AI's answer against that same set) — one enum, so all
three stay in sync by construction instead of by convention.
"""
from enum import Enum


class DocumentType(str, Enum):
    PAN_CARD = "PAN Card"
    AADHAAR_CARD = "Aadhaar Card"
    INVOICE = "Invoice"
    MEDICAL_PRESCRIPTION = "Medical Prescription"
    UNKNOWN = "Unknown"
