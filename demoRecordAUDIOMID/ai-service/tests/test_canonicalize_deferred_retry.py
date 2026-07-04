"""Tests for canonicalize_deferred_retry race after realtime finalize (§5.3.1)."""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.tasks import canonicalize_deferred_retry


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def mock_db_session():
    session = MagicMock()
    with patch("app.tasks.SessionLocal") as session_local:
        session_local.return_value = session
        yield session


def test_deferred_retry_schedules_next_attempt_when_run_missing(mock_db_session):
    with (
        patch(
            "app.services.canonical_persist_service.resolve_latest_run_id",
            return_value=None,
        ),
        patch.object(
            canonicalize_deferred_retry,
            "apply_async",
        ) as apply_async,
    ):
        result = canonicalize_deferred_retry(42, attempt=1)

    assert result == {"status": "deferred", "attempt": 1}
    apply_async.assert_called_once_with(args=[42, 2], countdown=5)


def test_deferred_retry_skips_after_max_attempts(mock_db_session):
    with patch(
        "app.services.canonical_persist_service.resolve_latest_run_id",
        return_value=None,
    ):
        result = canonicalize_deferred_retry(42, attempt=5)

    assert result == {"status": "skipped", "attempt": 5}


def test_deferred_retry_persists_when_run_appears_after_finalize(mock_db_session):
    with (
        patch(
            "app.services.canonical_persist_service.resolve_latest_run_id",
            return_value=99,
        ),
        patch("app.tasks.canonicalize_and_persist") as canonicalize_task,
    ):
        canonicalize_task.return_value = {"status": "persisted", "runId": 99}
        result = canonicalize_deferred_retry(42, attempt=3)

    canonicalize_task.assert_called_once_with(42, 99)
    assert result == {"status": "persisted", "runId": 99}


def test_canonicalize_endpoint_enqueues_deferred_retry_when_no_run(client, monkeypatch):
    """Realtime finalize may POST canonicalize before analysis run exists."""
    monkeypatch.setattr(
        "app.routes.internal_meetings.settings.transcript_quality_enabled", True
    )

    with (
        patch("app.routes.internal_meetings._resolve_run", return_value=None),
        patch("app.tasks.canonicalize_deferred_retry.apply_async") as deferred,
    ):
        response = client.post("/api/internal/meetings/55/canonicalize", json={})

    assert response.status_code == 202
    assert response.json()["taskId"] == ""
    deferred.assert_called_once_with(args=[55, 1], countdown=5)
