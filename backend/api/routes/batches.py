"""
Batch-processing endpoints: bulk upload, status, per-file detail, retry,
and the live progress stream.

  POST   /batches/upload            create a batch from many files
  GET    /batches                   paged, filterable batch list
  GET    /batches/{id}              one batch plus its summary counts
  GET    /batches/{id}/files        paged, filterable file list
  GET    /batches/{id}/stream       Server-Sent Events progress feed
  POST   /batches/{id}/retry        retry every eligible failed file
  POST   /batches/{id}/files/{fid}/retry   retry one file
  DELETE /batches/{id}              delete a batch (not its documents)

Same layering as every other route module: this file does HTTP concerns
only. `services/batch_service.py` decides what a valid upload is,
`services/batch_dispatch.py` decides who executes it,
`database/batch_crud.py` decides how it is stored. None of the three
knows this module exists.

--- Why progress is Server-Sent Events --------------------------------

Three options, judged against this specific architecture:

* **Polling** works, needs nothing new, and is what the fallback below
  degrades to. Its cost is that every client asks every interval whether
  anything changed, and the answer is usually no — at a 2s interval a
  single open details page is 1,800 requests an hour, almost all of them
  wasted, and the operator still sees a completed batch up to 2s late.

* **WebSockets** would work and are the wrong tool. The traffic here is
  strictly one-directional: the server reports, the client never sends.
  Worse, the Celery worker is a *different process* from the API, so a
  worker cannot push into a socket the API holds — it would need a Redis
  pub/sub hop plus per-connection bookkeeping, which is real complexity
  bought for a feature that sends no client-to-server messages at all.

* **SSE** is one-directional by design, which is exactly the shape of
  this problem. It is plain HTTP, so it needs no new protocol, no
  handshake and no separate route class. `EventSource` reconnects
  automatically on a dropped connection — the thing that otherwise has
  to be hand-written for WebSockets. And critically it needs no
  worker-to-API channel: the API reads the batch's own row, which is
  where the worker already wrote the progress, so the existing database
  *is* the message bus.

SSE it is, with the generator below pushing only when something actually
changed. The frontend still carries a polling fallback
(`useBatchProgress`), because a proxy that buffers responses will break
SSE silently, and a progress bar that stops moving is worse than one
that updates every two seconds.
"""
import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from core.batch_status import ACTIVE_BATCH_STATUSES, BatchFileStatus, BatchStatus
from core.config import get_settings
from core.exceptions import BatchFileNotFoundError, BatchNotFoundError, NothingToRetryError
from core.log_events import LogEventType, LogStatus
from database import batch_crud
from database.models import Batch
from database.session import SessionLocal, get_db
from schemas.batch import (
    BatchCreatedResponse,
    BatchDetailResponse,
    BatchFileListResponse,
    BatchFileSummary,
    BatchListResponse,
    BatchSummary,
    RejectedFileInfo,
    RetryResponse,
)
from services import batch_dispatch
from services.batch_service import resolve_batch_name, stage_batch_files
from services.event_log import log_event

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/batches", tags=["Batches"])

# How often the SSE generator re-reads the batch row. Fast enough that a
# finished batch is reported as finished within a second, slow enough
# that one open page costs 3,600 indexed single-row reads an hour against
# a local SQLite file — which is nothing. Only *changed* state is written
# to the wire, so a quiet batch costs the poll and no bytes.
_STREAM_POLL_SECONDS = 1.0

# A stream is closed after this long regardless. A details page left open
# overnight on a batch whose worker died would otherwise hold a
# connection and a database session for ever; `EventSource` reconnects on
# its own, so the client simply gets a fresh stream.
_STREAM_MAX_SECONDS = 30 * 60


def _require_batch(db: Session, batch_id: str) -> Batch:
    """Load a batch or raise `BatchNotFoundError`, which `app.py` maps to a 404."""
    batch = batch_crud.get_batch(db, batch_id)
    if batch is None:
        raise BatchNotFoundError(batch_id)
    return batch


# --- Upload --------------------------------------------------------------


@router.post(
    "/upload",
    response_model=BatchCreatedResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Upload many documents as one batch and start processing them",
)
async def upload_batch(
    files: list[UploadFile] = File(..., description="PDF, PNG, or JPG files — up to MAX_BATCH_FILES per request"),
    batch_name: Optional[str] = Form(default=None, description="Optional label; defaults to a timestamp"),
    db: Session = Depends(get_db),
) -> BatchCreatedResponse:
    """
    Accept many files, store them, record the batch, and hand it to an
    executor.

    Returns as soon as the rows are committed and the work is queued —
    never when processing finishes. Processing hundreds of documents
    takes minutes to hours; holding the request open for it would time
    out at every layer between the browser and this function, and is the
    exact problem this endpoint exists to solve.

    Invalid files do not fail the request. Each one is reported in
    `rejected` with a reason and the rest are processed, because a 200
    file batch containing three `.docx` files is 197 good documents — see
    `services/batch_service.py`. The request fails only when nothing
    usable is left (`EmptyBatchError`) or the per-request cap is exceeded
    (`BatchTooLargeError`), both handled globally in `app.py`.

    The ordering below is load-bearing: files are written, then rows are
    committed, then work is dispatched. A worker can start the instant a
    message is published, and dispatching before the commit means a task
    looking up a row its own transaction cannot see yet — a race that
    only appears under load.
    """
    staged = await stage_batch_files(files)

    batch = batch_crud.create_batch(
        db,
        batch_name=resolve_batch_name(batch_name),
        files=staged.accepted,
    )

    executor = batch_dispatch.dispatch_batch(db, batch.id)
    db.refresh(batch)

    # Logged here rather than from `mark_batch_started`, which every
    # worker also calls: this is the one place a batch is created, so it
    # is the one place "this batch began" can be recorded exactly once
    # without a de-duplication check. The executor goes in the payload
    # because "why was this batch slow" is unanswerable without knowing
    # whether Celery or the in-process fallback ran it — the same reason
    # `batches.executor` is a stored column.
    log_event(
        db,
        event_type=LogEventType.BATCH_STARTED,
        status=LogStatus.STARTED,
        message=f"Batch '{batch.batch_name}' started with {batch.total_files} file(s).",
        batch_id=batch.id,
        details={
            "batch_name": batch.batch_name,
            "total_files": batch.total_files,
            "executor": executor,
            "rejected_count": len(staged.rejected),
            # The rejected names are the reason this payload is worth
            # keeping: they are the only record that those files were
            # ever offered, since nothing was stored for them and no
            # per-file row exists to carry the reason.
            "rejected": [
                {"original_filename": item.original_filename, "reason": item.reason}
                for item in staged.rejected
            ],
        },
    )

    return BatchCreatedResponse(
        batch_id=batch.id,
        batch_name=batch.batch_name,
        total_files=batch.total_files,
        status=batch.status,
        executor=executor,
        rejected=[
            RejectedFileInfo(original_filename=item.original_filename, reason=item.reason)
            for item in staged.rejected
        ],
    )


# --- Reads ---------------------------------------------------------------


@router.get("", response_model=BatchListResponse, summary="List batches, newest first")
def list_batches(
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=25, ge=1, le=200),
    status_filter: Optional[BatchStatus] = Query(
        default=None, alias="status", description="Only batches in this status"
    ),
    search: Optional[str] = Query(default=None, description="Case-insensitive match on batch name"),
    db: Session = Depends(get_db),
) -> BatchListResponse:
    """
    Server-side paging, filtering and searching — unlike `GET /documents`,
    which returns a page and lets the frontend filter in memory.

    That difference is deliberate and follows the data. The documents
    table is bounded by what one operator has processed and its filters
    (full-text over extracted values) have no SQL equivalent. Batches
    grow without bound, and every filter here — status, name — is a plain
    indexed predicate. Doing this one server-side costs less code, not
    more.
    """
    batches, total = batch_crud.list_batches(
        db, skip=skip, limit=limit, status=status_filter, search=search
    )
    return BatchListResponse(
        total=total,
        skip=skip,
        limit=limit,
        batches=[BatchSummary.model_validate(batch) for batch in batches],
    )


@router.get("/{batch_id}", response_model=BatchDetailResponse, summary="One batch with its summary counts")
def get_batch(batch_id: str, db: Session = Depends(get_db)) -> BatchDetailResponse:
    """
    The batch plus everything the details page's summary cards need, in
    one call rather than three.

    `status_counts` is not redundant with the batch's own counters: the
    cards show Processing and Pending as first-class numbers, and neither
    is derivable from processed/successful/failed — a file that is queued
    and one that is mid-flight are both simply "not processed".
    """
    batch = _require_batch(db, batch_id)
    return BatchDetailResponse(
        batch=BatchSummary.model_validate(batch),
        status_counts=batch_crud.batch_file_status_counts(db, batch_id),
        retryable_file_count=batch_crud.retryable_file_count(
            db, batch_id, max_retries=settings.MAX_FILE_RETRIES
        ),
        max_retries=settings.MAX_FILE_RETRIES,
    )


@router.get(
    "/{batch_id}/files",
    response_model=BatchFileListResponse,
    summary="The files in a batch, paged and filterable",
)
def list_batch_files(
    batch_id: str,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=500),
    status_filter: Optional[BatchFileStatus] = Query(default=None, alias="status"),
    search: Optional[str] = Query(default=None, description="Case-insensitive match on either filename"),
    db: Session = Depends(get_db),
) -> BatchFileListResponse:
    """
    Paged server-side, because a batch can hold 500 files and the common
    reason to open this page is to find the handful that failed — which
    is a `status=Failed` filter returning five rows, not a 500-row
    download the client then filters.
    """
    _require_batch(db, batch_id)
    files, total = batch_crud.list_batch_files(
        db, batch_id=batch_id, skip=skip, limit=limit, status=status_filter, search=search
    )
    return BatchFileListResponse(
        total=total,
        skip=skip,
        limit=limit,
        files=[BatchFileSummary.model_validate(file) for file in files],
    )


# --- Live progress (SSE) -------------------------------------------------


async def _progress_events(request: Request, batch_id: str):
    """
    Yield SSE frames for one batch until it reaches a terminal status.

    --- Its own session, closed per read ------------------------------

    This generator deliberately does not use the request's `get_db`
    session. That session is opened when the request starts and closed
    when it ends, and for a stream those are minutes or hours apart — it
    would hold a SQLite connection open for the whole time and, worse,
    serve stale data: a long-lived session's identity map would keep
    returning the batch as it looked when first read, while the worker
    writes new values in another connection. Opening and closing a short
    session per poll is what makes each read see committed truth.

    --- Only changes are sent ------------------------------------------

    The last payload is remembered and an identical one is not re-sent,
    so an idle batch costs the poll and no bytes. A comment line is sent
    instead on those ticks: it is ignored by `EventSource` but keeps the
    connection warm through proxies that close an idle one.

    --- Disconnects ----------------------------------------------------

    `request.is_disconnected()` is checked every tick. Without it a
    closed browser tab leaves this loop polling the database for the full
    30-minute cap, once per client that ever opened the page.
    """
    last_payload: Optional[str] = None
    elapsed = 0.0

    while elapsed < _STREAM_MAX_SECONDS:
        if await request.is_disconnected():
            logger.debug("SSE client disconnected from batch %s", batch_id)
            return

        db = SessionLocal()
        try:
            row = batch_crud.batch_summary_row(db, batch_id)
        finally:
            db.close()

        if row is None:
            # Deleted while being watched. Told explicitly rather than
            # left to time out, so the page can react instead of showing
            # a progress bar that never moves again.
            yield f"event: error\ndata: {json.dumps({'detail': 'Batch no longer exists.'})}\n\n"
            return

        batch_status, total, processed, successful, failed, percentage, _completed_at = row
        is_final = batch_status not in ACTIVE_BATCH_STATUSES

        payload = json.dumps(
            {
                "batch_id": batch_id,
                "status": batch_status.value,
                "total_files": total,
                "processed_files": processed,
                "successful_files": successful,
                "failed_files": failed,
                "progress_percentage": percentage,
                "is_final": is_final,
            }
        )

        if payload != last_payload:
            yield f"event: progress\ndata: {payload}\n\n"
            last_payload = payload
        else:
            # A comment frame. Ignored by EventSource, but it is traffic,
            # which is what stops an idle proxy from closing the stream.
            yield ": keep-alive\n\n"

        if is_final:
            # One `complete` frame so the client can stop, show a
            # notification, and refresh the file table — rather than
            # inferring completion from the stream going quiet.
            yield f"event: complete\ndata: {payload}\n\n"
            return

        await asyncio.sleep(_STREAM_POLL_SECONDS)
        elapsed += _STREAM_POLL_SECONDS

    # Hit the cap. Closing cleanly lets EventSource reconnect and start a
    # fresh stream, which is cheaper than holding one open indefinitely.
    yield f"event: timeout\ndata: {json.dumps({'batch_id': batch_id})}\n\n"


@router.get("/{batch_id}/stream", summary="Live batch progress as Server-Sent Events")
async def stream_batch_progress(batch_id: str, request: Request) -> StreamingResponse:
    """
    A `text/event-stream` of progress frames for one batch.

    Emits `progress` frames as the numbers change, a final `complete`
    frame when the batch reaches a terminal status, and `error` or
    `timeout` for the two ways a stream can end without that. See
    `_progress_events` and this module's docstring for why SSE rather
    than WebSockets or polling.

    Existence is checked before streaming starts, so a bad id is a clean
    404 rather than a 200 that immediately emits an error frame.
    """
    db = SessionLocal()
    try:
        if batch_crud.get_batch(db, batch_id) is None:
            raise BatchNotFoundError(batch_id)
    finally:
        db.close()

    return StreamingResponse(
        _progress_events(request, batch_id),
        media_type="text/event-stream",
        headers={
            # Without this, a proxy or the browser may cache the stream
            # and replay it rather than following it.
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # nginx buffers proxied responses by default, which holds
            # every frame until the stream ends — turning a live feed
            # into one delivery at the end. Ignored by servers that
            # don't proxy, harmless where it isn't needed.
            "X-Accel-Buffering": "no",
        },
    )


# --- Retries -------------------------------------------------------------


@router.post(
    "/{batch_id}/retry",
    response_model=RetryResponse,
    summary="Retry every failed file in a batch that has retries left",
)
def retry_batch(batch_id: str, db: Session = Depends(get_db)) -> RetryResponse:
    """
    Re-queue the batch's failed files, and release any file stranded in
    `Processing`.

    The stranded half is the part that is easy to leave out and painful
    to live without: a file whose worker died after claiming it but
    before recording an outcome will sit in `Processing` for ever,
    because the claim already succeeded and nothing will pick it up
    again. This is the only way to recover such a batch.

    Files that have exhausted `MAX_FILE_RETRIES` are skipped — the cap is
    enforced in the database, so two operators clicking Retry at the same
    moment cannot push a file past it. When nothing qualifies, this
    answers `NothingToRetryError` (409) rather than a success that
    queued nothing.
    """
    batch = _require_batch(db, batch_id)
    retried, executor = batch_dispatch.retry_batch(db, batch_id)

    if not retried:
        # Deliberately not logged. Nothing happened — the operator
        # clicked a button and the system declined — and an audit log
        # that records refused requests alongside real work makes the
        # real work harder to find. The 409 is the feedback here.
        raise NothingToRetryError(
            f"Nothing to retry in this batch — every failed file has reached the "
            f"{settings.MAX_FILE_RETRIES}-retry limit, or there are no failures."
        )

    # `RETRY_STARTED`, not completed: this endpoint queues work, it does
    # not wait for it. The files themselves log their own outcomes as
    # they run (see `worker/tasks.py`), and `RETRY_COMPLETED` is written
    # by whichever of them finishes the batch off — claiming completion
    # here would time the queueing, not the retry.
    log_event(
        db,
        event_type=LogEventType.RETRY_STARTED,
        status=LogStatus.STARTED,
        message=f"Re-queued {len(retried)} file(s) in batch '{batch.batch_name}'.",
        batch_id=batch_id,
        details={
            "batch_name": batch.batch_name,
            "retried_count": len(retried),
            "retried_file_ids": retried,
            "executor": executor,
            "scope": "batch",
        },
    )

    return RetryResponse(
        batch_id=batch_id,
        retried_file_ids=retried,
        retried_count=len(retried),
        executor=executor,
        message=f"Re-queued {len(retried)} file{'' if len(retried) == 1 else 's'}.",
    )


@router.post(
    "/{batch_id}/files/{file_id}/retry",
    response_model=RetryResponse,
    summary="Retry one failed file",
)
def retry_batch_file(batch_id: str, file_id: int, db: Session = Depends(get_db)) -> RetryResponse:
    """
    Re-queue a single file.

    The file is looked up scoped to its batch, so `/batches/A/files/7/retry`
    cannot act on a file belonging to batch B — an id-substitution bug
    that stays invisible until there are two batches.
    """
    _require_batch(db, batch_id)
    batch_file = batch_crud.get_batch_file(db, batch_id=batch_id, file_id=file_id)
    if batch_file is None:
        raise BatchFileNotFoundError(batch_id, file_id)

    retried, executor = batch_dispatch.retry_files(db, batch_id=batch_id, file_ids=[file_id])
    if not retried:
        raise NothingToRetryError(
            f"'{batch_file.original_filename}' cannot be retried — it is "
            f"{batch_file.processing_status.value.lower()}, or it has reached the "
            f"{settings.MAX_FILE_RETRIES}-retry limit."
        )

    log_event(
        db,
        event_type=LogEventType.RETRY_STARTED,
        status=LogStatus.STARTED,
        message=f"Re-queued '{batch_file.original_filename}' in batch {batch_id}.",
        batch_id=batch_id,
        filename=batch_file.filename,
        document_id=batch_file.document_id,
        document_type=batch_file.document_type,
        details={
            "original_filename": batch_file.original_filename,
            "batch_file_id": file_id,
            "retry_count": batch_file.retry_count,
            "executor": executor,
            "scope": "file",
        },
    )

    return RetryResponse(
        batch_id=batch_id,
        retried_file_ids=retried,
        retried_count=len(retried),
        executor=executor,
        message=f"Re-queued '{batch_file.original_filename}'.",
    )


# --- Delete --------------------------------------------------------------


@router.delete(
    "/{batch_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a batch record (the documents it produced are kept)",
)
def delete_batch(batch_id: str, db: Session = Depends(get_db)) -> None:
    """
    Removes the batch and its file rows.

    The `Document` rows the batch produced are deliberately kept, and so
    are the files on disk. A batch is a record of one processing run; the
    documents are the system's permanent record, still reviewable,
    searchable and exportable however they arrived. Deleting a month-old
    batch to tidy the list must not silently destroy the documents it
    produced — the same reasoning `DELETE /documents/{filename}` already
    applies in refusing to touch the filesystem.
    """
    batch = _require_batch(db, batch_id)

    # Read before the delete, not after: the row is gone by the time the
    # next line returns, and a log entry that could only say "a batch was
    # deleted" without saying which one or how big it was would be the
    # least useful entry in the table. This is also the *only* remaining
    # record that the batch existed, since its file rows cascade away
    # with it — the documents it produced survive, but nothing on them
    # says which run created them.
    deleted = {
        "batch_name": batch.batch_name,
        "status": batch.status.value,
        "total_files": batch.total_files,
        "successful_files": batch.successful_files,
        "failed_files": batch.failed_files,
        "executor": batch.executor,
    }

    batch_crud.delete_batch(db, batch)

    log_event(
        db,
        event_type=LogEventType.BATCH_DELETED,
        status=LogStatus.WARNING,
        message=f"Batch '{deleted['batch_name']}' deleted ({deleted['total_files']} file record(s)).",
        batch_id=batch_id,
        details=deleted,
    )
