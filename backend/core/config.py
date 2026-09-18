"""
Centralized application configuration.

All environment-dependent values (secrets, hosts, paths) are read here,
once, via pydantic-settings, and exposed through a single cached
`get_settings()` accessor so the rest of the app never touches
`os.environ` directly.
"""
from functools import lru_cache
from pathlib import Path
from typing import List, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    # --- General ---
    APP_NAME: str = "OCR Document Processing System"
    APP_VERSION: str = "0.1.0"
    ENVIRONMENT: str = "development"
    DEBUG: bool = True

    # --- API ---
    API_V1_PREFIX: str = "/api/v1"

    # --- CORS ---
    # Comma-separated list of allowed origins, e.g. "http://localhost:5173,http://localhost:3000"
    CORS_ORIGINS: str = "http://localhost:5173,http://localhost:3000"

    # --- Database ---
    DATABASE_URL: str = f"sqlite:///{BASE_DIR / 'database' / 'app.db'}"

    # --- Storage ---
    UPLOAD_DIR: Path = BASE_DIR / "uploads"
    MAX_UPLOAD_SIZE_MB: int = 10

    # --- Google Cloud / Vertex AI ---
    # The GCP project quota/billing is charged against, and the region
    # requests are sent to. Both are required for the Vertex AI SDK's
    # "enterprise"/vertexai mode (as opposed to a plain Gemini API key).
    GOOGLE_CLOUD_PROJECT: str = ""
    GOOGLE_CLOUD_LOCATION: str = "us-central1"
    # Path to a service account JSON key file (see README for where to
    # put this file and how to create one). May be relative (resolved
    # against BASE_DIR below) or absolute. Left empty, Application
    # Default Credentials falls back to `gcloud auth application-default
    # login`'s stored credentials or (in GCP-hosted environments) the
    # attached service account — see core/vertex_client.py.
    GOOGLE_APPLICATION_CREDENTIALS: str = ""

    VERTEX_OCR_MODEL: str = "gemini-2.5-flash"
    # Wall-clock budget for a single OCR call, in seconds.
    VERTEX_OCR_TIMEOUT_SECONDS: int = 120

    # --- Vertex AI: document classification ---
    VERTEX_CLASSIFICATION_MODEL: str = "gemini-2.5-flash"
    # Wall-clock budget for a single classification call, in seconds.
    VERTEX_CLASSIFICATION_TIMEOUT_SECONDS: int = 60
    # OCR text is truncated to this many characters before being sent to
    # Gemini: classification only needs enough text to recognize the
    # document type, and capping it bounds prompt cost/latency regardless
    # of how many pages the source document had.
    VERTEX_CLASSIFICATION_MAX_TEXT_CHARS: int = 8000

    # --- Vertex AI: structured field extraction ---
    VERTEX_EXTRACTION_MODEL: str = "gemini-2.5-flash"
    # Wall-clock budget for a single extraction call, in seconds.
    VERTEX_EXTRACTION_TIMEOUT_SECONDS: int = 60
    # Same rationale as VERTEX_CLASSIFICATION_MAX_TEXT_CHARS: bounds
    # prompt size/cost regardless of source document length.
    VERTEX_EXTRACTION_MAX_TEXT_CHARS: int = 8000

    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    @property
    def cors_origins_list(self) -> List[str]:
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]

    @property
    def google_application_credentials_path(self) -> Optional[Path]:
        """
        Resolves `GOOGLE_APPLICATION_CREDENTIALS` to an absolute `Path`,
        or `None` if it isn't set.

        A relative value (e.g. `credentials/gcp-service-account.json`,
        the README's recommended location) is resolved against
        `BASE_DIR` (`backend/`) rather than whatever the current working
        directory happens to be when the app starts — the same rule
        `UPLOAD_DIR` and `DATABASE_URL` already follow above.
        """
        if not self.GOOGLE_APPLICATION_CREDENTIALS:
            return None
        path = Path(self.GOOGLE_APPLICATION_CREDENTIALS)
        return path if path.is_absolute() else BASE_DIR / path


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance so the .env file is parsed only once."""
    return Settings()
