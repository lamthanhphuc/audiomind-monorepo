"""Tests for internal transcript-quality endpoints (Epic 3 Slice 2)."""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def test_get_transcript_quality_not_ready(client, monkeypatch):
    monkeypatch.setattr(
        "app.routes.internal_meetings.settings.transcript_quality_enabled", True
    )

    with patch("app.routes.internal_meetings.resolve_latest_run_id", return_value=None):
        response = client.get("/api/internal/meetings/42/transcript-quality")

    assert response.status_code == 200
    body = response.json()
    assert body["meetingId"] == 42
    assert body["ready"] is False


def test_canonicalize_returns_202(client, monkeypatch):
    monkeypatch.setattr(
        "app.routes.internal_meetings.settings.transcript_quality_enabled", True
    )

    mock_run = MagicMock()
    mock_run.id = 7
    mock_run.canonical_transcript_hash = None

    with (
        patch("app.routes.internal_meetings._resolve_run", return_value=mock_run),
        patch(
            "app.routes.internal_meetings.preview_canonical_hash",
            return_value=("canonical-transcript-v2", "abc123"),
        ),
        patch("app.routes.internal_meetings.check_idempotent_skip", return_value=None),
        patch("app.routes.internal_meetings.mark_inflight"),
        patch(
            "app.routes.internal_meetings._enqueue_canonicalize", return_value="task-1"
        ),
    ):
        response = client.post("/api/internal/meetings/42/canonicalize", json={})

    assert response.status_code == 202
    assert response.json()["taskId"] == "task-1"


def test_canonicalize_idempotent_skip_in_flight(client, monkeypatch):
    monkeypatch.setattr(
        "app.routes.internal_meetings.settings.transcript_quality_enabled", True
    )

    mock_run = MagicMock()
    mock_run.id = 7
    mock_run.canonical_transcript_hash = None

    with (
        patch("app.routes.internal_meetings._resolve_run", return_value=mock_run),
        patch(
            "app.routes.internal_meetings.preview_canonical_hash",
            return_value=("canonical-transcript-v2", "abc123"),
        ),
        patch(
            "app.routes.internal_meetings.check_idempotent_skip",
            return_value="in_flight",
        ),
        patch("app.routes.internal_meetings.log_idempotent_skip") as log_skip,
        patch("app.routes.internal_meetings._enqueue_canonicalize") as enqueue,
    ):
        response = client.post("/api/internal/meetings/42/canonicalize", json={})

    assert response.status_code == 202
    assert response.json()["taskId"] == ""
    log_skip.assert_called_once()
    enqueue.assert_not_called()
