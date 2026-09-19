"""
Pydantic schemas for the field-extraction API contract — one model per
supported document type, matching the exact field sets given in the
requirements.

Every scalar field is `Optional[str]`, defaulting to `None`. This is the
"handle missing values" mechanism for the whole feature: a field the
model couldn't find in the OCR text comes back as `None` (serialized as
JSON `null`), never an empty string, a placeholder like `"N/A"`, or a
raised exception. Consumers only ever need one check — `is None` — to
know a value is missing, instead of a list of placeholder strings to
guard against.

Validation happens in two layers, both via Pydantic `field_validator`s
so they run automatically on every model construction (there is no way
to get an un-validated instance of these models):

1. A `mode="before"` normalizer (`_normalize_optional_text` /
   `_normalize_medicines`) that trims whitespace and folds common
   "nothing here" placeholders a model might emit (e.g. "N/A", "null",
   "-") down to a real `None` / empty list.
2. A handful of `mode="after"` format checks (PAN number, Aadhaar
   number) that treat a value which doesn't match the expected shape as
   *effectively* missing rather than keeping obviously-garbled data —
   folding "invalid" into the same "missing" bucket the caller already
   has to handle, rather than adding a second failure mode.

These validators are deliberately lenient (fold-to-None, never raise):
OCR text is noisy by nature, and a single malformed field should not
fail an otherwise-successful extraction.
"""
import logging
import re
from typing import List, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

logger = logging.getLogger(__name__)

# Case-insensitive placeholders Vertex AI (or messy source text) might
# use in place of a genuinely missing value. Centralized here so every
# field across all four schemas treats "missing" identically.
_MISSING_VALUE_TOKENS = {
    "",
    "n/a",
    "na",
    "null",
    "none",
    "not found",
    "not available",
    "not mentioned",
    "unknown",
    "-",
    "--",
}

PAN_NUMBER_PATTERN = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")
AADHAAR_NUMBER_PATTERN = re.compile(r"^\d{12}$")


def _normalize_optional_text(value: object) -> Optional[str]:
    """Shared `mode="before"` normalizer for every optional scalar field.

    Applied identically across all four schemas so "missing" always
    means the same thing regardless of which document type is being
    extracted.
    """
    if value is None:
        return None
    text = str(value).strip()
    if text.lower() in _MISSING_VALUE_TOKENS:
        return None
    return text


class PANCardFields(BaseModel):
    """Fields extracted from an Indian PAN Card."""

    name: Optional[str] = Field(default=None, description="PAN card holder's full name")
    father_name: Optional[str] = Field(default=None, description="Father's name as printed on the card")
    dob: Optional[str] = Field(default=None, description="Date of birth as printed, e.g. DD/MM/YYYY")
    pan_number: Optional[str] = Field(default=None, description="10-character PAN, e.g. ABCDE1234F")

    @field_validator("name", "father_name", "dob", "pan_number", mode="before")
    @classmethod
    def _blank_to_none(cls, value: object) -> Optional[str]:
        return _normalize_optional_text(value)

    @field_validator("pan_number")
    @classmethod
    def _validate_pan_format(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        candidate = value.upper().replace(" ", "")
        if not PAN_NUMBER_PATTERN.match(candidate):
            logger.warning(
                "Extracted pan_number %r does not match the expected PAN format; treating as missing", value
            )
            return None
        return candidate


class AadhaarCardFields(BaseModel):
    """Fields extracted from an Indian Aadhaar Card."""

    name: Optional[str] = Field(default=None, description="Full name as printed on the Aadhaar card")
    dob: Optional[str] = Field(default=None, description="Date of birth as printed, e.g. DD/MM/YYYY")
    gender: Optional[str] = Field(default=None, description="Gender as printed, e.g. Male, Female, Other")
    aadhaar_number: Optional[str] = Field(default=None, description="12-digit Aadhaar number")

    @field_validator("name", "dob", "gender", "aadhaar_number", mode="before")
    @classmethod
    def _blank_to_none(cls, value: object) -> Optional[str]:
        return _normalize_optional_text(value)

    @field_validator("gender")
    @classmethod
    def _normalize_gender(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        # A light normalization, not a hard validation: common
        # abbreviations are expanded, but anything else printed on the
        # card (e.g. "Transgender") is kept verbatim rather than rejected.
        aliases = {"m": "Male", "f": "Female", "o": "Other", "t": "Transgender"}
        return aliases.get(value.strip().lower(), value)

    @field_validator("aadhaar_number")
    @classmethod
    def _validate_aadhaar_format(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        candidate = value.replace(" ", "").replace("-", "")
        if not AADHAAR_NUMBER_PATTERN.match(candidate):
            logger.warning(
                "Extracted aadhaar_number %r does not match the expected 12-digit format; treating as missing",
                value,
            )
            return None
        return candidate


class InvoiceFields(BaseModel):
    """Fields extracted from a commercial invoice."""

    invoice_number: Optional[str] = Field(default=None, description="Invoice/bill number")
    vendor_name: Optional[str] = Field(default=None, description="Name of the vendor/seller issuing the invoice")
    invoice_date: Optional[str] = Field(default=None, description="Date the invoice was issued, as printed")
    total_amount: Optional[str] = Field(
        default=None, description="Final total amount due, including currency symbol if printed"
    )

    @field_validator("invoice_number", "vendor_name", "invoice_date", "total_amount", mode="before")
    @classmethod
    def _blank_to_none(cls, value: object) -> Optional[str]:
        return _normalize_optional_text(value)

    @field_validator("total_amount")
    @classmethod
    def _validate_total_amount(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        # A "total amount" with no digits at all isn't a usable value
        # (e.g. the model echoed a currency symbol or a stray word) —
        # treated as missing rather than kept as unusable data.
        if not any(char.isdigit() for char in value):
            logger.warning("Extracted total_amount %r contains no digits; treating as missing", value)
            return None
        return value


class PrescriptionFields(BaseModel):
    """Fields extracted from a doctor's medical prescription."""

    patient_name: Optional[str] = Field(default=None, description="Patient's full name")
    doctor_name: Optional[str] = Field(default=None, description="Prescribing doctor's full name")
    date: Optional[str] = Field(default=None, description="Date the prescription was written, as printed")
    medicines: List[str] = Field(
        default_factory=list, description="Medicine names (with dosage/instructions if present)"
    )

    @field_validator("patient_name", "doctor_name", "date", mode="before")
    @classmethod
    def _blank_to_none(cls, value: object) -> Optional[str]:
        return _normalize_optional_text(value)

    @field_validator("medicines", mode="before")
    @classmethod
    def _normalize_medicines(cls, value: object) -> List[str]:
        """Missing medicines is represented as `[]`, not `None` — a list
        field's natural "nothing here" value is an empty list, so unlike
        the scalar fields above there is no need for an Optional wrapper.
        """
        if value is None:
            return []
        if isinstance(value, str):
            value = [value]
        normalized = []
        for item in value:
            cleaned = _normalize_optional_text(item)
            if cleaned:
                normalized.append(cleaned)
        return normalized


_TRF_DATETIME_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")


class TestReportFormFields(BaseModel):
    """Fields extracted from a laboratory Test Report Form (TRF).

    Field names intentionally match the exact keys given in the TRF
    extraction spec (`services/prompts/extraction_prompt.py`'s
    `_TEST_REPORT_FORM_PROMPT`) rather than this file's usual snake_case
    convention — this document type's output is meant to line up with an
    existing downstream contract, not with the other three schemas here.
    `Patient Name` is the one key that isn't a valid Python identifier,
    so it's modeled as `Patient_Name` with that exact string as its
    alias; `populate_by_name=True` lets it be constructed either way, and
    every `model_dump(by_alias=True)` call elsewhere in the app is what
    actually puts the space back on the wire and in storage.
    """

    model_config = ConfigDict(populate_by_name=True)

    Client_Code: Optional[str] = Field(default=None, description="Client code, from just above Client_Name")
    Client_Name: Optional[str] = Field(default=None, description="Client name printed at the top of the form")
    Patient_Name: Optional[str] = Field(default=None, alias="Patient Name", description="Patient's full name")
    AGE: Optional[str] = Field(default=None, description="Patient's age, digits only")
    Sex: Optional[str] = Field(default=None, description="Male/Female/whichever third option the form offers")
    Contact_Number: Optional[str] = Field(default=None, description="Patient's (not the doctor's) contact number")
    DOCTOR_NAME: Optional[str] = Field(default=None, description="Referring doctor's name, or 'Self'")
    TRF_Number: Optional[str] = Field(default=None, description="Digits-only TRF number from the barcode")
    TestName: Optional[str] = Field(default=None, description="Comma-separated list of ordered test names")
    TestCode: Optional[str] = Field(default=None, description="Comma-separated list of ordered test codes")
    SampleCollectionDateTime: Optional[str] = Field(
        default=None, description="Sample collection date/time, as YYYY-MM-DD HH:MM:SS"
    )
    SAMPLE_TYPE: Optional[str] = Field(default=None, description="Comma-separated Specimen Type selections")

    @field_validator(
        "Client_Code",
        "Client_Name",
        "Patient_Name",
        "AGE",
        "Sex",
        "Contact_Number",
        "DOCTOR_NAME",
        "TRF_Number",
        "TestName",
        "TestCode",
        "SampleCollectionDateTime",
        "SAMPLE_TYPE",
        mode="before",
    )
    @classmethod
    def _blank_to_none(cls, value: object) -> Optional[str]:
        # The TRF prompt asks Gemini for "" (not null) on a missing
        # field, unlike the other three schemas' JSON-schema-enforced
        # null — folding it to None here still keeps "missing" a single
        # concept for every consumer downstream of this model.
        return _normalize_optional_text(value)

    @field_validator("Client_Code")
    @classmethod
    def _clean_client_code(cls, value: Optional[str]) -> Optional[str]:
        """Drop mid-code dots and a leading '-', per the extraction spec's own examples."""
        if value is None:
            return None
        cleaned = value.replace(".", "").lstrip("-").strip()
        return cleaned or None

    @field_validator("TRF_Number")
    @classmethod
    def _clean_trf_number(cls, value: Optional[str]) -> Optional[str]:
        """Digits only — the barcode number never legitimately contains punctuation."""
        if value is None:
            return None
        cleaned = re.sub(r"[^0-9]", "", value)
        return cleaned or None

    @field_validator("AGE")
    @classmethod
    def _digits_only(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        digits = re.sub(r"\D", "", value)
        return digits or None

    @field_validator("SampleCollectionDateTime")
    @classmethod
    def _validate_datetime_format(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        if not _TRF_DATETIME_PATTERN.match(value):
            logger.warning(
                "Extracted SampleCollectionDateTime %r does not match YYYY-MM-DD HH:MM:SS; treating as missing",
                value,
            )
            return None
        return value


# A single alias for "one of the five extraction result shapes", used as
# the extraction service's return type and the API route's response
# model so FastAPI can validate/document it as a proper `oneOf` schema
# instead of an untyped dict.
ExtractedFields = Union[PANCardFields, AadhaarCardFields, InvoiceFields, PrescriptionFields, TestReportFormFields]
