"""
Custom exception hierarchy for the upload feature.

Services raise these instead of `HTTPException` so business logic stays
framework-agnostic (it doesn't need to know about HTTP status codes).
`app.py` maps each type to a status code in one place via
`register_exception_handlers`, keeping error-response shape consistent
across every endpoint that reuses these services.
"""


class DocumentUploadError(Exception):
    """Base class for every upload-related error."""


class UnsupportedFileTypeError(DocumentUploadError):
    """Raised when a file's content-type/extension isn't in the allow-list."""

    def __init__(self, content_type: str, filename: str) -> None:
        self.content_type = content_type
        self.filename = filename
        super().__init__(
            f"Unsupported file type '{content_type}' for file '{filename}'. "
            "Allowed types are: PDF, PNG, JPG, JPEG."
        )


class EmptyFileError(DocumentUploadError):
    """Raised when the uploaded file contains zero bytes."""

    def __init__(self, filename: str) -> None:
        self.filename = filename
        super().__init__(f"Uploaded file '{filename}' is empty.")


class FileTooLargeError(DocumentUploadError):
    """Raised when the uploaded file exceeds the configured size limit."""

    def __init__(self, filename: str, max_size_mb: int) -> None:
        self.filename = filename
        self.max_size_mb = max_size_mb
        super().__init__(
            f"File '{filename}' exceeds the maximum allowed size of {max_size_mb} MB."
        )


class FileSaveError(DocumentUploadError):
    """Raised when writing the file to disk fails for an environmental reason."""

    def __init__(self, filename: str) -> None:
        self.filename = filename
        super().__init__(f"Failed to save uploaded file '{filename}' due to a server error.")


# --- Vertex AI configuration error ---------------------------------------
#
# Shared by OCR, classification, and extraction (see
# core/vertex_client.py): all three now talk to Vertex AI through the
# same `genai.Client`, so "is the client even configured" is one fact,
# not three — unlike the per-feature XAuthenticationError/XRateLimitError/
# etc. below, which genuinely can differ per request even against a
# correctly-configured client. Deliberately not a subclass of OCRError /
# ClassificationError / ExtractionError: it isn't specific to any one of
# them, so `app.py` registers one handler for it, not three.


class VertexAIConfigurationError(Exception):
    """Raised when Vertex AI is invoked without a usable project/credentials setup."""

    def __init__(self) -> None:
        super().__init__(
            "Vertex AI is not configured: set GOOGLE_CLOUD_PROJECT and, if not "
            "using `gcloud auth application-default login`, GOOGLE_APPLICATION_CREDENTIALS "
            "in the environment (.env)."
        )


# --- OCR-specific errors -----------------------------------------------
#
# A parallel hierarchy, kept separate from `DocumentUploadError` because
# these represent failures of a *downstream dependency* (the Vertex AI
# API) rather than problems with the inbound HTTP request. That
# distinction is what drives the status codes `app.py` assigns them:
# mostly 5xx (something on our side or upstream broke), not 4xx.


class OCRError(Exception):
    """Base class for every OCR-related error."""


class OCRDocumentNotFoundError(OCRError):
    """Raised when the requested stored filename does not exist in uploads/."""

    def __init__(self, filename: str) -> None:
        self.filename = filename
        super().__init__(f"No uploaded document found for '{filename}'.")


class UnsupportedOCRFileTypeError(OCRError):
    """Raised when the stored file's extension isn't one OCR can be run on."""

    def __init__(self, filename: str) -> None:
        self.filename = filename
        super().__init__(
            f"File '{filename}' is not a supported type for OCR. "
            "Allowed types are: PDF, PNG, JPG, JPEG."
        )


class OCRAuthenticationError(OCRError):
    """Raised when Vertex AI rejects the request due to invalid/insufficient credentials."""

    def __init__(self) -> None:
        super().__init__(
            "Vertex AI rejected our credentials for OCR. Check GOOGLE_APPLICATION_CREDENTIALS "
            "and that the service account has the Vertex AI User role."
        )


class OCRRateLimitError(OCRError):
    """Raised when Vertex AI's API returns HTTP 429."""

    def __init__(self) -> None:
        super().__init__("Vertex AI OCR rate limit (quota) exceeded. Please retry shortly.")


class OCRTimeoutError(OCRError):
    """Raised when the Vertex AI API doesn't respond within the configured timeout."""

    def __init__(self, filename: str) -> None:
        self.filename = filename
        super().__init__(f"Timed out while waiting for OCR results for '{filename}'.")


class OCRProcessingError(OCRError):
    """Raised for any other failure reported by the Vertex AI API."""

    def __init__(self, filename: str, detail: str) -> None:
        self.filename = filename
        super().__init__(f"OCR processing failed for '{filename}': {detail}")


# --- Classification-specific errors -------------------------------------
#
# A third parallel hierarchy, same rationale as the OCR one above: these
# represent failures of a downstream dependency (Vertex AI's content
# generation API), not the inbound HTTP request, so `app.py` maps most
# of them to 5xx. `EmptyExtractedTextError` is the one 4xx exception —
# classifying zero text is genuinely the caller's mistake.


class ClassificationError(Exception):
    """Base class for every classification-related error."""


class EmptyExtractedTextError(ClassificationError):
    """Raised when there is no OCR text to classify."""

    def __init__(self) -> None:
        super().__init__("Cannot classify a document with no extracted text.")


class ClassificationAuthenticationError(ClassificationError):
    """Raised when Vertex AI rejects the request due to invalid/insufficient credentials."""

    def __init__(self) -> None:
        super().__init__(
            "Vertex AI rejected our credentials for classification. Check "
            "GOOGLE_APPLICATION_CREDENTIALS and IAM permissions."
        )


class ClassificationRateLimitError(ClassificationError):
    """Raised when Vertex AI's API returns HTTP 429."""

    def __init__(self) -> None:
        super().__init__("Vertex AI classification rate limit (quota) exceeded. Please retry shortly.")


class ClassificationTimeoutError(ClassificationError):
    """Raised when the Vertex AI API doesn't respond within the configured timeout."""

    def __init__(self) -> None:
        super().__init__("Timed out while waiting for a classification result.")


class ClassificationProcessingError(ClassificationError):
    """Raised for any other failure reported by the Vertex AI API."""

    def __init__(self, detail: str) -> None:
        super().__init__(f"Document classification failed: {detail}")


class ClassificationParsingError(ClassificationError):
    """Raised when Vertex AI's response isn't the JSON shape the prompt asked for."""

    def __init__(self, detail: str) -> None:
        super().__init__(f"Could not parse Vertex AI's classification response: {detail}")


# --- Database-specific errors ---------------------------------------------
#
# Raised by `database/crud.py` when a write fails for an environmental
# reason (disk full, DB file locked, a constraint violation that isn't
# the caller's fault to fix, etc). Kept as one generic error rather than
# a hierarchy like OCR/Classification/Extraction above: there is no
# equivalent need here to distinguish "auth failed" vs "rate limited" vs
# "timed out" — a local SQLite write either succeeds or it doesn't.


class DocumentPersistenceError(Exception):
    """Raised when a database write for a Document record fails."""

    def __init__(self, detail: str) -> None:
        super().__init__(f"Failed to save document record: {detail}")


# --- Field-extraction-specific errors ------------------------------------
#
# A fourth parallel hierarchy. `EmptyExtractedTextError` is deliberately
# *not* duplicated here — extraction and classification both operate on
# "OCR text that turned out to be blank", so they share that one
# exception type rather than each defining their own.


class ExtractionError(Exception):
    """Base class for every field-extraction-related error."""


class ExtractionUnsupportedDocumentTypeError(ExtractionError):
    """Raised when asked to extract fields for a document type with no defined schema (e.g. Unknown)."""

    def __init__(self, document_type) -> None:
        self.document_type = document_type
        label = getattr(document_type, "value", document_type)
        super().__init__(f"No field-extraction schema is defined for document type '{label}'.")


class ExtractionAuthenticationError(ExtractionError):
    """Raised when Vertex AI rejects the request due to invalid/insufficient credentials."""

    def __init__(self) -> None:
        super().__init__(
            "Vertex AI rejected our credentials for extraction. Check "
            "GOOGLE_APPLICATION_CREDENTIALS and IAM permissions."
        )


class ExtractionRateLimitError(ExtractionError):
    """Raised when Vertex AI's API returns HTTP 429."""

    def __init__(self) -> None:
        super().__init__("Vertex AI extraction rate limit (quota) exceeded. Please retry shortly.")


class ExtractionTimeoutError(ExtractionError):
    """Raised when the Vertex AI API doesn't respond within the configured timeout."""

    def __init__(self) -> None:
        super().__init__("Timed out while waiting for a field-extraction result.")


class ExtractionProcessingError(ExtractionError):
    """Raised for any other failure reported by the Vertex AI API."""

    def __init__(self, detail: str) -> None:
        super().__init__(f"Field extraction failed: {detail}")


class ExtractionParsingError(ExtractionError):
    """Raised when Vertex AI's response isn't valid JSON, or doesn't match the requested field schema."""

    def __init__(self, detail: str) -> None:
        super().__init__(f"Could not parse Vertex AI's extraction response: {detail}")


# --- Review/correction-specific errors -----------------------------------
#
# A fifth hierarchy, and the first one that has nothing to do with Vertex
# AI: saving a reviewer's corrections never calls the model. That's why
# both members below map to 4xx in `app.py` rather than the 5xx the
# OCR/classification/extraction families mostly use — a failed review is
# always the request being invalid or premature, never a downstream
# dependency breaking.


class ReviewError(Exception):
    """Base class for every document-review-related error."""


class DocumentNotYetExtractedError(ReviewError):
    """Raised when a review is attempted on a document that has never been field-extracted."""

    def __init__(self, filename: str) -> None:
        self.filename = filename
        super().__init__(
            f"Document '{filename}' has no extracted fields yet — run "
            f"POST /documents/{filename}/extract before reviewing it."
        )


class ReviewValidationError(ReviewError):
    """Raised when corrected values don't satisfy the document type's field schema."""

    def __init__(self, detail: str) -> None:
        super().__init__(f"Corrected fields are not valid for this document type: {detail}")
