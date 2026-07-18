"""AI service DATABASE_URL startup: Alembic + SQLAlchemy against PostgreSQL."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
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


if not _docker_available():
    _msg = "Docker required for AI database startup test"
    if _REQUIRE:
        pytest.fail(_msg)
    pytest.skip(_msg, allow_module_level=True)

from testcontainers.postgres import PostgresContainer  # noqa: E402


@pytest.fixture(scope="module")
def postgres_url() -> str:
    with PostgresContainer("postgres:16-alpine") as postgres:
        # testcontainers returns postgresql+psycopg2:// by default in recent versions;
        # normalize to the scheme Settings / Alembic use in this repo.
        raw = postgres.get_connection_url()
        if raw.startswith("postgresql+psycopg2://"):
            url = "postgresql://" + raw[len("postgresql+psycopg2://") :]
        elif raw.startswith("postgresql+psycopg://"):
            url = "postgresql://" + raw[len("postgresql+psycopg://") :]
        else:
            url = raw
        yield url


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

    # Worker uses the same DATABASE_URL / Settings path.
    monkeypatch.setenv("APP_COMPONENT", "worker")
    get_settings.cache_clear()
    worker_settings = Settings(_env_file=None)
    assert worker_settings.database_url == postgres_url

    get_settings.cache_clear()


def test_jdbc_url_rejected_for_python_settings(monkeypatch):
    monkeypatch.setenv(
        "DATABASE_URL",
        "jdbc:postgresql://managed-db.test:5432/audiomind",
    )
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("APP_COMPONENT", "api")
    get_settings.cache_clear()
    settings = Settings(_env_file=None)
    # Settings accepts the string, but SQLAlchemy must not be given JDBC.
    assert settings.database_url.startswith("jdbc:")
    with pytest.raises(Exception):
        create_engine(settings.database_url).connect()
    get_settings.cache_clear()
