"""Cross-service contract smoke for meeting-service subject membership pages.

Fixture ``tests/fixtures/meeting_membership_page.json`` mirrors Jackson camelCase
serialization of ``PageResponse<SubjectMeetingResponse>`` as documented in
``packages/contracts/meeting-api.yaml`` (``SubjectMeetingPageResponse``).
Keep fixture field names aligned with that OpenAPI schema when the contract changes.
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app.services.study import StudyTransientError
from app.services.study.membership import fetch_subject_meeting_ids

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "meeting_membership_page.json"
SUBJECT_ID = 42
OWNER_USER_ID = 7
TOKEN = "contract-internal-token"
BASE_URL = "http://meeting-api:8081"


def _load_pages() -> list[dict]:
    payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    pages = payload["pages"]
    assert len(pages) == 3
    assert sum(len(page["items"]) for page in pages) == 250
    for page in pages:
        for item in page["items"]:
            assert set(item) >= {"id", "title", "status", "language", "createdAt", "subjectId"}
    return pages


def test_fixture_matches_subject_meeting_page_response_shape():
    pages = _load_pages()
    page = pages[0]
    assert set(page) >= {"items", "total", "page", "pageSize", "totalPages"}
    assert page["total"] == 250
    assert page["pageSize"] == 100
    assert page["totalPages"] == 3
    assert len(page["items"]) == 100


def test_fetch_subject_meeting_ids_paginates_contract_fixture(monkeypatch):
    pages = _load_pages()
    by_page = {int(page["page"]): page for page in pages}
    seen_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_urls.append(str(request.url))
        assert request.headers.get("X-Internal-Service-Token") == TOKEN
        assert request.headers.get("X-Owner-User-Id") == str(OWNER_USER_ID)
        path = urlparse(str(request.url)).path
        assert path == f"/internal/subjects/{SUBJECT_ID}/meetings"
        assert "/subjects/" in path and path.startswith("/internal/")
        query = parse_qs(urlparse(str(request.url)).query)
        page_num = int(query["page"][0])
        assert int(query["pageSize"][0]) == 100
        return httpx.Response(200, json=by_page[page_num])

    settings = type(
        "S",
        (),
        {
            "meeting_service_base_url": BASE_URL,
            "internal_service_token": TOKEN,
            "meeting_service_timeout_seconds": 5.0,
        },
    )()
    monkeypatch.setattr(
        "app.services.study.membership.get_settings", lambda: settings
    )

    transport = httpx.MockTransport(handler)
    real_client = httpx.Client

    def client_factory(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", client_factory)

    ids = fetch_subject_meeting_ids(SUBJECT_ID, OWNER_USER_ID)

    assert ids == list(range(1, 251))
    assert len(seen_urls) == 3
    for url in seen_urls:
        assert url.startswith(f"{BASE_URL}/internal/subjects/{SUBJECT_ID}/meetings")
        assert "/subjects/" in urlparse(url).path
        # Must never hit the public (non-internal) subjects path as the request target.
        public = f"{BASE_URL}/subjects/{SUBJECT_ID}/meetings"
        assert not url.startswith(public)


def test_wrong_token_returns_transient_membership_unavailable(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url).startswith(
            f"{BASE_URL}/internal/subjects/{SUBJECT_ID}/meetings"
        )
        return httpx.Response(401, json={"message": "unauthorized"})

    settings = type(
        "S",
        (),
        {
            "meeting_service_base_url": BASE_URL,
            "internal_service_token": "wrong-token",
            "meeting_service_timeout_seconds": 5.0,
        },
    )()
    monkeypatch.setattr(
        "app.services.study.membership.get_settings", lambda: settings
    )

    transport = httpx.MockTransport(handler)
    real_client = httpx.Client

    def client_factory(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", client_factory)

    with pytest.raises(StudyTransientError) as raised:
        fetch_subject_meeting_ids(SUBJECT_ID, OWNER_USER_ID)

    assert raised.value.code == "MEETING_MEMBERSHIP_SERVICE_UNAVAILABLE"
