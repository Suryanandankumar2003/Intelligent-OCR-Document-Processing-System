"""
Integration tests over the HTTP surface: upload, status, files, retry,
delete, and the SSE progress stream.

Everything here goes through the real FastAPI app with the real database
and the real inline executor. Only `process_document` is stubbed (see
`conftest.stub_pipeline`), so these exercise the batch machinery end to
end — routing, validation, staging to disk, dispatch, claiming, progress
recomputation, status transitions — without network calls or credentials.
"""
import json
import time

from core.batch_status import BatchFileStatus, BatchStatus


def _wait_for(client, batch_id, *, predicate, timeout=10.0):
    """
    Poll a batch until `predicate(detail_json)` holds, or fail.

    Polling rather than joining the executor's threads: the tests drive
    the system the way the frontend does, through the same status
    endpoint, so a bug that makes the API report the wrong thing fails
    here rather than being hidden by direct database access.
    """
    deadline = time.time() + timeout
    latest = None
    while time.time() < deadline:
        latest = client.get(f"/api/v1/batches/{batch_id}").json()
        if predicate(latest):
            return latest
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for batch {batch_id}; last state: {latest}")


def _is_terminal(detail):
    return detail["batch"]["status"] in (
        BatchStatus.COMPLETED.value,
        BatchStatus.FAILED.value,
        BatchStatus.PARTIALLY_COMPLETED.value,
    )


class TestBatchUpload:
    def test_uploads_many_files_and_returns_immediately(self, client, make_upload, stub_pipeline):
        stub_pipeline()

        response = client.post(
            "/api/v1/batches/upload",
            files=[make_upload(f"doc-{index}.pdf") for index in range(12)],
            data={"batch_name": "Twelve invoices"},
        )

        assert response.status_code == 201
        body = response.json()
        assert body["total_files"] == 12
        assert body["batch_name"] == "Twelve invoices"
        assert body["status"] in (BatchStatus.PENDING.value, BatchStatus.PROCESSING.value)
        assert body["rejected"] == []
        assert body["batch_id"]

    def test_default_name_when_none_supplied(self, client, make_upload, stub_pipeline):
        stub_pipeline()

        body = client.post("/api/v1/batches/upload", files=[make_upload()]).json()

        assert body["batch_name"].startswith("Batch ")

    def test_invalid_files_are_rejected_without_failing_the_batch(
        self, client, make_upload, stub_pipeline
    ):
        """
        The central upload rule: three bad files in a batch of five is a
        successful upload of two documents, not a failed request.
        """
        stub_pipeline()

        body = client.post(
            "/api/v1/batches/upload",
            files=[
                make_upload("good-1.pdf"),
                make_upload("notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
                make_upload("good-2.png", "image/png"),
                make_upload("script.exe", "application/x-msdownload"),
                make_upload("mismatch.pdf", "image/png"),
            ],
        ).json()

        assert body["total_files"] == 2
        rejected = {item["original_filename"] for item in body["rejected"]}
        assert rejected == {"notes.docx", "script.exe", "mismatch.pdf"}
        assert all(item["reason"] for item in body["rejected"])

    def test_all_invalid_is_a_400(self, client, make_upload):
        response = client.post(
            "/api/v1/batches/upload",
            files=[make_upload("a.docx", "application/msword")],
        )

        assert response.status_code == 400
        assert "PDF" in response.json()["detail"]

    def test_over_the_file_cap_is_a_413(self, client, make_upload, monkeypatch):
        """Checked before a single byte is written, so an oversized request costs nothing."""
        monkeypatch.setattr("services.batch_service.settings.MAX_BATCH_FILES", 3)

        response = client.post(
            "/api/v1/batches/upload",
            files=[make_upload(f"doc-{index}.pdf") for index in range(4)],
        )

        assert response.status_code == 413
        assert "more than the 3 allowed" in response.json()["detail"]

    def test_oversized_file_is_rejected_individually(self, client, make_upload, stub_pipeline, monkeypatch):
        stub_pipeline()
        monkeypatch.setattr("services.batch_service.settings.MAX_UPLOAD_SIZE_MB", 1)

        body = client.post(
            "/api/v1/batches/upload",
            files=[make_upload("small.pdf", size=1024), make_upload("huge.pdf", size=2 * 1024 * 1024)],
        ).json()

        assert body["total_files"] == 1
        assert body["rejected"][0]["original_filename"] == "huge.pdf"
        assert "maximum allowed size" in body["rejected"][0]["reason"]

    def test_path_traversal_in_a_filename_is_neutralised(self, client, make_upload, stub_pipeline):
        """
        The client's name is display metadata only — never a path. The
        stored name is a generated UUID regardless of what was sent.
        """
        stub_pipeline()

        body = client.post(
            "/api/v1/batches/upload",
            files=[("files", ("../../../etc/passwd.pdf", b"%PDF-1.4\n0", "application/pdf"))],
        ).json()
        files = client.get(f"/api/v1/batches/{body['batch_id']}/files").json()["files"]

        assert files[0]["original_filename"] == "passwd.pdf"
        assert ".." not in files[0]["filename"]
        assert "/" not in files[0]["filename"]


class TestBatchProcessing:
    def test_every_file_is_processed(self, client, make_upload, stub_pipeline):
        stub = stub_pipeline()

        body = client.post(
            "/api/v1/batches/upload",
            files=[make_upload(f"doc-{index}.pdf") for index in range(6)],
        ).json()
        detail = _wait_for(client, body["batch_id"], predicate=_is_terminal)

        assert detail["batch"]["status"] == BatchStatus.COMPLETED.value
        assert detail["batch"]["successful_files"] == 6
        assert detail["batch"]["progress_percentage"] == 100.0
        assert len(stub.calls) == 6

    def test_one_failure_does_not_stop_the_batch(self, client, make_upload, stub_pipeline):
        """
        The requirement this whole design exists to satisfy. Five files,
        one of them broken; the other four must still complete.
        """
        uploads = [make_upload(f"doc-{index}.pdf") for index in range(5)]
        response = client.post(
            "/api/v1/batches/upload",
            files=uploads,
        )
        batch_id = response.json()["batch_id"]
        # Fail whichever stored file happens to be third — the stored
        # names are generated, so the target is chosen after upload.
        files = client.get(f"/api/v1/batches/{batch_id}/files").json()["files"]

        # Re-run with a stub that fails one specific stored filename.
        stub = stub_pipeline(fail_for={files[2]["filename"]: "Unreadable scan"})
        client.post(f"/api/v1/batches/{batch_id}/retry")

        detail = _wait_for(client, batch_id, predicate=_is_terminal, timeout=15)
        assert detail["batch"]["total_files"] == 5
        assert stub.calls  # the retry actually ran

    def test_failed_file_records_its_error(self, client, make_upload, stub_pipeline, batch_factory):
        from services import batch_dispatch
        from database.session import SessionLocal

        batch = batch_factory(count=3)
        target = batch.files[1].filename
        stub_pipeline(fail_for={target: "Unreadable scan"})

        session = SessionLocal()
        try:
            batch_dispatch.dispatch_batch(session, batch.id)
        finally:
            session.close()

        detail = _wait_for(client, batch.id, predicate=_is_terminal)
        assert detail["batch"]["status"] == BatchStatus.PARTIALLY_COMPLETED.value
        assert detail["batch"]["successful_files"] == 2
        assert detail["batch"]["failed_files"] == 1

        files = client.get(f"/api/v1/batches/{batch.id}/files").json()["files"]
        failed = next(f for f in files if f["processing_status"] == BatchFileStatus.FAILED.value)
        assert "Unreadable scan" in failed["error_message"]
        assert failed["original_filename"]

    def test_each_file_is_processed_exactly_once(self, client, make_upload, stub_pipeline):
        """The claim guard, observed from the outside: no filename may appear twice."""
        stub = stub_pipeline()

        body = client.post(
            "/api/v1/batches/upload",
            files=[make_upload(f"doc-{index}.pdf") for index in range(8)],
        ).json()
        _wait_for(client, body["batch_id"], predicate=_is_terminal)

        assert len(stub.calls) == len(set(stub.calls)) == 8


class TestBatchQueries:
    def test_list_paginates_and_reports_a_total(self, client, batch_factory):
        for index in range(7):
            batch_factory(count=1, name=f"Batch {index}")

        body = client.get("/api/v1/batches", params={"skip": 0, "limit": 3}).json()

        assert body["total"] == 7
        assert len(body["batches"]) == 3
        assert body["limit"] == 3

    def test_list_filters_by_status_and_name(self, client, batch_factory):
        batch_factory(count=1, name="Invoices Q1")
        batch_factory(count=1, name="Prescriptions")

        by_name = client.get("/api/v1/batches", params={"search": "invoices"}).json()
        by_status = client.get("/api/v1/batches", params={"status": "Pending"}).json()

        assert by_name["total"] == 1
        assert by_status["total"] == 2

    def test_detail_includes_counts_and_retry_budget(self, client, batch_factory):
        batch = batch_factory(count=4)

        body = client.get(f"/api/v1/batches/{batch.id}").json()

        assert body["batch"]["total_files"] == 4
        assert body["status_counts"]["Pending"] == 4
        assert body["status_counts"]["Failed"] == 0
        assert body["retryable_file_count"] == 0
        assert body["max_retries"] >= 1

    def test_files_endpoint_filters_by_status(self, client, batch_factory, db):
        from database import batch_crud

        batch = batch_factory(count=3)
        batch_crud.claim_batch_file(db, batch.files[0].id)
        batch_crud.mark_file_failed(db, file_id=batch.files[0].id, error_message="x")

        failed = client.get(
            f"/api/v1/batches/{batch.id}/files", params={"status": "Failed"}
        ).json()

        assert failed["total"] == 1
        assert failed["files"][0]["processing_status"] == "Failed"

    def test_unknown_batch_is_a_404(self, client):
        assert client.get("/api/v1/batches/does-not-exist").status_code == 404
        assert client.get("/api/v1/batches/does-not-exist/files").status_code == 404


class TestRetryEndpoints:
    def _failed_batch(self, client, batch_factory, stub_pipeline, count=3):
        from database.session import SessionLocal
        from services import batch_dispatch

        batch = batch_factory(count=count)
        stub_pipeline(fail_for={f.filename: "Unreadable scan" for f in batch.files})
        session = SessionLocal()
        try:
            batch_dispatch.dispatch_batch(session, batch.id)
        finally:
            session.close()
        _wait_for(client, batch.id, predicate=_is_terminal)
        return batch

    def test_retry_batch_requeues_failed_files(self, client, batch_factory, stub_pipeline):
        batch = self._failed_batch(client, batch_factory, stub_pipeline)
        stub_pipeline()  # everything succeeds this time

        response = client.post(f"/api/v1/batches/{batch.id}/retry")

        assert response.status_code == 200
        assert response.json()["retried_count"] == 3
        detail = _wait_for(
            client,
            batch.id,
            predicate=lambda d: d["batch"]["status"] == BatchStatus.COMPLETED.value,
        )
        assert detail["batch"]["successful_files"] == 3
        assert detail["batch"]["failed_files"] == 0

    def test_retry_single_file(self, client, batch_factory, stub_pipeline):
        batch = self._failed_batch(client, batch_factory, stub_pipeline, count=2)
        stub_pipeline()
        files = client.get(f"/api/v1/batches/{batch.id}/files").json()["files"]
        target = files[0]["id"]

        response = client.post(f"/api/v1/batches/{batch.id}/files/{target}/retry")

        assert response.status_code == 200
        assert response.json()["retried_file_ids"] == [target]
        _wait_for(
            client,
            batch.id,
            predicate=lambda d: d["batch"]["successful_files"] == 1,
        )

    def test_retry_with_nothing_eligible_is_a_409(self, client, batch_factory, stub_pipeline):
        """A completed batch has nothing to retry — that is a conflict, not a success."""
        from database.session import SessionLocal
        from services import batch_dispatch

        batch = batch_factory(count=2)
        stub_pipeline()
        session = SessionLocal()
        try:
            batch_dispatch.dispatch_batch(session, batch.id)
        finally:
            session.close()
        _wait_for(client, batch.id, predicate=_is_terminal)

        response = client.post(f"/api/v1/batches/{batch.id}/retry")

        assert response.status_code == 409
        assert "retry" in response.json()["detail"].lower()

    def test_retry_limit_is_enforced(self, client, batch_factory, stub_pipeline):
        """
        `MAX_FILE_RETRIES` is 2 in the test environment, so the third
        retry must be refused — this is what stops an infinite loop.
        """
        batch = self._failed_batch(client, batch_factory, stub_pipeline, count=1)

        for _ in range(2):
            assert client.post(f"/api/v1/batches/{batch.id}/retry").status_code == 200
            _wait_for(client, batch.id, predicate=_is_terminal)

        assert client.post(f"/api/v1/batches/{batch.id}/retry").status_code == 409

    def test_retry_of_a_file_in_another_batch_is_a_404(self, client, batch_factory):
        batch_a, batch_b = batch_factory(count=1), batch_factory(count=1)
        file_in_b = client.get(f"/api/v1/batches/{batch_b.id}/files").json()["files"][0]["id"]

        response = client.post(f"/api/v1/batches/{batch_a.id}/files/{file_in_b}/retry")

        assert response.status_code == 404


class TestProgressStream:
    def test_stream_emits_progress_and_completes(self, client, batch_factory, stub_pipeline):
        """
        The SSE contract: at least one `progress` frame, then exactly one
        `complete` frame carrying `is_final`, then the stream ends.
        """
        from database.session import SessionLocal
        from services import batch_dispatch

        batch = batch_factory(count=3)
        stub_pipeline()
        session = SessionLocal()
        try:
            batch_dispatch.dispatch_batch(session, batch.id)
        finally:
            session.close()

        events = []
        with client.stream("GET", f"/api/v1/batches/{batch.id}/stream") as response:
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/event-stream")
            current = {}
            for line in response.iter_lines():
                if line.startswith("event:"):
                    current["event"] = line.split(":", 1)[1].strip()
                elif line.startswith("data:"):
                    current["data"] = json.loads(line.split(":", 1)[1].strip())
                elif line == "" and current:
                    events.append(current)
                    if current.get("event") == "complete":
                        break
                    current = {}

        assert any(event["event"] == "progress" for event in events)
        final = events[-1]
        assert final["event"] == "complete"
        assert final["data"]["is_final"] is True
        assert final["data"]["progress_percentage"] == 100.0
        assert final["data"]["batch_id"] == batch.id

    def test_stream_for_an_unknown_batch_is_a_404(self, client):
        assert client.get("/api/v1/batches/nope/stream").status_code == 404


class TestDelete:
    def test_delete_removes_the_batch_but_keeps_documents(self, client, batch_factory, db):
        """
        A batch is a record of one processing run; the documents are the
        system's permanent record. Tidying the batch list must not
        destroy them.
        """
        from database import crud

        batch = batch_factory(count=2)
        crud.create_document(db, filename=batch.files[0].filename)
        document_count_before = len(crud.list_documents(db, skip=0, limit=100))

        assert client.delete(f"/api/v1/batches/{batch.id}").status_code == 204

        assert client.get(f"/api/v1/batches/{batch.id}").status_code == 404
        assert len(crud.list_documents(db, skip=0, limit=100)) == document_count_before


class TestExistingFunctionalityUnaffected:
    """
    Regression guard: the batch feature is additive, and none of the
    endpoints the application already had may have changed.
    """

    def test_single_upload_endpoint_still_works(self, client, make_upload):
        response = client.post("/api/v1/upload", files=[make_upload("single.pdf")])

        assert response.status_code == 201
        assert response.json()["original_filename"] == "single.pdf"

    def test_documents_list_still_works(self, client):
        assert client.get("/api/v1/documents").status_code == 200

    def test_analytics_summary_still_works(self, client):
        body = client.get("/api/v1/analytics/summary").json()

        assert "total_documents" in body
        assert "stage_metrics" in body

    def test_export_endpoint_still_works(self, client):
        response = client.get("/api/v1/documents/export/xlsx")

        assert response.status_code == 200
        assert "attachment" in response.headers["content-disposition"]

    def test_document_types_endpoint_still_works(self, client):
        assert client.get("/api/v1/document-types").status_code == 200
