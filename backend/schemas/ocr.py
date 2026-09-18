"""Pydantic schema for the OCR API contract."""
from pydantic import BaseModel, Field


class OCRResultResponse(BaseModel):
    """Result of running OCR (Vertex AI/Gemini) on a previously uploaded document."""

    filename: str = Field(..., description="Stored filename that was processed")
    model: str = Field(..., description="Vertex AI (Gemini) model that processed the document")
    extracted_text: str = Field(..., description="Extracted/transcribed text")
    page_count: int = Field(..., description="Number of pages in the source document")
    processing_time_seconds: float = Field(
        ..., description="Wall-clock time spent waiting on the Vertex AI API"
    )
