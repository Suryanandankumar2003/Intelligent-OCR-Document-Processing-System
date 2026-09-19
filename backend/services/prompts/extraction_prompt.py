"""
Prompt templates and JSON Schema definitions for per-document-type
structured field extraction via Vertex AI's Gemini content generation
API.

Kept separate from `services/extraction_service.py`, same rationale as
`classification_prompt.py`: prompt/schema wording can be tuned without
touching request/response plumbing. This module has no dependency on
the `google-genai` package or FastAPI — it only builds plain dicts and
strings — so it can be imported and unit-tested in isolation.

--- "Structured extraction" ------------------------------------------

This uses Gemini's JSON-schema response mode (`response_mime_type=
"application/json"` plus `response_json_schema={...}`), which accepts
standard JSON Schema (a documented, explicit subset — see
`GenerateContentConfig.response_json_schema` in the `google-genai`
package) rather than the OpenAPI-flavored `response_schema` the SDK also
offers. It constrains the model to the exact property names and types
declared below, so a field that isn't present in the schema literally
cannot appear in the output, and every declared field is guaranteed
present (as its value or `null`) rather than sometimes-omitted. That is
what makes the four schemas below a reliable place to encode "handle
missing values": a nullable field is written as `"anyOf": [{"type":
"string"}, {"type": "null"}]` (the form Gemini's documented JSON Schema
subset explicitly supports — a bare `"type": ["string", "null"]` union
is not listed as supported) — the model is structurally required to
emit `null` rather than omit the key, so
`services/extraction_service.py` never has to guess whether a missing
key meant "not found" or "the model forgot to include it".
"""
from core.document_types import DocumentType

_BASE_INSTRUCTIONS = (
    "You are a field extraction engine for an OCR pipeline. You are given "
    "the raw OCR text of a single {document_type} and must extract a fixed "
    "set of fields from it, following the JSON schema you were given.\n\n"
    "Rules:\n"
    "- Extract values exactly as they appear in the text; do not guess, "
    "translate, or reformat them, unless a field's description says "
    "otherwise.\n"
    "- If a field is not present in the text, or you are not confident the "
    "value is correct, set it to null (or an empty array, for list "
    "fields) — never invent or hallucinate a value.\n"
    "- Respond with ONLY a single JSON object matching the schema. No "
    "markdown code fences, no commentary before or after it."
)

# Shorthand used by every nullable string field below, so each schema
# reads as "a string, or missing" without repeating the anyOf shape four
# times per schema. Deliberately a function (not a shared dict literal)
# so each field gets its own dict instance — schema dicts get mutated by
# some JSON Schema tooling, and sharing one instance across 16 field
# slots would make that mutation cross-contaminate unrelated fields.
def _nullable_string(description: str) -> dict:
    return {"description": description, "anyOf": [{"type": "string"}, {"type": "null"}]}


PAN_CARD_SCHEMA = {
    "type": "object",
    "properties": {
        "name": _nullable_string("Full name of the PAN card holder, exactly as printed"),
        "father_name": _nullable_string("Father's name as printed on the card"),
        "dob": _nullable_string("Date of birth as printed on the card, e.g. DD/MM/YYYY"),
        "pan_number": _nullable_string("10-character alphanumeric PAN, e.g. ABCDE1234F"),
    },
    "required": ["name", "father_name", "dob", "pan_number"],
    "additionalProperties": False,
}

AADHAAR_CARD_SCHEMA = {
    "type": "object",
    "properties": {
        "name": _nullable_string("Full name as printed on the Aadhaar card"),
        "dob": _nullable_string("Date of birth as printed, e.g. DD/MM/YYYY"),
        "gender": _nullable_string("Gender as printed, e.g. Male, Female, Other"),
        "aadhaar_number": _nullable_string("12-digit Aadhaar number, digits only or grouped in 4s"),
    },
    "required": ["name", "dob", "gender", "aadhaar_number"],
    "additionalProperties": False,
}

INVOICE_SCHEMA = {
    "type": "object",
    "properties": {
        "invoice_number": _nullable_string("Invoice/bill number"),
        "vendor_name": _nullable_string("Name of the vendor/seller issuing the invoice"),
        "invoice_date": _nullable_string("Date the invoice was issued, as printed"),
        "total_amount": _nullable_string("Final total amount due, including currency symbol if printed"),
    },
    "required": ["invoice_number", "vendor_name", "invoice_date", "total_amount"],
    "additionalProperties": False,
}

PRESCRIPTION_SCHEMA = {
    "type": "object",
    "properties": {
        "patient_name": _nullable_string("Patient's full name"),
        "doctor_name": _nullable_string("Prescribing doctor's full name"),
        "date": _nullable_string("Date the prescription was written, as printed"),
        "medicines": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Medicine names (with dosage/instructions if present); empty array if none found",
        },
    },
    "required": ["patient_name", "doctor_name", "date", "medicines"],
    "additionalProperties": False,
}

# Test Report Form fields are deliberately plain `{"type": "string"}`,
# not the nullable anyOf shape every other schema above uses: the TRF
# extraction prompt below tells the model to emit "" for a missing
# field (matching the exact contract it was given), not null.
# `schemas/extraction.py:TestReportFormFields` still folds a blank string
# to `None` on the way into our own models, so the rest of the app keeps
# treating "missing" as `None` everywhere — only the wire format Gemini
# is asked for here differs.
def _trf_string(description: str) -> dict:
    return {"description": description, "type": "string"}


TEST_REPORT_FORM_SCHEMA = {
    "type": "object",
    "properties": {
        "Client_Code": _trf_string("Client code printed at the top of the form, above Client_Name"),
        "Client_Name": _trf_string("Client name printed at the top of the form"),
        "Patient Name": _trf_string("Patient's full name"),
        "AGE": _trf_string("Patient's age, digits only"),
        "Sex": _trf_string("Male/Female/whichever third option the form itself offers"),
        "Contact_Number": _trf_string("Patient's (not the doctor's) contact number"),
        "DOCTOR_NAME": _trf_string("Referring doctor's name, or 'Self'"),
        "TRF_Number": _trf_string("Digits-only TRF number read from the barcode"),
        "TestName": _trf_string("Comma-separated list of ordered test names"),
        "TestCode": _trf_string("Comma-separated list of ordered test codes"),
        "SampleCollectionDateTime": _trf_string("Sample collection date/time as YYYY-MM-DD HH:MM:SS"),
        "SAMPLE_TYPE": _trf_string("Comma-separated Specimen Type selections, e.g. 'Serum,Plasma-Flouride'"),
    },
    "required": [
        "Client_Code",
        "Client_Name",
        "Patient Name",
        "AGE",
        "Sex",
        "Contact_Number",
        "DOCTOR_NAME",
        "TRF_Number",
        "TestName",
        "TestCode",
        "SampleCollectionDateTime",
        "SAMPLE_TYPE",
    ],
    "additionalProperties": False,
}

# json_schema per supported document type.
_SCHEMA_BY_TYPE: dict[DocumentType, dict] = {
    DocumentType.PAN_CARD: PAN_CARD_SCHEMA,
    DocumentType.AADHAAR_CARD: AADHAAR_CARD_SCHEMA,
    DocumentType.INVOICE: INVOICE_SCHEMA,
    DocumentType.MEDICAL_PRESCRIPTION: PRESCRIPTION_SCHEMA,
    DocumentType.TEST_REPORT_FORM: TEST_REPORT_FORM_SCHEMA,
}

# Test Report Form extraction follows a much more detailed, hand-tuned
# spec than the other three document types (client code cleanup rules,
# barcode digit-only normalization, multi-select Specimen Type handling,
# etc.) — verbatim rather than run through `_BASE_INSTRUCTIONS.format()`,
# because that generic template ("extract exactly as they appear ... set
# to null if missing") actively conflicts with several of the rules
# below (e.g. "" for missing, not null; strip punctuation from
# Client_Code/TRF_Number; fold near-miss OCR of "Self" back to "Self").
# `_CUSTOM_SYSTEM_PROMPTS` is checked first in `build_extraction_prompt`
# so a document type can opt out of the shared template entirely.
_TEST_REPORT_FORM_PROMPT = """You are given a document of a Test Report Form (TRF)
For date and time fields, convert them to "YYYY-MM-DD HH:MM:SS" format. If only a date is available, use "YYYY-MM-DD 00:00:00".
If the time for both collection or birth is written in AM or PM format convert it to 'HH:MM:SS' format

Return the result as a valid JSON object strictly following this structure:

Extraction Rules:
- Client_Code is present at the top of the from in case when extract the client code if there is any dot
  "." in the middel of the code it should be removed and Client_Code does not starts with "-" make sure
  if in case client code starts with "-" remove that like "Client_Code":"HEC 124.65" become "Client_Code":"HEC 12465"
  and "Client_Code":"-BCL-13539" becomes "BCL-13539"
- Client_Code is at the top just above Client_Name
- Extract Patient Name from the document
- Extract values only from fields that are filled or have a checked/ticked box next to them.
- Be precise with date/time
- Extract the SAMPLE_TYPE and Sex in from the document only.
- In Sex u have give json like this "Sex":"Male/Female/[3rd type from the form only]" here it means the
  1st and 2nd option are mostly male or female and the 3rd option whatever selection in done in the form like
  "Others" or "Transgender".
- Recheck AGE twice when extracting and extract only the number.
- Contact_Number should be Patient not the doctor's you can get that from document.
  If not present return "" like "Contact_Number": ""
- if in case no data is present for the respective field then the just return "" like if DOCTOR_NAME is
  not present then put "DOCTOR_NAME":""
- TRF_Number extract only the number present in the barcode on the document like number present in the
  barcode is "TRF 335252" then the output will be "TRF_Number":"335252".
- TRF_Number there should be no special character between it like if "TRF_Number":"335.252" becomes "TRF_Number":"335252"
  and  "TRF_Number":"3455-56" becomes "TRF_Number":"345556".
- DOCTOR_NAME extract this field from the Referring doctor name or wherever it is present.If DOCTOR_NAME starts with "S" and
  have 4 letters in it and is closer to "Self" then the value is "Self" like "DOCTOR_NAME": "Solf" should
  become "DOCTOR_NAME": "Self".
- SAMPLE_TYPE should be extract from the Specimen Type section present in the form.
  Specimen Type section is a checkbox section or written or marked and there can be various abnormality present in it like
  sticker to be present over the option, sticker to be present besides the option, various unnecessary
  pen marks to be present in the section which have no relation to the selection u should avoid those also,
  incase if the option is encircled then that means that option is selected.
- there can be multiple selection present in the Specimen Type section so according to those add them in the
  SAMPLE_TYPE like "SAMPLE_TYPE":"serum,Plasma-Flouride,WB-EDTA" , "SAMPLE_TYPE":"serum,other" incase there is no
  selection being made in the Specimen Type section then return "SAMPLE_TYPE":"".
- The TestName,TestCode are present but u see that its either handwriting or printed is bad in some case so according to your
  knowledge base make that fix like if "TestCode": "PRO792" for this test "TestName": "Amfit freedon promo"
  you find it wrong then u can fix that also "TestCode": "BRO792" and "TestName": "Ampit freedon promo"
- The TestName,TestCode can have multiple value so add them in this only like
  "TestCode": "PRO792, BC0683, MB004, BC0106, BC0120"
  and "TestName": "Amfit freedon promo, I run studies, urine culture & sensitivity, G. electrolytes, G-PCBS"
  note the TestCode can be empty so send "" like "TestCode": "".
- SampleCollectionDateTime should be extract from Specimen Collection section where Date Time field is present
  in the document.
- All the fields are present apply re-verifiation if any field is left blank.
- If in the Testname u can understand the exact data then it is fine but in case if exact data is hard to determine
  then according to your knowledge base fix that like "TestName":"Cretime" fix that to "TestName":"Creatine".
- In case any field is filled in a different language then extract that field in that same language no need to change
  the language to english or any other if field value is present int hindi,gujarati,punjabi or any language
  extract in that language only.
{
  "Client_Code":"field_value",
  "Client_Name": "field_value",
  "Patient Name": "field_value",
  "AGE": "field_value",
  "Sex":"Male/Female/[3rd type from the form only]",
  "Contact_Number": "field_value",
  "DOCTOR_NAME": "field_value",
  "TRF_Number": "field_value",
  "TestName": "field_value",
  "TestCode": "field_value",
  "SampleCollectionDateTime": "YYYY-MM-DD HH:MM:SS",
  "SAMPLE_TYPE": "name of the Specimen values",
}"""

_CUSTOM_SYSTEM_PROMPTS: dict[DocumentType, str] = {
    DocumentType.TEST_REPORT_FORM: _TEST_REPORT_FORM_PROMPT,
}


def get_extraction_schema(document_type: DocumentType) -> dict:
    """Return the JSON schema for a supported document type.

    Raises `KeyError` for `DocumentType.UNKNOWN` (or any type without a
    defined field set) — `services/extraction_service.py` catches that
    and translates it into `ExtractionUnsupportedDocumentTypeError`,
    keeping "which types are extractable" defined in exactly one place:
    the `_SCHEMA_BY_TYPE` map above.
    """
    return _SCHEMA_BY_TYPE[document_type]


def build_extraction_prompt(document_type: DocumentType, extracted_text: str) -> tuple[str, str]:
    """
    Build the (system_instruction, user_content) pair for a single
    extraction call.

    Returns plain strings, not SDK types, for the same reason as
    `classification_prompt.build_classification_prompt`: this module
    stays free of any dependency on the `google-genai` package.
    """
    system_instruction = _CUSTOM_SYSTEM_PROMPTS.get(
        document_type, _BASE_INSTRUCTIONS.format(document_type=document_type.value)
    )
    user_content = (
        f"Extract fields from the following {document_type.value} OCR text.\n\n"
        "--- OCR TEXT START ---\n"
        f"{extracted_text}\n"
        "--- OCR TEXT END ---"
    )
    return system_instruction, user_content
