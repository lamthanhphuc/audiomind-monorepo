"""Celery process_meeting failure semantics (fully mocked, offline)."""

import pickle

import pytest

from app.services.analysis_errors import AnalysisUnavailableError


def test_process_meeting_terminal_provider_error_fails_celery_task(monkeypatch):
    import app.tasks as tasks_mod

    recorded = {}

    class FakePipeline:
        def process_meeting(self, **kwargs):
            raise AnalysisUnavailableError(
                "Gemini key pool unavailable due to mixed provider failures",
                provider="gemini",
                error_code="GEMINI_KEY_POOL_UNAVAILABLE",
                retryable=False,
            )

    class FakeSession:
        def close(self):
            return None

    monkeypatch.setattr(tasks_mod, "pipeline", FakePipeline())
    monkeypatch.setattr(tasks_mod, "SessionLocal", lambda: FakeSession())

    def fake_set_job_status(meeting_id, status, **kwargs):
        recorded["meeting_id"] = meeting_id
        recorded["status"] = status
        recorded["error"] = kwargs.get("error")

    monkeypatch.setattr(tasks_mod, "set_job_status", fake_set_job_status)

    with pytest.raises(AnalysisUnavailableError) as exc_info:
        tasks_mod.process_meeting(
            {
                "meeting_id": 91,
                "audio_path": "/tmp/offline.wav",
                "trace_id": "t-91",
                "file_id": "f-91",
            }
        )

    assert recorded["status"] == "FAILED"
    assert "GEMINI_KEY_POOL_UNAVAILABLE" in str(recorded["error"])
    assert exc_info.value.retryable is False
    # Pickle-safe for Celery FAILURE serialization.
    restored = pickle.loads(pickle.dumps(exc_info.value))
    assert restored.error_code == "GEMINI_KEY_POOL_UNAVAILABLE"
