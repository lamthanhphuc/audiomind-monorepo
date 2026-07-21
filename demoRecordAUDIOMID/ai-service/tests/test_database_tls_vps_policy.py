"""Production Settings: VPS private Postgres TLS policy vs managed TLS."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.config import Settings, get_settings


def _set_api_production_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_COMPONENT", "api")
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


def test_vps_private_postgres_tls_disable_passes(monkeypatch):
    _set_api_production_env(monkeypatch)
    monkeypatch.setenv("DEPLOYMENT_MODE", "vps")
    monkeypatch.setenv("DATABASE_TLS_MODE", "disable")
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://audiomind:p%40ss%3Aword@postgres:5432/audiomind",
    )
    get_settings.cache_clear()
    settings = Settings(_env_file=None)
    assert settings.deployment_mode == "vps"
    assert settings.database_tls_mode == "disable"
    get_settings.cache_clear()


def test_vps_tls_disable_rejects_remote_hostname(monkeypatch):
    _set_api_production_env(monkeypatch)
    monkeypatch.setenv("DEPLOYMENT_MODE", "vps")
    monkeypatch.setenv("DATABASE_TLS_MODE", "disable")
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://audiomind:secret@db.prod.internal:5432/audiomind",
    )
    get_settings.cache_clear()
    with pytest.raises((ValidationError, ValueError)) as raised:
        Settings(_env_file=None)
    assert (
        "allowlist" in str(raised.value).lower()
        or "database_tls" in str(raised.value).lower()
    )
    get_settings.cache_clear()


def test_vps_tls_disable_rejects_public_ip(monkeypatch):
    _set_api_production_env(monkeypatch)
    monkeypatch.setenv("DEPLOYMENT_MODE", "vps")
    monkeypatch.setenv("DATABASE_TLS_MODE", "disable")
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://audiomind:secret@8.8.8.8:5432/audiomind",
    )
    get_settings.cache_clear()
    with pytest.raises((ValidationError, ValueError)):
        Settings(_env_file=None)
    get_settings.cache_clear()


def test_managed_tls_disable_rejected(monkeypatch):
    _set_api_production_env(monkeypatch)
    monkeypatch.setenv("DEPLOYMENT_MODE", "managed")
    monkeypatch.setenv("DATABASE_TLS_MODE", "disable")
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://audiomind:secret@postgres:5432/audiomind",
    )
    get_settings.cache_clear()
    with pytest.raises((ValidationError, ValueError)) as raised:
        Settings(_env_file=None)
    assert "vps" in str(raised.value).lower()
    get_settings.cache_clear()


def test_managed_sslmode_require_passes(monkeypatch):
    _set_api_production_env(monkeypatch)
    monkeypatch.setenv("DEPLOYMENT_MODE", "managed")
    monkeypatch.setenv("DATABASE_TLS_MODE", "require")
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://audiomind:secure-pass@db.prod.internal:5432/audiomind?sslmode=require",
    )
    get_settings.cache_clear()
    settings = Settings(_env_file=None)
    assert "sslmode=require" in settings.database_url.lower()
    get_settings.cache_clear()


def test_managed_sslmode_verify_full_passes(monkeypatch):
    _set_api_production_env(monkeypatch)
    monkeypatch.setenv("DATABASE_TLS_MODE", "verify-full")
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://audiomind:secure-pass@db.prod.internal:5432/audiomind?sslmode=verify-full",
    )
    get_settings.cache_clear()
    settings = Settings(_env_file=None)
    assert "sslmode=verify-full" in settings.database_url.lower()
    get_settings.cache_clear()


def test_worker_vps_tls_disable_passes(monkeypatch):
    _set_api_production_env(monkeypatch)
    monkeypatch.setenv("APP_COMPONENT", "worker")
    monkeypatch.setenv("DEPLOYMENT_MODE", "vps")
    monkeypatch.setenv("DATABASE_TLS_MODE", "disable")
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://audiomind:secret@postgres:5432/audiomind",
    )
    get_settings.cache_clear()
    settings = Settings(_env_file=None)
    assert settings.app_component == "worker"
    get_settings.cache_clear()


def test_beat_ignores_database_tls_policy(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_COMPONENT", "beat")
    monkeypatch.setenv("CELERY_BROKER_URL", "redis://redis.prod.internal:6379/0")
    monkeypatch.setenv("CELERY_RESULT_BACKEND", "redis://redis.prod.internal:6379/1")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    get_settings.cache_clear()
    settings = Settings(_env_file=None)
    assert settings.app_component == "beat"
    get_settings.cache_clear()
