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
import threading

from google import genai

from core.config import get_settings
from core.exceptions import VertexAIConfigurationError

settings = get_settings()


# One client per thread, not one per process.
#
# This used to be an `@lru_cache` singleton, which was correct while the
# only caller was FastAPI: every `async def` route runs on one event loop
# on one thread, so a single shared client meant a single shared
# connection pool, reused for the life of the process.
#
# Batch processing broke that assumption. Celery's threads pool (the only
# workable pool on Windows — see `worker/celery_app.py`) runs N worker
# threads, and `core/async_runner.py` gives each its own event loop.
# `client.aio` is backed by an `httpx.AsyncClient` whose connection pool
# binds to the loop that first used it, so one shared client handed to
# four threads means three of them driving a pool bound to someone else's
# loop — which fails intermittently under load rather than immediately.
#
# Per-thread costs one connection pool per worker thread, which is the
# correct number: a pool is exactly a per-loop resource. FastAPI is
# unaffected (its routes all run on one thread, so it still gets one
# client, built once).
_thread_state = threading.local()


def get_vertex_client() -> genai.Client:
    """
    Build (once per thread) and reuse the Vertex AI SDK client.

    Lazy, same rationale as every other `_get_client()` this app has
    had: the client — and the underlying HTTP connection pool it owns —
    is created on first actual call, not at import time, and reused
    after that instead of paying connection-setup cost per request.

    Raises `VertexAIConfigurationError` if `GOOGLE_CLOUD_PROJECT` is
    unset, or if `GOOGLE_APPLICATION_CREDENTIALS` is set but points at a
    file that doesn't exist — both are misconfiguration a caller can
    only fix by editing `.env`, never something worth retrying.
    """
    cached = getattr(_thread_state, "client", None)
    if cached is not None:
        return cached

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

    client = genai.Client(
        vertexai=True,
        project=settings.GOOGLE_CLOUD_PROJECT,
        location=settings.GOOGLE_CLOUD_LOCATION,
    )
    # Cached only after a successful build, so a misconfigured
    # environment keeps raising `VertexAIConfigurationError` on every
    # call instead of being remembered as a half-built client.
    _thread_state.client = client
    return client
