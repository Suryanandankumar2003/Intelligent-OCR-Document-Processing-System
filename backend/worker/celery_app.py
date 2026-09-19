"""
The Celery application: broker, backend, and the settings that make this
work on Windows.

Started with:

    celery -A worker.celery_app worker --pool=threads --concurrency=4 --loglevel=info

--- Windows: why the pool is threads ----------------------------------

Celery's default pool is `prefork`, which works by `fork()`ing the worker
process. Windows has no `fork()`. Celery 4 dropped official Windows
support for exactly this reason, and a prefork worker started on Windows
either refuses to start or — worse — starts and then fails on the first
task with a `PermissionError` or a pickling error deep inside billiard.

Two pools do work here:

* `--pool=solo` runs tasks one at a time on the main thread. Completely
  reliable, and completely serial: 500 files at ~8s each is over an hour.
  Concurrency then means running several worker *processes*.
* `--pool=threads` runs N tasks concurrently in one process. This is the
  default this project ships with, because every stage of the pipeline is
  a network round-trip to Vertex AI — the GIL is released for the whole
  duration of each call, so threads give genuine parallelism here even
  though they would not for CPU-bound work.

The threads pool has a consequence the rest of the code has to honour,
and does: N threads means N event loops and N HTTP connection pools. See
`core/async_runner.py` and `core/vertex_client.py`, both of which are
per-thread for this reason. Getting that wrong produces
`RuntimeError: Event loop is closed` under concurrency and nowhere else,
which is a genuinely unpleasant bug to find.

--- Windows: why `worker_pool_restarts` is off ------------------------

Remote pool restarts rely on process signalling that behaves differently
on Windows. It is off by default and stays off; a worker is restarted by
stopping and starting it.
"""
import logging
import os

from celery import Celery
from celery.signals import setup_logging, worker_process_init, worker_shutdown

from core.config import get_settings

settings = get_settings()

# The queue every batch task goes to. Named rather than left as
# "celery", so a future second workload (a nightly re-index, say) can be
# given its own queue and its own workers without competing with document
# processing for the same pool.
BATCH_QUEUE = "batch"

celery_app = Celery(
    "ocr_batch",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
    # Imported eagerly so the worker registers the tasks at startup.
    # Without this a task sent by the API is accepted by the broker and
    # then rejected by the worker as unregistered — a failure that looks
    # like a broker problem and isn't.
    include=["worker.tasks"],
)

celery_app.conf.update(
    # --- Serialization ---
    #
    # JSON only, never pickle. A broker that accepts pickled payloads
    # will execute arbitrary code from anything that can write to the
    # queue, and Redis here is unauthenticated on localhost. Task
    # arguments in this project are ints and strings, so JSON costs
    # nothing.
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_default_queue=BATCH_QUEUE,
    task_queues=None,
    # --- Reliability ---
    #
    # `acks_late` means a task is acknowledged after it finishes, not
    # when it is delivered — so a worker killed mid-file returns that
    # file to the queue instead of losing it. The cost is that a task can
    # be delivered twice, which is safe here only because
    # `batch_crud.claim_batch_file` is a compare-and-set: the second
    # delivery finds the row already claimed and stops. The two settings
    # are a pair; enabling this one without that guard would mean
    # double-OCR'ing documents on every worker restart.
    task_acks_late=True,
    # Do not acknowledge a task whose worker vanished — requeue it.
    task_reject_on_worker_lost=True,
    # --- Prefetch ---
    #
    # One unacknowledged task per thread. The default (4 per thread) lets
    # one worker reserve hundreds of files it has not started, which with
    # `acks_late` means a crash requeues all of them at once, and which
    # makes a second worker started mid-batch sit idle while the first
    # holds everything. For long tasks like these, prefetching buys
    # nothing and costs recovery time.
    worker_prefetch_multiplier=1,
    # --- Time limits ---
    #
    # Soft limit raises `SoftTimeLimitExceeded` inside the task, which
    # `worker/tasks.py` catches to mark the file FAILED with a real
    # message. The hard limit is the backstop for a task wedged somewhere
    # that cannot be interrupted.
    task_soft_time_limit=settings.BATCH_FILE_SOFT_TIME_LIMIT_SECONDS,
    task_time_limit=settings.BATCH_FILE_TIME_LIMIT_SECONDS,
    # --- Results ---
    #
    # Batch progress lives in the database, not in the result backend —
    # the frontend reads `batches`/`batch_files`, never a Celery result.
    # Results are kept only for an hour, purely for operational debugging
    # ("did this task run and what did it say"), so Redis does not
    # accumulate one key per file forever.
    result_expires=3600,
    task_ignore_result=False,
    # --- Broker connection ---
    #
    # Retry on startup so a worker launched before Redis does not exit
    # immediately, but cap the retries so a genuinely absent broker is
    # reported rather than retried silently for ever.
    broker_connection_retry_on_startup=True,
    broker_connection_max_retries=10,
    # Keeps a long-idle connection from being dropped by a firewall or by
    # Redis's own timeout, which on Windows is a common cause of a worker
    # that appears to stop consuming for no reason.
    broker_heartbeat=30,
    broker_transport_options={
        # How long a task may be reserved before the broker considers the
        # worker dead and redelivers it. Must exceed the hard time limit,
        # or a slow-but-healthy task gets redelivered while it is still
        # running — which the claim guard would survive, but only by
        # discarding work already done.
        "visibility_timeout": settings.BATCH_FILE_TIME_LIMIT_SECONDS + 60,
    },
    worker_pool_restarts=False,
    # Windows terminals are not always UTF-8; ASCII keeps the startup
    # banner from raising `UnicodeEncodeError` on a legacy code page.
    worker_redirect_stdouts_level="INFO",
)


@setup_logging.connect
def _configure_worker_logging(**_kwargs) -> None:
    """
    Use this application's logging configuration rather than Celery's.

    Celery replaces the root logger's handlers by default, which would
    silence every `logger.info` in `services/` and `database/` — the
    lines that actually say what happened to a document. Connecting to
    this signal without calling Celery's own setup is the documented way
    to keep ours.
    """
    logging.basicConfig(
        level=logging.DEBUG if settings.DEBUG else logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    )


@worker_process_init.connect
def _init_worker_process(**_kwargs) -> None:
    """
    Per-process setup.

    The database engine is created at import time by
    `database/session.py`, and SQLite connections must not be shared
    across processes. Disposing the pool here guarantees each worker
    process opens its own connections rather than inheriting any the
    parent may have made — harmless with the threads pool (there is only
    one process), and necessary the moment anyone runs several worker
    processes, which is the documented way to get concurrency with
    `--pool=solo`.
    """
    from database.session import engine

    engine.dispose()
    logger = logging.getLogger(__name__)
    logger.info("Worker process %s initialised", os.getpid())


@worker_shutdown.connect
def _shutdown_worker(**_kwargs) -> None:
    """Close the event loop this thread created, releasing any sockets still held open by the Vertex client."""
    from core.async_runner import shutdown_event_loop

    shutdown_event_loop()


def broker_is_reachable(timeout: float | None = None) -> bool:
    """
    Whether the broker can be connected to right now.

    Used by `services/batch_dispatch.py` to decide between queueing a
    batch and running it inline. Deliberately a real connection attempt
    rather than a ping of a cached connection: the question being asked
    is "will `send_task` work", and only an actual connect answers it.

    Never raises. Any failure — Redis down, wrong port, DNS, a firewall
    silently dropping the packet — is the same answer as far as the
    caller is concerned, and an unreachable broker must not turn an
    upload into a 500.
    """
    probe_timeout = timeout if timeout is not None else settings.BROKER_PROBE_TIMEOUT_SECONDS
    try:
        connection = celery_app.connection(transport_options={"max_retries": 0})
        connection.ensure_connection(max_retries=0, timeout=probe_timeout)
        connection.release()
        return True
    except Exception:  # noqa: BLE001 - every failure mode means the same thing here
        logging.getLogger(__name__).info(
            "Celery broker at %s is unreachable; batches will run inline",
            settings.celery_broker_url,
        )
        return False
