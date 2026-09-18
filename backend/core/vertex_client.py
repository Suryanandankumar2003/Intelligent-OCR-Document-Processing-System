"""
Shared Vertex AI (`google-genai`) client construction.

Unlike the three independent Mistral SDK clients this replaced (one
per feature, each its own connection pool, on the reasoning that "each
service should be free to evolve its own client configuration
independently"), OCR/classification/extraction now share exactly one
`genai.Client`: all three talk to the same GCP project through the same
credentials, so three separate clients would just be three copies of
identical configuration, with no independent axis left to justify
splitting them. `core/config.py`'s single-settings-source rule extends
naturally to "one client for the one provider," which is also why this
lives in `core/`, not `services/` — it's cross-cutting infrastructure
every AI-backed service depends on, not business logic itself.
"""
import os
from functools import lru_cache

from google import genai

from core.config import get_settings
from core.exceptions import VertexAIConfigurationError

settings = get_settings()


@lru_cache
def get_vertex_client() -> genai.Client:
    """
    Build (once) and reuse the Vertex AI SDK client.

    `lru_cache` makes this a lazy singleton, same rationale as every
    other `_get_client()` this app has had: the client — and the
    underlying HTTP connection pool it owns — is created on first actual
    call, not at import time, and reused after that instead of paying
    connection-setup cost per request.

    Raises `VertexAIConfigurationError` if `GOOGLE_CLOUD_PROJECT` is
    unset, or if `GOOGLE_APPLICATION_CREDENTIALS` is set but points at a
    file that doesn't exist — both are misconfiguration a caller can
    only fix by editing `.env`, never something worth retrying.
    """
    if not settings.GOOGLE_CLOUD_PROJECT:
        raise VertexAIConfigurationError()

    credentials_path = settings.google_application_credentials_path
    if credentials_path is not None:
        if not credentials_path.is_file():
            raise VertexAIConfigurationError()
        # google-auth's Application Default Credentials lookup
        # (`google.auth.default()`, called internally by genai.Client)
        # reads this environment variable directly — it is not
        # something the Client constructor accepts as a plain
        # argument, so pydantic-settings loading it from .env into
        # `settings` alone does not make it visible to google-auth.
        # This is the one place that gap gets bridged.
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(credentials_path)

    return genai.Client(
        vertexai=True,
        project=settings.GOOGLE_CLOUD_PROJECT,
        location=settings.GOOGLE_CLOUD_LOCATION,
    )
