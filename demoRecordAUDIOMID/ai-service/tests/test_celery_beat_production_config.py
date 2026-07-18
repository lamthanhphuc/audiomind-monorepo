"""Production Settings validation is scoped by APP_COMPONENT (api/worker/beat)."""

from __future__ import annotations

import importlib

import pytest
from pydantic import ValidationError

from app.config import Settings, get_settings


def _set_beat_production_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Minimal Beat production env: broker URLs only (no Gemini/CORS/meeting)."""
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_COMPONENT", "beat")
    monkeypatch.setenv("CELERY_BROKER_URL", "redis://redis.prod.internal:6379/0")
    monkeypatch.setenv("CELERY_RESULT_BACKEND", "redis://redis.prod.internal:6379/1")
    # Intentionally leave Gemini / CORS / meeting URL / token unset or local-ish.
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEYS", raising=False)
    monkeypatch.delenv("AI_PROVIDER", raising=False)
    monkeypatch.delenv("ANALYSIS_PROVIDER", raising=False)
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173")
    for key in (
        "MEETING_SERVICE_BASE_URL",
        "MEETING_API_BASE_URL",
        "AUDIOMIND_MEETING_API_BASE_URL",
    ):
        monkeypatch.delenv(key, raising=False)
    for key in ("INTERNAL_SERVICE_TOKEN", "GOOGLE_INTERNAL_SERVICE_TOKEN"):
        monkeypatch.delenv(key, raising=False)


def _set_api_worker_production_env(
    monkeypatch: pytest.MonkeyPatch, *, component: str = "api"
) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_COMPONENT", component)
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://audiomind:secure-pass@db.prod.internal:5432/audiomind",
    )
    monkeypatch.setenv("CELERY_BROKER_URL", "redis://redis.prod.internal:6379/0")
    monkeypatch.setenv("CELERY_RESULT_BACKEND", "redis://redis.prod.internal:6379/1")
    monkeypatch.setenv("CELERY_STUDY_GENERATION_QUEUE", "study_generation")
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ollama-service:11434")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://app.example.com")
    monkeypatch.setenv("MEETING_SERVICE_BASE_URL", "http://meeting-api:8081")
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "phase2-prod-internal-token")
    monkeypatch.setenv("ANALYSIS_PROVIDER", "gemini")
    monkeypatch.setenv("AI_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key-not-empty")
    monkeypatch.setenv("ENABLE_SPEAKER_DIARIZATION", "false")


def test_beat_production_settings_pass_without_gemini_cors_or_meeting(monkeypatch):
    _set_beat_production_env(monkeypatch)
    get_settings.cache_clear()

    settings = Settings(_env_file=None)

    assert settings.app_component == "beat"
    assert (settings.app_env or "").strip().lower() == "production"
    assert not (settings.gemini_api_key or "").strip()
    assert "localhost" in (settings.cors_allowed_origins or "").lower()
    assert not (settings.meeting_service_base_url or "").strip()
    assert not (settings.internal_service_token or "").strip()

    get_settings.cache_clear()


def test_celery_app_loads_under_beat_production_settings(monkeypatch):
    _set_beat_production_env(monkeypatch)
    get_settings.cache_clear()

    settings = get_settings()
    assert settings.app_component == "beat"
    assert (settings.app_env or "").strip().lower() in {"prod", "production"}

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


@pytest.mark.parametrize("component", ("api", "worker"))
@pytest.mark.parametrize(
    "missing_group",
    ("meeting_url", "internal_token"),
)
def test_api_and_worker_production_require_meeting_url_and_token(
    monkeypatch, component, missing_group
):
    _set_api_worker_production_env(monkeypatch, component=component)
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


@pytest.mark.parametrize("component", ("api", "worker"))
def test_api_and_worker_production_require_gemini_when_provider_gemini(
    monkeypatch, component
):
    _set_api_worker_production_env(monkeypatch, component=component)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.delenv("GEMINI_API_KEYS", raising=False)
    monkeypatch.setenv("GEMINI_MULTI_KEY_ENABLED", "false")
    get_settings.cache_clear()

    with pytest.raises((ValidationError, ValueError)) as raised:
        Settings(_env_file=None)

    assert "gemini_api_key" in str(raised.value).lower()
    get_settings.cache_clear()


def test_api_production_rejects_localhost_cors(monkeypatch):
    _set_api_worker_production_env(monkeypatch, component="api")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173")
    get_settings.cache_clear()

    with pytest.raises((ValidationError, ValueError)) as raised:
        Settings(_env_file=None)

    assert "cors_allowed_origins" in str(raised.value).lower()
    get_settings.cache_clear()


def test_worker_production_allows_localhost_cors(monkeypatch):
    _set_api_worker_production_env(monkeypatch, component="worker")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173")
    get_settings.cache_clear()

    settings = Settings(_env_file=None)
    assert settings.app_component == "worker"
    assert "localhost" in settings.cors_allowed_origins.lower()
    get_settings.cache_clear()


def test_provider_conflict_raises_when_both_set_differently(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "ollama")
    monkeypatch.setenv("ANALYSIS_PROVIDER", "gemini")
    get_settings.cache_clear()

    with pytest.raises((ValidationError, ValueError)) as raised:
        Settings(_env_file=None)

    message = str(raised.value).lower()
    assert "conflict" in message
    assert "ai_provider" in message
    assert "analysis_provider" in message
    get_settings.cache_clear()


def test_analysis_provider_only_syncs_ai_provider(monkeypatch):
    monkeypatch.setenv("ANALYSIS_PROVIDER", "ollama")
    monkeypatch.delenv("AI_PROVIDER", raising=False)
    get_settings.cache_clear()

    settings = Settings(_env_file=None)
    assert settings.analysis_provider == "ollama"
    assert settings.ai_provider == "ollama"
    get_settings.cache_clear()
