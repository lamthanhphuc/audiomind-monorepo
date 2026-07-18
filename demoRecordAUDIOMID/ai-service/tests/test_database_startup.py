"""AI service DATABASE_URL startup: Alembic + SQLAlchemy against PostgreSQL."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, text

from app.config import Settings, get_settings

AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]

_REQUIRE = os.environ.get("REQUIRE_DATASOURCE_CONTEXT_TESTS", "").strip().lower() in {
    "1",
    "true",
    "yes",
}


def _docker_available() -> bool:
    try:
        result = subprocess.run(
            ["docker", "info"],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
        return result.returncode == 0
    except Exception:  # noqa: BLE001
        return False


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


def _settings_with_database_url(database_url: str) -> Settings:
    """Build Settings with a valid URL, then swap to the URL under test."""
    settings = Settings(
        _env_file=None,
        database_url="postgresql://audiomind:secret@db.prod.internal:5432/audiomind",
        app_env="development",
        app_component="api",
    )
    settings.database_url = database_url
    return settings


def _run_alembic(database_url: str, *args: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    return subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=AI_SERVICE_ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


@pytest.mark.parametrize(
    "database_url",
    (
        "postgresql://audiomind:secret@db.prod.internal:5432/audiomind",
        "postgresql+psycopg2://audiomind:secret@db.prod.internal:5432/audiomind",
    ),
)
def test_validate_database_url_scheme_accepts_postgresql_urls(database_url: str):
    settings = _settings_with_database_url(database_url)
    settings.validate_database_url_scheme()
    assert settings.database_url == database_url


@pytest.mark.parametrize(
    "database_url,needle",
    (
        (
            "jdbc:postgresql://managed-db.test:5432/audiomind",
            "jdbc scheme is not supported",
        ),
        (
            "postgresql+psycopg://managed-db.test:5432/audiomind",
            "postgresql+psycopg://",
        ),
        (
            "postgresql+asyncpg://managed-db.test:5432/audiomind",
            "postgresql+asyncpg://",
        ),
    ),
)
def test_validate_database_url_scheme_rejects_unsupported_urls(
    database_url: str, needle: str
):
    settings = _settings_with_database_url(database_url)
    with pytest.raises(ValueError) as raised:
        settings.validate_database_url_scheme()

    assert needle.lower() in str(raised.value).lower()


def test_jdbc_url_rejected_for_python_settings(monkeypatch):
    monkeypatch.setenv(
        "DATABASE_URL",
        "jdbc:postgresql://managed-db.test:5432/audiomind",
    )
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("APP_COMPONENT", "api")
    get_settings.cache_clear()

    with pytest.raises((ValidationError, ValueError)) as raised:
        Settings(_env_file=None)

    message = str(raised.value).lower()
    assert "jdbc" in message
    get_settings.cache_clear()


def test_production_database_url_without_sslmode_fails(monkeypatch):
    _set_api_production_env(monkeypatch)
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://audiomind:secure-pass@db.prod.internal:5432/audiomind",
    )
    get_settings.cache_clear()

    with pytest.raises((ValidationError, ValueError)) as raised:
        Settings(_env_file=None)

    assert "sslmode" in str(raised.value).lower()
    get_settings.cache_clear()


def test_production_database_url_with_sslmode_passes(monkeypatch):
    _set_api_production_env(monkeypatch)
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://audiomind:secure-pass@db.prod.internal:5432/audiomind?sslmode=require",
    )
    get_settings.cache_clear()

    settings = Settings(_env_file=None)
    assert "sslmode=require" in settings.database_url.lower()

    get_settings.cache_clear()


@pytest.fixture(scope="module")
def postgres_url():
    if not _docker_available():
        _msg = "Docker required for AI database startup test"
        if _REQUIRE:
            pytest.fail(_msg)
        pytest.skip(_msg)

    from testcontainers.postgres import PostgresContainer

    with PostgresContainer("postgres:16-alpine") as postgres:
        raw = postgres.get_connection_url()
        if raw.startswith("postgresql+psycopg2://"):
            url = "postgresql://" + raw[len("postgresql+psycopg2://") :]
        elif raw.startswith("postgresql+psycopg://"):
            url = "postgresql://" + raw[len("postgresql+psycopg://") :]
        else:
            url = raw
        yield url


def test_ai_database_url_settings_alembic_and_sqlalchemy(postgres_url: str, monkeypatch):
    assert postgres_url.startswith("postgresql://")
    assert not postgres_url.startswith("jdbc:")

    monkeypatch.setenv("DATABASE_URL", postgres_url)
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("APP_COMPONENT", "api")
    get_settings.cache_clear()
    settings = Settings(_env_file=None)
    assert settings.database_url.startswith("postgresql://")

    upgrade = _run_alembic(postgres_url, "upgrade", "head")
    assert upgrade.returncode == 0, upgrade.stderr or upgrade.stdout

    engine = create_engine(postgres_url)
    try:
        with engine.connect() as connection:
            version = connection.execute(text("SELECT version_num FROM alembic_version")).scalar()
            assert version is not None
            connection.execute(text("SELECT 1")).scalar()
    finally:
        engine.dispose()

    monkeypatch.setenv("APP_COMPONENT", "worker")
    get_settings.cache_clear()
    worker_settings = Settings(_env_file=None)
    assert worker_settings.database_url == postgres_url

    get_settings.cache_clear()
