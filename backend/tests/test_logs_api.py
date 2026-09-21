"""
Tests for the Logs module: what gets written, and what the endpoints do
with it.

Split in two on purpose. `TestLogWrites` asserts that real operations
leave the right trail — that is the half which breaks when somebody adds
a new code path and forgets to instrument it, and it is the only half
that can catch that. `TestLogQueries` and below assert the read side
against rows the test wrote directly, so a filter bug fails on the
filter rather than on whichever operation happened to produce the
fixture.

Every test here runs against the in-process inline executor and the
stubbed pipeline set up in `conftest.py`, so nothing below calls Vertex
AI or needs a broker.
"""
import time
from datetime import datetime, timedelta, timezone

import pytest

from core.document_types import DocumentType
from core.log_events import LogCategory, LogEventType, LogStatus
from database import log_crud
from database.models import ApplicationLog, Document


def _make_log(db, **overrides) -> ApplicationLog:
    """Insert one log row, defaulting everything the test does not care about."""
    from core.log_events import category_for

    event_type = overrides.pop("event_type", LogEventType.SYSTEM_EVENT)
    return log_crud.record_log(
        db,
        event_type=event_type,
        event_category=overrides.pop("event_category", category_for(event_type)),
        status=overrides.pop("status", LogStatus.SUCCESS),
        message=overrides.pop("message", "Something happened."),
        **overrides,
    )


def _event_types(payload) -> list[str]:
    return [entry["event_type"] for entry in payload["logs"]]


class TestLogWrites:
    """Real operations leave a trail."""

    def test_upload_logs_started_and_completed(self, client, make_upload, db):
        response = client.post("/api/v1/upload", files=[make_upload(field="file")])
        assert response.status_code == 201
        stored_name = response.json()["filename"]

        logs = client.get("/api/v1/logs", params={"filename": stored_name}).json()["logs"]
        by_type = {entry["event_type"]: entry for entry in logs}

        # The start row carries no stored filename — it is written before
        # one exists — so only the completion is addressable this way.
        assert LogEventType.UPLOAD_COMPLETED.value in by_type
        completed = by_type[LogEventType.UPLOAD_COMPLETED.value]
        assert completed["status"] == LogStatus.SUCCESS.value
        assert completed["event_category"] == LogCategory.UPLOAD.value
        assert completed["details_json"]["original_filename"] == "scan.pdf"
        assert completed["document_id"] is not None
        assert completed["processing_time"] is not None

        started = client.get(
            "/api/v1/logs", params={"event_type": LogEventType.UPLOAD_STARTED.value}
        ).json()
        assert started["total"] == 1
        assert started["logs"][0]["status"] == LogStatus.STARTED.value

    def test_rejected_upload_is_logged_with_the_reason(self, client, db):
        response = client.post(
            "/api/v1/upload",
            files=[("file", ("notes.txt", b"plain text", "text/plain"))],
        )
        assert response.status_code == 415

        rejected = client.get(
            "/api/v1/logs", params={"event_type": LogEventType.UPLOAD_REJECTED.value}
        ).json()
        assert rejected["total"] == 1
        entry = rejected["logs"][0]
        assert entry["status"] == LogStatus.FAILURE.value
        assert "notes.txt" in entry["message"]
        # The rejection row is the only evidence this upload ever
        # happened — nothing was stored and no document row exists.
        assert entry["details_json"]["content_type"] == "text/plain"

    def test_batch_run_logs_files_and_one_completion(self, client, make_upload, stub_pipeline):
        stub = stub_pipeline()
        response = client.post(
            "/api/v1/batches/upload",
            files=[make_upload(name=f"doc-{index}.pdf") for index in range(3)],
            data={"batch_name": "Logged batch"},
        )
        assert response.status_code == 201
        batch_id = response.json()["batch_id"]

        _wait_for(lambda: len(stub.calls) == 3)

        # Waits for the *log row*, not for the batch's status.
        #
        # The status flips inside `recompute_batch_progress` and the
        # completion row is written just after it returns, so a test that
        # waited on the status could read the log in the microseconds
        # between the two and find no completion row at all. That is a
        # race in the test, not in the code — nothing promises the two
        # writes are atomic, and nothing needs them to be — but it made
        # this test fail about one run in thirty.
        def completions() -> int:
            payload = client.get(
                "/api/v1/logs",
                params={"batch_id": batch_id, "event_type": LogEventType.BATCH_COMPLETED.value},
            ).json()
            return payload["total"]

        _wait_for(lambda: completions() >= 1)
        # By now every file has finished — a completion row is only
        # written once the batch is terminal — so a second one appearing
        # later is impossible and this count is final rather than
        # merely current.
        assert client.get(f"/api/v1/batches/{batch_id}").json()["batch"]["status"] == "Completed"

        logs = client.get(
            "/api/v1/logs", params={"batch_id": batch_id, "limit": 200, "sort_dir": "asc"}
        ).json()
        types = _event_types(logs)

        assert types.count(LogEventType.BATCH_STARTED.value) == 1
        assert types.count(LogEventType.BATCH_FILE_STARTED.value) == 3
        assert types.count(LogEventType.BATCH_FILE_COMPLETED.value) == 3
        # The guard that matters: every one of the three files calls
        # `recompute_batch_progress`, and the last one to finish sees a
        # terminal status. Exactly one completion row, not three.
        assert types.count(LogEventType.BATCH_COMPLETED.value) == 1

        completion = next(
            entry
            for entry in logs["logs"]
            if entry["event_type"] == LogEventType.BATCH_COMPLETED.value
        )
        assert completion["details_json"]["successful_files"] == 3
        assert completion["details_json"]["batch_name"] == "Logged batch"

    def test_failed_file_is_logged_without_failing_the_batch(
        self, client, batch_factory, stub_pipeline
    ):
        # Built through `batch_factory` rather than the upload endpoint,
        # because the stub keys on the *stored* filename and only this
        # route knows it before the files run.
        batch = batch_factory(count=2)
        doomed = batch.files[0].filename
        stub_pipeline(fail_for={doomed: "Unreadable scan"})

        _dispatch(batch.id)
        _wait_for(
            lambda: client.get(f"/api/v1/batches/{batch.id}").json()["batch"]["processed_files"] == 2
        )

        detail = client.get(f"/api/v1/batches/{batch.id}").json()["batch"]
        assert detail["failed_files"] == 1
        assert detail["successful_files"] == 1

        failures = client.get(
            "/api/v1/logs", params={"batch_id": batch.id, "status": LogStatus.FAILURE.value}
        ).json()
        assert failures["total"] == 1
        entry = failures["logs"][0]
        assert entry["event_type"] == LogEventType.BATCH_FILE_FAILED.value
        # The same sentence the file row carries, not a second wording
        # of the same failure.
        assert "Unreadable scan" in entry["message"]
        assert entry["details_json"]["attempt"] == 1

    def test_a_retry_closes_the_retry_loop(self, client, batch_factory, stub_pipeline):
        batch = batch_factory(count=1)
        stub_pipeline(fail_for={batch.files[0].filename: "Unreadable scan"})
        _dispatch(batch.id)
        _wait_for(
            lambda: client.get(f"/api/v1/batches/{batch.id}").json()["batch"]["failed_files"] == 1
        )

        stub_pipeline()  # succeeds this time
        assert client.post(f"/api/v1/batches/{batch.id}/retry").status_code == 200
        _wait_for(
            lambda: client.get(f"/api/v1/batches/{batch.id}").json()["batch"]["successful_files"] == 1
        )

        retries = client.get(
            "/api/v1/logs", params={"batch_id": batch.id, "event_category": LogCategory.RETRY.value}
        ).json()
        # A first attempt writes nothing to the Retry category; only a
        # genuine re-run does, which is what keeps it readable.
        assert {entry["event_type"] for entry in retries["logs"]} == {
            LogEventType.RETRY_STARTED.value,
            LogEventType.RETRY_COMPLETED.value,
        }
        completed = next(
            entry
            for entry in retries["logs"]
            if entry["event_type"] == LogEventType.RETRY_COMPLETED.value
        )
        assert completed["details_json"]["outcome"] == "Success"

    def test_batch_deletion_keeps_its_log_trail(self, client, make_upload, stub_pipeline):
        stub_pipeline()
        batch_id = client.post(
            "/api/v1/batches/upload", files=[make_upload()]
        ).json()["batch_id"]
        _wait_for(
            lambda: client.get(f"/api/v1/batches/{batch_id}").json()["batch"]["processed_files"] == 1
        )

        assert client.delete(f"/api/v1/batches/{batch_id}").status_code == 204

        logs = client.get("/api/v1/logs", params={"batch_id": batch_id, "limit": 200}).json()
        # The whole point of the log not having a foreign key: the batch
        # is gone and its story is not.
        assert logs["total"] > 0
        assert LogEventType.BATCH_DELETED.value in _event_types(logs)

    def test_export_records_its_row_count(self, client, make_upload, db):
        client.post("/api/v1/upload", files=[make_upload(field="file")])

        assert client.get("/api/v1/documents/export/xlsx").status_code == 200

        exports = client.get(
            "/api/v1/logs", params={"event_type": LogEventType.EXPORT_COMPLETED.value}
        ).json()
        assert exports["total"] == 1
        details = exports["logs"][0]["details_json"]
        assert details["row_count"] == 1
        assert details["format"] == "xlsx"
        # Free text the operator typed is recorded as a flag, never a
        # value — see `_loggable_filters`.
        assert details["filters"]["search_applied"] is False


class TestLogQueries:
    """Filtering, searching, sorting and paging, over rows written directly."""

    @pytest.fixture(autouse=True)
    def _seed(self, client, db):
        # `client` first, deliberately: building it starts the app, which
        # records its own `System Event`. Seeding before that would leave
        # these tests counting a row they did not write — and asserting
        # around it would mean every count here silently depended on how
        # many events startup happens to log.
        _clear_logs(db)
        _make_log(db, event_type=LogEventType.OCR_COMPLETED, filename="alpha.pdf", processing_time=1.0)
        _make_log(
            db,
            event_type=LogEventType.OCR_FAILED,
            status=LogStatus.FAILURE,
            filename="beta.pdf",
            message="OCR failed for 'beta.pdf': the service timed out.",
            processing_time=4.0,
        )
        _make_log(
            db,
            event_type=LogEventType.EXTRACTION_COMPLETED,
            filename="gamma.pdf",
            document_type=DocumentType.INVOICE,
            processing_time=2.0,
        )

    def test_lists_newest_first_with_a_total(self, client):
        payload = client.get("/api/v1/logs").json()
        assert payload["total"] == 3
        assert _event_types(payload)[0] == LogEventType.EXTRACTION_COMPLETED.value

    def test_filters_compose(self, client):
        assert client.get(
            "/api/v1/logs", params={"event_category": LogCategory.OCR.value}
        ).json()["total"] == 2
        assert client.get(
            "/api/v1/logs",
            params={"event_category": LogCategory.OCR.value, "status": LogStatus.FAILURE.value},
        ).json()["total"] == 1
        assert client.get(
            "/api/v1/logs", params={"document_type": DocumentType.INVOICE.value}
        ).json()["total"] == 1

    def test_search_matches_message_and_filename(self, client):
        assert client.get("/api/v1/logs", params={"search": "timed out"}).json()["total"] == 1
        assert client.get("/api/v1/logs", params={"search": "GAMMA"}).json()["total"] == 1
        # The dropdowns own the category and type vocabulary; the search
        # box deliberately does not duplicate them.
        assert client.get("/api/v1/logs", params={"search": "Extraction"}).json()["total"] == 0

    def test_sorts_on_a_whitelisted_column(self, client):
        ascending = client.get(
            "/api/v1/logs", params={"sort_by": "processing_time", "sort_dir": "asc"}
        ).json()
        assert [entry["processing_time"] for entry in ascending["logs"]] == [1.0, 2.0, 4.0]

    def test_unknown_sort_column_falls_back_rather_than_refusing(self, client):
        response = client.get("/api/v1/logs", params={"sort_by": "; DROP TABLE application_logs"})
        assert response.status_code == 200
        assert response.json()["total"] == 3

    def test_pages_without_losing_or_repeating_rows(self, client):
        first = client.get("/api/v1/logs", params={"limit": 2}).json()
        second = client.get("/api/v1/logs", params={"limit": 2, "skip": 2}).json()
        assert first["total"] == second["total"] == 3
        assert len(first["logs"]) == 2 and len(second["logs"]) == 1
        ids = [entry["id"] for entry in first["logs"] + second["logs"]]
        assert len(set(ids)) == 3

    def test_date_range_filter(self, client, db):
        tomorrow = datetime.now(timezone.utc) + timedelta(days=1)
        assert client.get(
            "/api/v1/logs", params={"date_from": tomorrow.isoformat()}
        ).json()["total"] == 0
        yesterday = datetime.now(timezone.utc) - timedelta(days=1)
        assert client.get(
            "/api/v1/logs", params={"date_from": yesterday.isoformat()}
        ).json()["total"] == 3

    def test_filter_options_offer_the_whole_vocabulary(self, client):
        options = client.get("/api/v1/logs/filters").json()
        # From the enums, not from what happens to be in the table — so
        # "Failure" is offered on a system where nothing has failed yet.
        assert LogStatus.WARNING.value in options["statuses"]
        assert len(options["event_types"]) == len(list(LogEventType))


class TestLogDetail:
    def test_unknown_id_is_a_404(self, client):
        assert client.get("/api/v1/logs/999999").status_code == 404

    def test_resolves_the_related_document(self, client, db):
        document = Document(filename="linked.pdf", uploaded_at=datetime.now(timezone.utc))
        db.add(document)
        db.commit()

        entry = _make_log(db, filename="linked.pdf", document_id=document.id)
        payload = client.get(f"/api/v1/logs/{entry.id}").json()

        assert payload["document_exists"] is True
        assert payload["document_review_status"] == "Pending Review"
        assert payload["batch_exists"] is False

    def test_survives_its_document_being_deleted(self, client, db):
        document = Document(filename="doomed.pdf", uploaded_at=datetime.now(timezone.utc))
        db.add(document)
        db.commit()
        entry = _make_log(db, filename="doomed.pdf", document_id=document.id)

        db.delete(document)
        db.commit()

        payload = client.get(f"/api/v1/logs/{entry.id}").json()
        # Not a 404: "the document this refers to has since been deleted"
        # is a fact an audit trail should be able to state.
        assert payload["document_exists"] is False
        assert payload["log"]["filename"] == "doomed.pdf"


class TestLogAnalytics:
    def test_reports_cards_and_zero_filled_trends(self, client, db):
        _clear_logs(db)  # see TestLogQueries._seed
        _make_log(db, event_type=LogEventType.OCR_FAILED, status=LogStatus.FAILURE)
        _make_log(db, event_type=LogEventType.EXTRACTION_FAILED, status=LogStatus.FAILURE)
        _make_log(db, event_type=LogEventType.OCR_COMPLETED, processing_time=3.0)

        payload = client.get("/api/v1/logs/analytics", params={"days": 7}).json()

        assert payload["total_logs"] == 3
        assert payload["errors_today"] == 2
        # Grouped by category, which only works because a stage failure
        # keeps its stage's category instead of being filed under Error.
        assert payload["ocr_failures"] == 1
        assert payload["extraction_failures"] == 1
        assert payload["batch_failures"] == 0

        assert len(payload["error_trend"]) == 7
        assert payload["error_trend"][-1]["errors"] == 2
        assert payload["error_trend"][0]["total"] == 0

        assert len(payload["processing_time_trend"]) == 7
        assert payload["processing_time_trend"][-1]["average_seconds"] == 3.0
        # `None`, not 0.0 — a day with no timed operation is not a day
        # on which everything was instantaneous.
        assert payload["processing_time_trend"][0]["average_seconds"] is None


class TestLogExport:
    def test_exports_an_xlsx_named_after_its_filters(self, client, db):
        _make_log(db, event_type=LogEventType.OCR_FAILED, status=LogStatus.FAILURE, filename="a.pdf")
        _make_log(db, event_type=LogEventType.OCR_COMPLETED, filename="b.pdf")

        response = client.get("/api/v1/logs/export/xlsx", params={"status": LogStatus.FAILURE.value})

        assert response.status_code == 200
        assert response.headers["content-type"].startswith(
            "application/vnd.openxmlformats-officedocument"
        )
        assert "logs_Failure_" in response.headers["content-disposition"]
        # A real zip container, not an error page with the right header.
        assert response.content[:2] == b"PK"

    def test_export_matches_the_filtered_list(self, client, db):
        from io import BytesIO

        from openpyxl import load_workbook

        _clear_logs(db)
        _make_log(db, event_type=LogEventType.OCR_FAILED, status=LogStatus.FAILURE, filename="a.pdf")
        _make_log(db, event_type=LogEventType.OCR_COMPLETED, filename="b.pdf")

        response = client.get("/api/v1/logs/export/xlsx", params={"status": LogStatus.FAILURE.value})
        sheet = load_workbook(BytesIO(response.content), read_only=True).active
        rows = list(sheet.iter_rows(values_only=True))

        assert rows[0][:7] == (
            "Timestamp",
            "Event Type",
            "Category",
            "Filename",
            "Status",
            "Message",
            "Processing Time (s)",
        )
        # The failing row, plus the export's own Started entry — which is
        # written before the rows are read and is therefore genuinely
        # part of what happened during the window. See the endpoint.
        exported_filenames = {row[3] for row in rows[1:]}
        assert "a.pdf" in exported_filenames
        assert "b.pdf" not in exported_filenames


class TestDocumentAudit:
    """The Audit History panel's data: field changes and actions, merged."""

    @pytest.fixture
    def extracted_document(self, client, make_upload, db):
        """An uploaded document with extraction results already stored."""
        from database import crud

        stored_name = client.post(
            "/api/v1/upload", files=[make_upload(field="file")]
        ).json()["filename"]
        crud.save_extraction_result(
            db,
            filename=stored_name,
            document_type=DocumentType.INVOICE,
            extracted_data={
                "invoice_number": "INV-1",
                "vendor_name": "Acme",
                "invoice_date": None,
                "total_amount": None,
            },
        )
        return stored_name

    def test_merges_corrections_and_actions_newest_first(self, client, extracted_document):
        filename = extracted_document

        client.patch(
            f"/api/v1/documents/{filename}/review",
            json={"corrected_fields": {"vendor_name": "Acme Ltd"}},
        )
        client.post(f"/api/v1/documents/{filename}/review/decision", json={"decision": "approve"})

        payload = client.get(f"/api/v1/documents/{filename}/audit").json()
        kinds = [entry["kind"] for entry in payload["entries"]]
        summaries = [entry["summary"] for entry in payload["entries"]]

        assert payload["total_entries"] == 3
        assert "Document approved" in summaries[0]
        assert "action" in kinds and "field_change" in kinds

        change = next(entry for entry in payload["entries"] if entry["kind"] == "field_change")
        assert change["field_name"] == "vendor_name"
        assert change["original_value"] == "Acme"
        assert change["updated_value"] == "Acme Ltd"

        save = next(
            entry
            for entry in payload["entries"]
            if entry["event_type"] == LogEventType.REVIEW_SAVED.value
        )
        assert save["changed_fields"] == ["vendor_name"]
        assert "1 field" in save["summary"]

    def test_a_save_sorts_above_its_own_field_changes(self, client, extracted_document):
        filename = extracted_document
        client.patch(
            f"/api/v1/documents/{filename}/review",
            json={"corrected_fields": {"vendor_name": "Acme Ltd", "invoice_number": "INV-2"}},
        )

        entries = client.get(f"/api/v1/documents/{filename}/audit").json()["entries"]
        # Newest first, and the tie-break puts the action announcing the
        # save above the changes it describes rather than scattering them.
        assert entries[0]["kind"] == "action"
        assert [entry["kind"] for entry in entries[1:]] == ["field_change", "field_change"]

    def test_available_for_a_document_that_was_never_extracted(self, client, make_upload):
        stored_name = client.post(
            "/api/v1/upload", files=[make_upload(field="file")]
        ).json()["filename"]

        # The review endpoints answer 409 here — nothing has been
        # extracted — but the history of a document nobody could extract
        # is exactly the history worth reading.
        assert client.get(f"/api/v1/documents/{stored_name}/review").status_code == 409
        audit = client.get(f"/api/v1/documents/{stored_name}/audit")
        assert audit.status_code == 200
        assert audit.json()["entries"] == []

    def test_unknown_document_is_a_404(self, client):
        assert client.get("/api/v1/documents/nope.pdf/audit").status_code == 404


def _clear_logs(db) -> None:
    """
    Empty `application_logs`.

    Needed because the `client` fixture starts the application, and
    startup writes a `System Event` row on purpose (see `app.py`). That
    is correct behaviour and a nuisance for a test asserting exact
    counts, so the read-side tests clear the table after the app is up
    and seed exactly what they mean to query.
    """
    db.query(ApplicationLog).delete()
    db.commit()


def _dispatch(batch_id: str) -> None:
    """
    Start a batch built by `batch_factory`, which creates rows without
    dispatching them.

    Its own session, closed immediately: the dispatcher hands files to
    worker threads that open their own, and holding the test's session
    open across that would have two connections writing the same rows.
    """
    from database.session import SessionLocal
    from services import batch_dispatch

    session = SessionLocal()
    try:
        batch_dispatch.dispatch_batch(session, batch_id)
    finally:
        session.close()


def _wait_for(condition, timeout: float = 15.0) -> None:
    """
    Poll `condition` until it is true.

    The inline executor runs files on other threads, so every assertion
    about what a batch has *done* is a race against them unless the test
    waits. Polling rather than sleeping a fixed interval keeps a passing
    run fast and makes a failing one fail on its own assertion instead
    of on an arbitrary duration.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if condition():
            return
        time.sleep(0.05)
    raise AssertionError("Condition was not met within the timeout")
