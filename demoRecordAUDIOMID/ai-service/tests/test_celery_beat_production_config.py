"""Celery Beat must boot under production Settings (membership URL + token)."""

from __future__ import annotations

import importlib

import pytest
from pydantic import ValidationError

from app.config import Settings, get_settings


def _set_valid_production_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://audiomind:secure-pass@db.prod.internal:5432/audiomind",
    )
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ollama-service:11434")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://app.example.com")
    monkeypatch.setenv("MEETING_SERVICE_BASE_URL", "http://meeting-api:8081")
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "phase2-prod-internal-token")
    monkeypatch.setenv("ANALYSIS_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key-not-empty")
    monkeypatch.setenv("ENABLE_SPEAKER_DIARIZATION", "false")


def test_celery_app_loads_under_valid_production_settings(monkeypatch):
    _set_valid_production_env(monkeypatch)
    get_settings.cache_clear()

    settings = get_settings()
    assert (settings.app_env or "").strip().lower() in {"prod", "production"}
    assert settings.meeting_service_base_url == "http://meeting-api:8081"
    assert settings.internal_service_token == "phase2-prod-internal-token"

    import app.celery_app as celery_module

    # Reload so module-level get_settings() runs under the production cache entry.
    celery_module = importlib.reload(celery_module)
    beat_schedule = celery_module.celery_app.conf.beat_schedule or {}
    assert "study-generation-reconcile" in beat_schedule
    assert (
        beat_schedule["study-generation-reconcile"]["task"]
        == "app.tasks.reconcile_study_generation"
    )

    get_settings.cache_clear()


@pytest.mark.parametrize(
    "missing_group",
    ("meeting_url", "internal_token"),
)
def test_production_settings_require_meeting_url_and_token(monkeypatch, missing_group):
    _set_valid_production_env(monkeypatch)
    if missing_group == "meeting_url":
        for key in (
            "MEETING_SERVICE_BASE_URL",
            "MEETING_API_BASE_URL",
            "AUDIOMIND_MEETING_API_BASE_URL",
        ):
            monkeypatch.delenv(key, raising=False)
            monkeypatch.setenv(key, "")
    else:
        for key in ("INTERNAL_SERVICE_TOKEN", "GOOGLE_INTERNAL_SERVICE_TOKEN"):
            monkeypatch.delenv(key, raising=False)
            monkeypatch.setenv(key, "")
    get_settings.cache_clear()

    with pytest.raises((ValidationError, ValueError)) as raised:
        Settings(_env_file=None)

    message = str(raised.value).lower()
    if missing_group == "meeting_url":
        assert "meeting_service_base_url" in message
    else:
        assert "internal_service_token" in message

    get_settings.cache_clear()
