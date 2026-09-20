"""
Tests for `GET /documents/{filename}/file`, which serves the original
uploaded document to the review screen.

The happy path here is one assertion; the rest of this file is about the
two ways this endpoint could leak something. It reads a path built from a
URL parameter, which is the classic shape of a directory-traversal bug,
and it reads from a folder that also holds whatever else an operator has
put there. Both guards are cheap and neither is self-evident from the
route, so both are pinned here.
"""
import pytest

from core.config import get_settings

settings = get_settings()


@pytest.fixture
def stored_file():
    """Write a real file into UPLOAD_DIR and clean it up afterwards."""
    created = []

    def _make(name: str, payload: bytes = b"%PDF-1.4\nstub"):
        path = settings.UPLOAD_DIR / name
        path.write_bytes(payload)
        created.append(path)
        return name

    yield _make

    for path in created:
        path.unlink(missing_ok=True)


class TestServingTheFile:
    def test_serves_a_stored_pdf_inline(self, client, stored_file):
        name = stored_file("review-me.pdf")

        response = client.get(f"/api/v1/documents/{name}/file")

        assert response.status_code == 200
        assert response.headers["content-type"] == "application/pdf"
        # Inline, not attachment: the review screen renders this in an
        # iframe, and a download disposition would make the browser save
        # it instead of showing it.
        assert response.headers["content-disposition"].startswith("inline")
        assert response.content == b"%PDF-1.4\nstub"

    @pytest.mark.parametrize(
        "name, expected_type",
        [("scan.png", "image/png"), ("scan.jpg", "image/jpeg"), ("scan.jpeg", "image/jpeg")],
    )
    def test_serves_each_accepted_image_type(self, client, stored_file, name, expected_type):
        stored_file(name, b"\x89PNG stub")

        response = client.get(f"/api/v1/documents/{name}/file")

        assert response.status_code == 200
        assert response.headers["content-type"] == expected_type

    def test_is_cacheable(self, client, stored_file):
        """
        Stored names are generated UUIDs and a name's bytes never change,
        so the response is immutable. Without this the review screen
        re-downloads a multi-megabyte scan on every remount.
        """
        name = stored_file("cacheable.pdf")

        response = client.get(f"/api/v1/documents/{name}/file")

        assert "immutable" in response.headers["cache-control"]

    def test_missing_file_is_a_404(self, client):
        assert client.get("/api/v1/documents/nothing-here.pdf/file").status_code == 404


class TestItCannotBeUsedToReadOtherFiles:
    """
    The two guards, stated as tests. `Path(...).name` strips directory
    components, and the extension allow-list means only the three types
    the system accepts can ever be served.
    """

    @pytest.mark.parametrize(
        "attempt",
        [
            "..%2f..%2f.env",
            "....//....//.env",
            "%2e%2e%2f%2e%2e%2f.env",
            "..\\..\\.env",
            "subdir/../../.env",
        ],
    )
    def test_traversal_attempts_are_refused(self, client, attempt):
        response = client.get(f"/api/v1/documents/{attempt}/file")

        # 404 for the ones that resolve to a filename, 404/405 for the
        # ones the router rejects outright. The assertion that matters is
        # that nothing is ever served.
        assert response.status_code != 200

    def test_a_file_in_uploads_with_a_disallowed_extension_is_refused(self, client, stored_file):
        """
        Defence in depth. Nothing *should* write a `.env` into the
        uploads folder, but the endpoint refuses to serve one regardless
        of how it got there — the allow-list is checked before the file
        is even looked for.
        """
        name = stored_file("secrets.env", b"GOOGLE_CLOUD_PROJECT=real-project")

        response = client.get(f"/api/v1/documents/{name}/file")

        assert response.status_code == 404
        assert b"real-project" not in response.content


class TestExistingDocumentRoutesUnaffected:
    """The new route sits under `/documents/{filename}/` and must not shadow its siblings."""

    def test_the_record_endpoint_still_answers(self, client):
        # 404 because no such record, *not* 405 or a mis-routed response.
        assert client.get("/api/v1/documents/unknown.pdf").status_code == 404

    def test_the_list_endpoint_still_answers(self, client):
        assert client.get("/api/v1/documents").status_code == 200
