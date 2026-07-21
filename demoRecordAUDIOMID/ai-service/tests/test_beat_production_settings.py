"""Beat component must start in production without DATABASE_URL / provider secrets."""

from __future__ import annotations


import pytest


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    from app.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_production_beat_skips_database_provider_validation(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_COMPONENT", "beat")
    monkeypatch.setenv("CELERY_BROKER_URL", "redis://redis:6379/0")
    monkeypatch.setenv("CELERY_RESULT_BACKEND", "redis://redis:6379/1")
    monkeypatch.setenv("JOB_STATE_REDIS_URL", "redis://redis:6379/2")
    # Explicitly ensure secrets are absent (compose beat contract).
    for key in (
        "DATABASE_URL",
        "GEMINI_API_KEY",
        "GEMINI_API_KEYS",
        "DEEPGRAM_API_KEY",
        "MEETING_SERVICE_BASE_URL",
        "INTERNAL_SERVICE_TOKEN",
        "JWT_SECRET",
        "HUGGINGFACE_TOKEN",
    ):
        monkeypatch.delenv(key, raising=False)

    from app.config import Settings

    settings = Settings(_env_file=None)
    assert settings.app_component == "beat"
    assert settings.app_env == "production"
