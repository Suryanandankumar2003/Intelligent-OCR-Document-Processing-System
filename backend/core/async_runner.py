"""
Calling this project's `async def` services from synchronous code.

Every pipeline service — `ocr_service`, `classification_service`,
`extraction_service` — is `async def`, because each awaits a Vertex AI
call. FastAPI routes await them directly. Celery tasks cannot: a Celery
task is an ordinary synchronous function, so the worker needs a bridge.

--- Why not just `asyncio.run()` --------------------------------------

`asyncio.run()` creates a fresh event loop and **closes it** when the
coroutine finishes. That is fatal here, and not obviously so.

`google-genai`'s async surface (`client.aio`) is backed by an
`httpx.AsyncClient`, which binds its connection pool to whichever event
loop was running when it was first used. `core/vertex_client.py` caches
the client so the pool is reused rather than rebuilt per request — which
is the right thing for an API server and a live grenade for a worker
that calls `asyncio.run()` once per file: the second file gets a client
whose transport is bound to a loop that no longer exists, and fails with
`RuntimeError: Event loop is closed` — intermittently, under
concurrency, which is the worst way to find out.

So: one event loop per thread, created on first use and never closed for
the life of that thread. The cached client's transport stays bound to a
loop that stays alive. `core/vertex_client.py` caches per-thread for the
matching half of this contract — a single shared client would still be
wrong, because its pool would be bound to whichever thread happened to
touch it first.

--- Why threads at all ------------------------------------------------

Celery's default prefork pool does not work on Windows (see
`worker/celery_app.py`). The practical alternative is the threads pool,
and because every stage of this pipeline is a network round-trip to
Vertex AI rather than local computation, threads give real parallelism
despite the GIL — the interpreter lock is released while each request is
in flight.
"""
import asyncio
import logging
import threading
from typing import Any, Coroutine, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")

_thread_state = threading.local()


def get_event_loop() -> asyncio.AbstractEventLoop:
    """
    The calling thread's own event loop, created on first use.

    Never closed. A worker thread is long-lived — it processes file after
    file — so the loop it created is reused across every one of them,
    along with every connection pool bound to it.
    """
    loop = getattr(_thread_state, "loop", None)
    if loop is None or loop.is_closed():
        loop = asyncio.new_event_loop()
        # Registered as *this thread's* current loop as well, so any
        # library that reaches for `get_event_loop()` on its own (rather
        # than being handed one) finds the same object instead of
        # creating a second.
        asyncio.set_event_loop(loop)
        _thread_state.loop = loop
        logger.debug("Created event loop for thread %s", threading.current_thread().name)
    return loop


def run_async(coro: Coroutine[Any, Any, T]) -> T:
    """
    Run `coro` to completion on the calling thread's persistent loop and
    return its result, propagating any exception unchanged.

    The synchronous equivalent of `await coro`, for use from a Celery
    task or any other non-async caller.

    Raises `RuntimeError` if a loop is already running on this thread —
    that would mean this was called from inside async code, where the
    correct spelling is a plain `await` and where this call would
    deadlock rather than fail loudly.
    """
    loop = get_event_loop()
    if loop.is_running():
        raise RuntimeError(
            "run_async() was called from a thread whose event loop is already running. "
            "Await the coroutine directly instead."
        )
    return loop.run_until_complete(coro)


def shutdown_event_loop() -> None:
    """
    Close the calling thread's loop, for a worker thread that is being
    retired.

    Cancels whatever is still pending and lets async generators finish
    their `finally` blocks first (`shutdown_asyncgens`), so a partially
    consumed stream releases its socket instead of leaking it. Safe to
    call on a thread that never created a loop.
    """
    loop = getattr(_thread_state, "loop", None)
    if loop is None or loop.is_closed():
        return
    try:
        loop.run_until_complete(loop.shutdown_asyncgens())
    except Exception:  # noqa: BLE001 - shutdown must not raise over the real work's result
        logger.debug("Error shutting down async generators", exc_info=True)
    finally:
        loop.close()
        _thread_state.loop = None
