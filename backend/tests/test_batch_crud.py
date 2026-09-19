"""
Unit tests for the persistence layer — the concurrency-critical half of
batch processing.

These cover the two pieces of `database/batch_crud.py` that everything
else depends on being correct: the claim that prevents a document from
being processed twice, and the progress recomputation that has to stay
right in the face of redelivery and retries.
"""
import threading

import pytest

from core.batch_status import BatchFileStatus, BatchStatus
from core.document_types import DocumentType
from database import batch_crud
from database.models import BatchFile
from database.session import SessionLocal


class TestCreateBatch:
    def test_creates_batch_and_files(self, db, batch_factory):
        batch = batch_factory(count=5, name="Invoices")

        assert batch.batch_name == "Invoices"
        assert batch.total_files == 5
        assert batch.status is BatchStatus.PENDING
        assert batch.processed_files == 0
        assert batch.progress_percentage == 0.0
        assert len(batch.files) == 5
        assert all(f.processing_status is BatchFileStatus.PENDING for f in batch.files)

    def test_batch_id_is_not_sequential(self, batch_factory):
        """Ids must not be guessable — a sequential id would let anyone enumerate every batch."""
        first, second = batch_factory(count=1), batch_factory(count=1)

        assert first.id != second.id
        assert len(first.id) == 32
        assert not first.id.isdigit()


class TestClaimBatchFile:
    def test_claim_moves_pending_to_processing(self, db, batch_factory):
        batch = batch_factory(count=1)
        file_id = batch.files[0].id

        claimed = batch_crud.claim_batch_file(db, file_id)

        assert claimed is not None
        assert claimed.processing_status is BatchFileStatus.PROCESSING
        assert claimed.started_at is not None

    def test_second_claim_returns_none(self, db, batch_factory):
        """
        The duplicate-processing guard. A redelivered Celery message must
        not start a second run of the same document.
        """
        batch = batch_factory(count=1)
        file_id = batch.files[0].id

        assert batch_crud.claim_batch_file(db, file_id) is not None
        assert batch_crud.claim_batch_file(db, file_id) is None

    def test_cannot_claim_a_succeeded_file(self, db, batch_factory):
        batch = batch_factory(count=1)
        file_id = batch.files[0].id
        batch_crud.claim_batch_file(db, file_id)
        batch_crud.mark_file_succeeded(
            db,
            file_id=file_id,
            document_id=None,
            document_type=DocumentType.INVOICE,
            processing_time_seconds=1.0,
        )

        assert batch_crud.claim_batch_file(db, file_id) is None

    def test_failed_file_can_be_reclaimed(self, db, batch_factory):
        """A failed file is retryable, so the claim must accept it — that is what a retry is."""
        batch = batch_factory(count=1)
        file_id = batch.files[0].id
        batch_crud.claim_batch_file(db, file_id)
        batch_crud.mark_file_failed(db, file_id=file_id, error_message="boom")

        assert batch_crud.claim_batch_file(db, file_id) is not None

    def test_concurrent_claims_admit_exactly_one(self, batch_factory):
        """
        Eight threads race for one file. Exactly one may win.

        This is the property the whole design rests on: with `acks_late`
        a task *will* be delivered twice, and if both deliveries could
        claim it the document would be OCR'd twice — paying twice and
        producing two sets of processing events.
        """
        batch = batch_factory(count=1)
        file_id = batch.files[0].id
        results: list[bool] = []
        lock = threading.Lock()

        def attempt():
            session = SessionLocal()
            try:
                claimed = batch_crud.claim_batch_file(session, file_id)
                with lock:
                    results.append(claimed is not None)
            finally:
                session.close()

        threads = [threading.Thread(target=attempt) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        assert sum(results) == 1, f"expected exactly one winner, got {sum(results)}"


class TestRecomputeProgress:
    def _finish(self, db, file, *, ok: bool):
        batch_crud.claim_batch_file(db, file.id)
        if ok:
            batch_crud.mark_file_succeeded(
                db,
                file_id=file.id,
                document_id=None,
                document_type=DocumentType.INVOICE,
                processing_time_seconds=1.0,
            )
        else:
            batch_crud.mark_file_failed(db, file_id=file.id, error_message="failed")

    def test_all_success_completes_the_batch(self, db, batch_factory):
        batch = batch_factory(count=4)
        for file in batch.files:
            self._finish(db, file, ok=True)

        updated = batch_crud.recompute_batch_progress(db, batch.id)

        assert updated.status is BatchStatus.COMPLETED
        assert (updated.processed_files, updated.successful_files, updated.failed_files) == (4, 4, 0)
        assert updated.progress_percentage == 100.0
        assert updated.completed_at is not None

    def test_all_failed_marks_the_batch_failed(self, db, batch_factory):
        batch = batch_factory(count=3)
        for file in batch.files:
            self._finish(db, file, ok=False)

        updated = batch_crud.recompute_batch_progress(db, batch.id)

        assert updated.status is BatchStatus.FAILED
        assert updated.failed_files == 3

    def test_mixed_outcome_is_partially_completed(self, db, batch_factory):
        """The most common real outcome, and the one a two-state enum would have to lie about."""
        batch = batch_factory(count=5)
        for index, file in enumerate(batch.files):
            self._finish(db, file, ok=index != 2)

        updated = batch_crud.recompute_batch_progress(db, batch.id)

        assert updated.status is BatchStatus.PARTIALLY_COMPLETED
        assert (updated.successful_files, updated.failed_files) == (4, 1)
        assert updated.progress_percentage == 100.0

    def test_partial_progress_reports_processing(self, db, batch_factory):
        batch = batch_factory(count=4)
        self._finish(db, batch.files[0], ok=True)

        updated = batch_crud.recompute_batch_progress(db, batch.id)

        assert updated.status is BatchStatus.PROCESSING
        assert updated.progress_percentage == 25.0
        assert updated.completed_at is None

    def test_recompute_is_idempotent(self, db, batch_factory):
        """
        The reason progress is recomputed rather than incremented:
        running it repeatedly must converge, not accumulate.
        """
        batch = batch_factory(count=3)
        for file in batch.files:
            self._finish(db, file, ok=True)

        first = batch_crud.recompute_batch_progress(db, batch.id)
        snapshot = (first.processed_files, first.successful_files, first.progress_percentage)
        for _ in range(5):
            batch_crud.recompute_batch_progress(db, batch.id)
        again = batch_crud.recompute_batch_progress(db, batch.id)

        assert (again.processed_files, again.successful_files, again.progress_percentage) == snapshot

    def test_completed_at_clears_when_a_batch_reopens(self, db, batch_factory):
        """A retried batch must not keep claiming it finished before its newest file ran."""
        batch = batch_factory(count=2)
        for file in batch.files:
            self._finish(db, file, ok=False)
        finished = batch_crud.recompute_batch_progress(db, batch.id)
        assert finished.completed_at is not None

        batch_crud.reset_files_for_retry(db, [batch.files[0].id], max_retries=5)
        reopened = batch_crud.recompute_batch_progress(db, batch.id)

        assert reopened.status is BatchStatus.PROCESSING
        assert reopened.completed_at is None


class TestRetries:
    def test_reset_only_touches_failed_files(self, db, batch_factory):
        batch = batch_factory(count=3)
        failed, succeeded, pending = batch.files
        batch_crud.claim_batch_file(db, failed.id)
        batch_crud.mark_file_failed(db, file_id=failed.id, error_message="x")
        batch_crud.claim_batch_file(db, succeeded.id)
        batch_crud.mark_file_succeeded(
            db, file_id=succeeded.id, document_id=None, document_type=None, processing_time_seconds=1.0
        )

        reset = batch_crud.reset_files_for_retry(
            db, [failed.id, succeeded.id, pending.id], max_retries=5
        )

        assert reset == [failed.id]

    def test_retry_count_increments_and_caps(self, db, batch_factory):
        """
        The cap is enforced in the database, so two operators clicking
        Retry at the same moment cannot push a file past it.
        """
        batch = batch_factory(count=1)
        file_id = batch.files[0].id

        for expected in (1, 2):
            batch_crud.claim_batch_file(db, file_id)
            batch_crud.mark_file_failed(db, file_id=file_id, error_message="x")
            assert batch_crud.reset_files_for_retry(db, [file_id], max_retries=2) == [file_id]
            assert db.get(BatchFile, file_id).retry_count == expected

        batch_crud.claim_batch_file(db, file_id)
        batch_crud.mark_file_failed(db, file_id=file_id, error_message="x")

        assert batch_crud.reset_files_for_retry(db, [file_id], max_retries=2) == []

    def test_reset_clears_the_previous_error(self, db, batch_factory):
        batch = batch_factory(count=1)
        file_id = batch.files[0].id
        batch_crud.claim_batch_file(db, file_id)
        batch_crud.mark_file_failed(db, file_id=file_id, error_message="Unreadable scan")

        batch_crud.reset_files_for_retry(db, [file_id], max_retries=5)

        refreshed = db.get(BatchFile, file_id)
        assert refreshed.error_message is None
        assert refreshed.processing_status is BatchFileStatus.PENDING

    def test_release_stale_processing_does_not_charge_a_retry(self, db, batch_factory):
        """
        A file stranded by a killed worker never failed, so the lost
        attempt must not come out of its retry budget.
        """
        batch = batch_factory(count=1)
        file_id = batch.files[0].id
        batch_crud.claim_batch_file(db, file_id)

        stale = batch_crud.stale_processing_file_ids(db, batch.id)
        assert stale == [file_id]
        assert batch_crud.release_stale_processing(db, stale) == 1

        refreshed = db.get(BatchFile, file_id)
        assert refreshed.processing_status is BatchFileStatus.PENDING
        assert refreshed.retry_count == 0


class TestQueries:
    def test_list_batches_filters_and_counts(self, db, batch_factory):
        batch_factory(count=1, name="Invoices March")
        batch_factory(count=1, name="Invoices April")
        batch_factory(count=1, name="Prescriptions")

        page, total = batch_crud.list_batches(db, skip=0, limit=10, search="invoices")

        assert total == 2
        assert {b.batch_name for b in page} == {"Invoices March", "Invoices April"}

    def test_list_batches_pagination_is_stable(self, db, batch_factory):
        """
        Batches created in the same second share a `created_at` at
        SQLite's resolution; without the id tiebreaker the sort is
        unstable and a paginated list repeats or skips rows.
        """
        for index in range(6):
            batch_factory(count=1, name=f"Batch {index}")

        first, _ = batch_crud.list_batches(db, skip=0, limit=3)
        second, _ = batch_crud.list_batches(db, skip=3, limit=3)

        assert len({b.id for b in first} & {b.id for b in second}) == 0

    def test_status_counts_include_zeroes(self, db, batch_factory):
        """The summary cards need "0 processing" to render as a zero, not a missing card."""
        batch = batch_factory(count=2)

        counts = batch_crud.batch_file_status_counts(db, batch.id)

        assert set(counts) == set(BatchFileStatus)
        assert counts[BatchFileStatus.PENDING] == 2
        assert counts[BatchFileStatus.SUCCESS] == 0

    def test_get_batch_file_is_scoped_to_its_batch(self, db, batch_factory):
        """`/batches/A/files/7` must not reach a file belonging to batch B."""
        batch_a, batch_b = batch_factory(count=1), batch_factory(count=1)
        file_in_b = batch_b.files[0].id

        assert batch_crud.get_batch_file(db, batch_id=batch_a.id, file_id=file_in_b) is None
        assert batch_crud.get_batch_file(db, batch_id=batch_b.id, file_id=file_in_b) is not None


class TestDelete:
    def test_deleting_a_batch_removes_its_files(self, db, batch_factory):
        batch = batch_factory(count=3)
        batch_id = batch.id

        batch_crud.delete_batch(db, batch)

        assert batch_crud.get_batch(db, batch_id) is None
        files, total = batch_crud.list_batch_files(db, batch_id=batch_id)
        assert total == 0
