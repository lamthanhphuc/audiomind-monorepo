"""Cross-service migration order: user Flyway → meeting Flyway → AI Alembic."""

from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from testcontainers.core.network import Network
from testcontainers.postgres import PostgresContainer

REPO_ROOT = Path(__file__).resolve().parents[3]
AI_SERVICE_ROOT = REPO_ROOT / "demoRecordAUDIOMID" / "ai-service"
USER_SQL_DIR = (
    REPO_ROOT
    / "demoRecordAUDIOMID"
    / "user-service"
    / "src"
    / "main"
    / "resources"
    / "db"
    / "migration"
)
MEETING_SQL_DIR = (
    REPO_ROOT
    / "demoRecordAUDIOMID"
    / "meeting-service"
    / "src"
    / "main"
    / "resources"
    / "db"
    / "migration"
)

AI_ALEMBIC_HEAD = "015"
FLYWAY_IMAGE = "flyway/flyway:10"
FLYWAY_HOST = "postgres"
FLYWAY_PORT = 5432

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
    _msg = "Docker required for migration order integration tests"
    if _REQUIRE:
        pytest.fail(_msg)
    pytest.skip(_msg, allow_module_level=True)


@dataclass(frozen=True)
class PostgresTarget:
    host: str
    port: int
    database: str
    username: str
    password: str
    network: str

    @property
    def jdbc_url(self) -> str:
        return f"jdbc:postgresql://{self.host}:{self.port}/{self.database}"

    @property
    def sqlalchemy_url(self) -> str:
        return (
            f"postgresql://{self.username}:{self.password}"
            f"@{self.host}:{self.port}/{self.database}"
        )


def _docker_volume_mount(local_dir: Path) -> str:
    """Return a Docker Desktop–friendly bind source path (notably on Windows)."""
    resolved = local_dir.resolve()
    if os.name == "nt":
        return resolved.as_posix()
    return str(resolved)


def _run_flyway(
    sql_dir: Path | None,
    target: PostgresTarget,
    *,
    history_table: str,
    command: str = "migrate",
    extra_args: tuple[str, ...] = (),
) -> subprocess.CompletedProcess[str]:
    cmd = [
        "docker",
        "run",
        "--rm",
        "--network",
        target.network,
    ]
    if sql_dir is not None:
        mount = _docker_volume_mount(sql_dir)
        cmd.extend(["-v", f"{mount}:/flyway/sql:ro"])
    cmd.extend(
        [
            FLYWAY_IMAGE,
            f"-url={target.jdbc_url}",
            f"-user={target.username}",
            f"-password={target.password}",
            f"-table={history_table}",
            "-connectRetries=20",
            command,
            *extra_args,
        ]
    )
    return subprocess.run(cmd, text=True, capture_output=True, check=False)


def _run_flyway_baseline(target: PostgresTarget, *, history_table: str) -> None:
    result = _run_flyway(
        None,
        target,
        history_table=history_table,
        command="baseline",
        extra_args=(
            "-baselineVersion=0",
            "-baselineDescription=Empty database bootstrap",
        ),
    )
    assert result.returncode == 0, result.stderr or result.stdout


def _bootstrap_empty_schema_histories(target: PostgresTarget) -> None:
    """Match infra/docker/flyway/db-flyway-bootstrap.sh on an empty public schema."""
    _run_flyway_baseline(target, history_table="flyway_schema_history_user")
    _run_flyway_baseline(target, history_table="flyway_schema_history_meeting")


def _baseline_user_history_on_shared_schema(target: PostgresTarget) -> None:
    """Allow user Flyway to start after meeting partial migration on a shared DB."""
    _run_flyway_baseline(target, history_table="flyway_schema_history_user")


def _run_alembic(database_url: str, *args: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env.setdefault("APP_ENV", "development")
    env.setdefault("APP_COMPONENT", "api")
    return subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=AI_SERVICE_ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def _normalize_sqlalchemy_url(raw: str) -> str:
    if raw.startswith("postgresql+psycopg2://"):
        return "postgresql://" + raw[len("postgresql+psycopg2://") :]
    if raw.startswith("postgresql+psycopg://"):
        return "postgresql://" + raw[len("postgresql+psycopg://") :]
    return raw


def _reset_public_schema(database_url: str) -> None:
    engine = create_engine(database_url)
    try:
        with engine.begin() as connection:
            connection.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
            connection.execute(text("CREATE SCHEMA public"))
            connection.execute(text("GRANT ALL ON SCHEMA public TO PUBLIC"))
    finally:
        engine.dispose()


def _flyway_all_success(engine_url: str, history_table: str) -> bool:
    engine = create_engine(engine_url)
    try:
        with engine.connect() as connection:
            regclass = connection.execute(
                text("SELECT to_regclass(:name)"),
                {"name": f"public.{history_table}"},
            ).scalar()
            if not regclass:
                return False
            return bool(
                connection.execute(
                    text(
                        f"SELECT bool_and(success) FROM public.{history_table}"
                    )
                ).scalar()
            )
    finally:
        engine.dispose()


@pytest.fixture(scope="module")
def migration_network() -> Network:
    with Network() as network:
        yield network


@pytest.fixture(scope="module")
def postgres(migration_network: Network) -> PostgresContainer:
    with (
        PostgresContainer("postgres:16-alpine")
        .with_network(migration_network)
        .with_network_aliases(FLYWAY_HOST)
    ) as container:
        yield container


@pytest.fixture(scope="module")
def postgres_url(postgres: PostgresContainer) -> str:
    return _normalize_sqlalchemy_url(postgres.get_connection_url())


@pytest.fixture(scope="module")
def postgres_target(migration_network: Network, postgres: PostgresContainer) -> PostgresTarget:
    return PostgresTarget(
        host=FLYWAY_HOST,
        port=FLYWAY_PORT,
        database=postgres.dbname,
        username=postgres.username,
        password=postgres.password,
        network=migration_network.name,
    )


def test_ordered_user_meeting_ai_migrations_pass(
    postgres_url: str, postgres_target: PostgresTarget
) -> None:
    _reset_public_schema(postgres_url)
    _bootstrap_empty_schema_histories(postgres_target)

    user = _run_flyway(
        USER_SQL_DIR,
        postgres_target,
        history_table="flyway_schema_history_user",
    )
    assert user.returncode == 0, user.stderr or user.stdout

    meeting = _run_flyway(
        MEETING_SQL_DIR,
        postgres_target,
        history_table="flyway_schema_history_meeting",
    )
    assert meeting.returncode == 0, meeting.stderr or meeting.stdout

    alembic = _run_alembic(postgres_url, "upgrade", "head")
    assert alembic.returncode == 0, alembic.stderr or alembic.stdout

    engine = create_engine(postgres_url)
    try:
        with engine.connect() as connection:
            app_users = connection.execute(
                text("SELECT to_regclass('public.app_users')")
            ).scalar()
            assert app_users == "app_users"

            meeting_table = connection.execute(
                text("SELECT to_regclass('public.meeting')")
            ).scalar()
            assert meeting_table == "meeting"

            fk_count = connection.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM pg_constraint c
                    JOIN pg_namespace n ON n.oid = c.connamespace
                    WHERE n.nspname = 'public'
                      AND c.conname = 'fk_meeting_owner_user'
                    """
                )
            ).scalar()
            assert int(fk_count or 0) == 1

            alembic_version = connection.execute(
                text("SELECT version_num FROM alembic_version LIMIT 1")
            ).scalar()
            assert str(alembic_version) == AI_ALEMBIC_HEAD
    finally:
        engine.dispose()

    assert _flyway_all_success(postgres_url, "flyway_schema_history_user")
    assert _flyway_all_success(postgres_url, "flyway_schema_history_meeting")


def test_meeting_before_user_fails_then_retry_passes(
    postgres_url: str, postgres_target: PostgresTarget
) -> None:
    _reset_public_schema(postgres_url)

    meeting_first = _run_flyway(
        MEETING_SQL_DIR,
        postgres_target,
        history_table="flyway_schema_history_meeting",
    )
    assert meeting_first.returncode != 0
    combined = f"{meeting_first.stdout}\n{meeting_first.stderr}".lower()
    assert "app_users" in combined or "v15" in combined

    engine = create_engine(postgres_url)
    try:
        with engine.connect() as connection:
            assert connection.execute(
                text("SELECT to_regclass('public.app_users')")
            ).scalar() is None
            user_history = connection.execute(
                text("SELECT to_regclass('public.flyway_schema_history_user')")
            ).scalar()
            assert user_history is None

            meeting_history = connection.execute(
                text("SELECT to_regclass('public.flyway_schema_history_meeting')")
            ).scalar()
            assert meeting_history is not None

            v15_applied = connection.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM flyway_schema_history_meeting
                    WHERE version = '15' AND success = true
                    """
                )
            ).scalar()
            assert int(v15_applied or 0) == 0
    finally:
        engine.dispose()

    _baseline_user_history_on_shared_schema(postgres_target)

    user = _run_flyway(
        USER_SQL_DIR,
        postgres_target,
        history_table="flyway_schema_history_user",
    )
    assert user.returncode == 0, user.stderr or user.stdout

    meeting_retry = _run_flyway(
        MEETING_SQL_DIR,
        postgres_target,
        history_table="flyway_schema_history_meeting",
    )
    assert meeting_retry.returncode == 0, meeting_retry.stderr or meeting_retry.stdout

    engine = create_engine(postgres_url)
    try:
        with engine.connect() as connection:
            assert connection.execute(
                text("SELECT to_regclass('public.app_users')")
            ).scalar() == "app_users"

            v1_success, v1_script = connection.execute(
                text(
                    """
                    SELECT success, script
                    FROM flyway_schema_history_user
                    WHERE version = '1'
                    LIMIT 1
                    """
                )
            ).one()
            assert v1_success is True
            assert "V1__create_user_table.sql" in str(v1_script)

            assert connection.execute(
                text("SELECT to_regclass('public.meeting')")
            ).scalar() == "meeting"
    finally:
        engine.dispose()

    assert _flyway_all_success(postgres_url, "flyway_schema_history_user")
    assert _flyway_all_success(postgres_url, "flyway_schema_history_meeting")
