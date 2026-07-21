"""Unit tests for meeting-service subject membership client."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx
import pytest

from app.services.study import StudyTransientError, StudyValidationError
from app.services.study.membership import (
    MeetingMembershipUnavailableError,
    fetch_subject_meeting_ids,
    hash_membership,
)


def test_hash_membership_stable_sorted_unique():
    assert hash_membership([3, 1, 2, 1]) == hash_membership([1, 2, 3])
    assert hash_membership(None) == hash_membership([])


def test_fetch_missing_config_raises_unavailable(monkeypatch):
    settings = MagicMock()
    settings.meeting_service_base_url = ""
    settings.meeting_api_base_url = ""
    settings.internal_service_token = ""
    monkeypatch.setattr("app.services.study.membership.get_settings", lambda: settings)

    with pytest.raises(MeetingMembershipUnavailableError):
        fetch_subject_meeting_ids(10, 1)


def test_fetch_parses_items_with_id(monkeypatch):
    settings = MagicMock()
    settings.meeting_service_base_url = "http://meeting-api:8081"
    settings.internal_service_token = "secret"
    settings.meeting_service_timeout_seconds = 5.0
    monkeypatch.setattr("app.services.study.membership.get_settings", lambda: settings)

    response = httpx.Response(
        200,
        json={
            "items": [{"id": 101, "title": "A"}, {"meetingId": 102}],
            "total": 2,
            "page": 1,
            "pageSize": 100,
            "totalPages": 1,
        },
        request=httpx.Request(
            "GET", "http://meeting-api:8081/internal/subjects/10/meetings"
        ),
    )

    with patch("httpx.Client") as client_cls:
        client = client_cls.return_value.__enter__.return_value
        client.get.return_value = response
        ids = fetch_subject_meeting_ids(10, 7)

    assert ids == [101, 102]
    call_kwargs = client.get.call_args
    url = call_kwargs.args[0] if call_kwargs.args else call_kwargs.kwargs.get("url")
    assert "/internal/subjects/10/meetings" in url
    assert "/subjects/10/meetings?" not in url.replace("/internal/subjects", "")
    headers = call_kwargs.kwargs["headers"]
    assert headers["X-Internal-Service-Token"] == "secret"
    assert headers["X-Owner-User-Id"] == "7"


def test_fetch_parses_content_and_meetings_keys(monkeypatch):
    settings = MagicMock()
    settings.meeting_service_base_url = "http://meeting-api:8081"
    settings.internal_service_token = "secret"
    settings.meeting_service_timeout_seconds = 5.0
    monkeypatch.setattr("app.services.study.membership.get_settings", lambda: settings)

    response = httpx.Response(
        200,
        json={"content": [{"id": 5}], "totalPages": 1},
        request=httpx.Request("GET", "http://x"),
    )
    with patch("httpx.Client") as client_cls:
        client = client_cls.return_value.__enter__.return_value
        client.get.return_value = response
        assert fetch_subject_meeting_ids(1, 1) == [5]


def test_fetch_paginates_until_done(monkeypatch):
    settings = MagicMock()
    settings.meeting_service_base_url = "http://meeting-api:8081"
    settings.internal_service_token = "secret"
    settings.meeting_service_timeout_seconds = 5.0
    monkeypatch.setattr("app.services.study.membership.get_settings", lambda: settings)

    pages = [
        httpx.Response(
            200,
            json={
                "items": [{"id": 1}, {"id": 2}],
                "total": 5,
                "page": 1,
                "pageSize": 2,
                "totalPages": 3,
            },
            request=httpx.Request("GET", "http://x"),
        ),
        httpx.Response(
            200,
            json={
                "items": [{"id": 3}, {"id": 4}],
                "total": 5,
                "page": 2,
                "pageSize": 2,
                "totalPages": 3,
            },
            request=httpx.Request("GET", "http://x"),
        ),
        httpx.Response(
            200,
            json={
                "items": [{"id": 5}],
                "total": 5,
                "page": 3,
                "pageSize": 2,
                "totalPages": 3,
            },
            request=httpx.Request("GET", "http://x"),
        ),
    ]

    with patch("httpx.Client") as client_cls:
        client = client_cls.return_value.__enter__.return_value
        client.get.side_effect = pages
        ids = fetch_subject_meeting_ids(12, 1)

    assert ids == [1, 2, 3, 4, 5]
    assert client.get.call_count == 3
    urls = [c.args[0] for c in client.get.call_args_list]
    assert "page=1&pageSize=100" in urls[0]
    assert "page=2&pageSize=100" in urls[1]
    assert "page=3&pageSize=100" in urls[2]


def test_fetch_empty_subject(monkeypatch):
    settings = MagicMock()
    settings.meeting_service_base_url = "http://meeting-api:8081"
    settings.internal_service_token = "secret"
    settings.meeting_service_timeout_seconds = 5.0
    monkeypatch.setattr("app.services.study.membership.get_settings", lambda: settings)

    response = httpx.Response(
        200,
        json={"items": [], "total": 0, "page": 1, "pageSize": 100, "totalPages": 0},
        request=httpx.Request("GET", "http://x"),
    )
    with patch("httpx.Client") as client_cls:
        client = client_cls.return_value.__enter__.return_value
        client.get.return_value = response
        assert fetch_subject_meeting_ids(3, 9) == []


def test_fetch_5xx_raises_transient_with_code(monkeypatch):
    settings = MagicMock()
    settings.meeting_service_base_url = "http://meeting-api:8081"
    settings.internal_service_token = "secret"
    settings.meeting_service_timeout_seconds = 5.0
    monkeypatch.setattr("app.services.study.membership.get_settings", lambda: settings)

    response = httpx.Response(
        503,
        json={"error": "down"},
        request=httpx.Request("GET", "http://x"),
    )
    with patch("httpx.Client") as client_cls:
        client = client_cls.return_value.__enter__.return_value
        client.get.return_value = response
        with pytest.raises(StudyTransientError) as exc_info:
            fetch_subject_meeting_ids(1, 1)

    assert exc_info.value.code == "MEETING_MEMBERSHIP_SERVICE_UNAVAILABLE"


def test_fetch_timeout_raises_transient(monkeypatch):
    settings = MagicMock()
    settings.meeting_service_base_url = "http://meeting-api:8081"
    settings.internal_service_token = "secret"
    settings.meeting_service_timeout_seconds = 5.0
    monkeypatch.setattr("app.services.study.membership.get_settings", lambda: settings)

    with patch("httpx.Client") as client_cls:
        client = client_cls.return_value.__enter__.return_value
        client.get.side_effect = httpx.TimeoutException("timeout")
        with pytest.raises(StudyTransientError) as exc_info:
            fetch_subject_meeting_ids(1, 1)

    assert exc_info.value.code == "MEETING_MEMBERSHIP_SERVICE_UNAVAILABLE"


@pytest.mark.parametrize("status", [401, 403])
def test_fetch_auth_errors_raise_transient(monkeypatch, status):
    settings = MagicMock()
    settings.meeting_service_base_url = "http://meeting-api:8081"
    settings.internal_service_token = "secret"
    settings.meeting_service_timeout_seconds = 5.0
    monkeypatch.setattr("app.services.study.membership.get_settings", lambda: settings)

    response = httpx.Response(
        status,
        json={"error": "unauthorized"},
        request=httpx.Request("GET", "http://x"),
    )
    with patch("httpx.Client") as client_cls:
        client = client_cls.return_value.__enter__.return_value
        client.get.return_value = response
        with pytest.raises(StudyTransientError) as exc_info:
            fetch_subject_meeting_ids(1, 1)

    assert exc_info.value.code == "MEETING_MEMBERSHIP_SERVICE_UNAVAILABLE"


def test_fetch_404_raises_validation(monkeypatch):
    settings = MagicMock()
    settings.meeting_service_base_url = "http://meeting-api:8081"
    settings.internal_service_token = "secret"
    settings.meeting_service_timeout_seconds = 5.0
    monkeypatch.setattr("app.services.study.membership.get_settings", lambda: settings)

    response = httpx.Response(
        404,
        json={"error": "not found"},
        request=httpx.Request("GET", "http://x"),
    )
    with patch("httpx.Client") as client_cls:
        client = client_cls.return_value.__enter__.return_value
        client.get.return_value = response
        with pytest.raises(StudyValidationError) as exc_info:
            fetch_subject_meeting_ids(99, 1)

    assert exc_info.value.code == "SUBJECT_NOT_FOUND"


def test_fetch_never_calls_public_subjects_path(monkeypatch):
    settings = MagicMock()
    settings.meeting_service_base_url = "http://meeting-api:8081"
    settings.internal_service_token = "secret"
    settings.meeting_service_timeout_seconds = 5.0
    monkeypatch.setattr("app.services.study.membership.get_settings", lambda: settings)

    response = httpx.Response(
        200,
        json={"items": [], "totalPages": 0},
        request=httpx.Request("GET", "http://x"),
    )
    with patch("httpx.Client") as client_cls:
        client = client_cls.return_value.__enter__.return_value
        client.get.return_value = response
        fetch_subject_meeting_ids(10, 1)

    url = client.get.call_args.args[0]
    assert url.startswith("http://meeting-api:8081/internal/subjects/")
    assert "/subjects/10/meetings" not in url or "/internal/subjects/10/meetings" in url
