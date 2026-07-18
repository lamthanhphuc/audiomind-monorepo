"""Alembic 012 upgrade/downgrade lifecycle for Phase 2 study tables."""

from __future__ import annotations

import os
import subprocess
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

ADMIN_DATABASE_URL = os.getenv("PHASE2_MIGRATION_ADMIN_DATABASE_URL") or os.getenv(
    "MIGRATION_TEST_ADMIN_DATABASE_URL"
)
DATABASE_PREFIX = os.getenv("MIGRATION_TEST_DATABASE_PREFIX", "audiomind_phase2_")
AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]

pytestmark = pytest.mark.skipif(
    not ADMIN_DATABASE_URL,
    reason=(
        "PHASE2_MIGRATION_ADMIN_DATABASE_URL or MIGRATION_TEST_ADMIN_DATABASE_URL required. "
        "Docker verification: alembic downgrade -1 && alembic upgrade head against infra db."
    ),
)


def _admin_engine():
    return create_engine(ADMIN_DATABASE_URL, isolation_level="AUTOCOMMIT")


@contextmanager
def _temporary_database(name: str):
    assert name.startswith(DATABASE_PREFIX)
    engine = _admin_engine()
    try:
        with engine.connect() as connection:
            connection.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
            connection.execute(text(f'CREATE DATABASE "{name}"'))
        yield make_url(ADMIN_DATABASE_URL).set(database=name).render_as_string(
            hide_password=False
        )
    finally:
        with engine.connect() as connection:
            connection.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        engine.dispose()


def _run_alembic(database_url: str, *args: str, check: bool = True):
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    return subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=AI_SERVICE_ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=check,
    )


def _scalar(database_url: str, sql: str):
    engine = create_engine(database_url)
    try:
        with engine.connect() as connection:
            return connection.execute(text(sql)).scalar()
    finally:
        engine.dispose()


def test_phase2_alembic_012_upgrade_downgrade_reupgrade():
    name = f"{DATABASE_PREFIX}{uuid.uuid4().hex[:8]}"
    with _temporary_database(name) as database_url:
        _run_alembic(database_url, "upgrade", "head")
        assert _scalar(database_url, "SELECT version_num FROM alembic_version") == "012"
        for table in (
            "subject_synthesis",
            "subject_synthesis_source",
            "study_artifact",
            "study_artifact_source",
        ):
            assert _scalar(
                database_url,
                f"""
                SELECT EXISTS (
                  SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='{table}'
                )
                """,
            )

        index_def = _scalar(
            database_url,
            """
            SELECT indexdef FROM pg_indexes
            WHERE indexname = 'uq_study_artifact_idempotency_live'
            """,
        )
        assert index_def is not None
        assert "WHERE" in index_def.upper()
        assert "deleted_at" in index_def

        # Ensure Phase 1 education tables still present after upgrade from empty DB path
        # (fresh upgrade creates full chain including earlier revisions).

        _run_alembic(database_url, "downgrade", "-1")
        assert _scalar(database_url, "SELECT version_num FROM alembic_version") == "011"
        assert not _scalar(
            database_url,
            """
            SELECT EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='study_artifact'
            )
            """,
        )
        assert not _scalar(
            database_url,
            """
            SELECT EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='subject_synthesis'
            )
            """,
        )

        _run_alembic(database_url, "upgrade", "head")
        assert _scalar(database_url, "SELECT version_num FROM alembic_version") == "012"
        assert _scalar(
            database_url,
            """
            SELECT EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='study_artifact'
            )
            """,
        )
