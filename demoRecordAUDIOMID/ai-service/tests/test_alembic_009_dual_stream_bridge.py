import os
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

ADMIN_DATABASE_URL = os.getenv("MIGRATION_TEST_ADMIN_DATABASE_URL")
DATABASE_PREFIX = os.getenv("MIGRATION_TEST_DATABASE_PREFIX", "audiomind_phase1c_")
AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]

pytestmark = pytest.mark.skipif(
    not ADMIN_DATABASE_URL,
    reason="MIGRATION_TEST_ADMIN_DATABASE_URL is required for Alembic bridge tests",
)


def _assert_disposable_database_name(name: str) -> None:
    assert name.startswith("audiomind_phase1c_")


def _database_url(database_name: str) -> str:
    admin_url = make_url(ADMIN_DATABASE_URL)
    return admin_url.set(database=database_name).render_as_string(hide_password=False)


def _admin_engine():
    return create_engine(ADMIN_DATABASE_URL, isolation_level="AUTOCOMMIT")


@contextmanager
def _temporary_database(name: str):
    _assert_disposable_database_name(name)
    engine = _admin_engine()
    try:
        with engine.connect() as connection:
            connection.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
            connection.execute(text(f'CREATE DATABASE "{name}"'))
        yield _database_url(name)
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


def _engine(database_url: str):
    return create_engine(database_url)


def _scalar(database_url: str, sql: str):
    engine = _engine(database_url)
    try:
        with engine.connect() as connection:
            return connection.execute(text(sql)).scalar()
    finally:
        engine.dispose()


def _rows(database_url: str, sql: str):
    engine = _engine(database_url)
    try:
        with engine.connect() as connection:
            return connection.execute(text(sql)).mappings().all()
    finally:
        engine.dispose()


def _execute(database_url: str, sql: str) -> None:
    engine = _engine(database_url)
    try:
        with engine.begin() as connection:
            for statement in sql.split(";"):
                if statement.strip():
                    connection.execute(text(statement))
    finally:
        engine.dispose()


def _create_revision_004_style_schema(database_url: str) -> None:
    _execute(
        database_url,
        """
        CREATE TABLE transcripts (
            id SERIAL PRIMARY KEY,
            meeting_id INTEGER NOT NULL
        );
        CREATE TABLE analysis (
            id SERIAL PRIMARY KEY,
            meeting_id INTEGER NOT NULL UNIQUE
        );
        CREATE TABLE transcript_fragments (
            id SERIAL PRIMARY KEY,
            meeting_id BIGINT NOT NULL,
            seq INTEGER NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            event_id VARCHAR(64),
            speaker VARCHAR(50),
            start_time DOUBLE PRECISION,
            end_time DOUBLE PRECISION,
            text TEXT,
            normalized_text VARCHAR(2048) NOT NULL,
            is_final BOOLEAN NOT NULL DEFAULT FALSE,
            confidence DOUBLE PRECISION,
            dedupe_key VARCHAR(128) NOT NULL UNIQUE,
            created_at TIMESTAMP NOT NULL
        );
        CREATE INDEX ix_transcript_fragments_meeting_id
            ON transcript_fragments (meeting_id);
        CREATE INDEX ix_transcript_fragments_seq ON transcript_fragments (seq);
        CREATE TABLE transcript_checkpoints (
            meeting_id BIGINT PRIMARY KEY,
            last_ack_seq INTEGER NOT NULL DEFAULT 0,
            last_persisted_seq INTEGER NOT NULL DEFAULT 0,
            last_finalized_seq INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL
        );
        INSERT INTO transcript_fragments (
            meeting_id, seq, version, text, normalized_text, is_final, dedupe_key, created_at
        ) VALUES (101, 1, 1, 'legacy text', 'legacy text', TRUE, 'legacy-101', NOW());
        INSERT INTO transcript_checkpoints (
            meeting_id, last_ack_seq, last_persisted_seq, last_finalized_seq, updated_at
        ) VALUES (101, 1, 1, 1, NOW());
        """,
    )


def _create_baseline_c_schema(
    database_url: str,
    stream_length: int = 8,
    stream_default: str | None = None,
    bridge_index: bool = False,
) -> None:
    default_clause = (
        f" DEFAULT '{stream_default}'" if stream_default is not None else ""
    )
    _execute(
        database_url,
        f"""
        CREATE TABLE transcripts (
            id SERIAL PRIMARY KEY,
            meeting_id BIGINT NOT NULL
        );
        CREATE TABLE analysis (
            id SERIAL PRIMARY KEY,
            meeting_id BIGINT NOT NULL UNIQUE
        );
        CREATE TABLE transcript_fragments (
            id SERIAL PRIMARY KEY,
            meeting_id BIGINT NOT NULL,
            stream_id VARCHAR({stream_length}){default_clause} NOT NULL,
            seq INTEGER NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            event_id VARCHAR(64),
            speaker VARCHAR(50),
            start_time DOUBLE PRECISION,
            end_time DOUBLE PRECISION,
            text TEXT,
            normalized_text VARCHAR(2048) NOT NULL,
            is_final BOOLEAN NOT NULL DEFAULT FALSE,
            confidence DOUBLE PRECISION,
            dedupe_key VARCHAR(128) NOT NULL UNIQUE,
            created_at TIMESTAMP NOT NULL
        );
        CREATE INDEX ix_transcript_fragments_stream_id
            ON transcript_fragments (stream_id);
        {"CREATE INDEX ix_transcript_fragments_meeting_stream_seq ON transcript_fragments (meeting_id, stream_id, seq);" if bridge_index else ""}
        CREATE TABLE transcript_checkpoints (
            meeting_id BIGINT NOT NULL,
            stream_id VARCHAR({stream_length}){default_clause} NOT NULL,
            last_ack_seq INTEGER NOT NULL DEFAULT 0,
            last_persisted_seq INTEGER NOT NULL DEFAULT 0,
            last_finalized_seq INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL,
            PRIMARY KEY (meeting_id, stream_id)
        );
        INSERT INTO transcript_fragments (
            meeting_id, stream_id, seq, version, text, normalized_text,
            is_final, dedupe_key, created_at
        ) VALUES (202, '', 1, 1, 'legacy text', 'legacy text', TRUE, 'legacy-202', NOW());
        INSERT INTO transcript_checkpoints (
            meeting_id, stream_id, last_ack_seq, last_persisted_seq,
            last_finalized_seq, updated_at
        ) VALUES (202, '', 1, 1, 1, NOW());
        """,
    )


def _create_minimal_required_schema(
    database_url: str,
    include_fragments: bool = True,
    fragment_columns: str = "meeting_id BIGINT NOT NULL, seq INTEGER NOT NULL",
    checkpoint_pk: str = "PRIMARY KEY (meeting_id)",
) -> None:
    fragments_sql = (
        f"""
        CREATE TABLE transcript_fragments (
            id SERIAL PRIMARY KEY,
            {fragment_columns}
        );
        """
        if include_fragments
        else ""
    )
    _execute(
        database_url,
        f"""
        CREATE TABLE transcripts (
            id SERIAL PRIMARY KEY,
            meeting_id INTEGER NOT NULL
        );
        CREATE TABLE analysis (
            id SERIAL PRIMARY KEY,
            meeting_id INTEGER NOT NULL UNIQUE
        );
        {fragments_sql}
        CREATE TABLE transcript_checkpoints (
            meeting_id BIGINT NOT NULL,
            last_ack_seq INTEGER NOT NULL DEFAULT 0,
            last_persisted_seq INTEGER NOT NULL DEFAULT 0,
            last_finalized_seq INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL,
            {checkpoint_pk}
        );
        """,
    )


def _create_unexpected_checkpoint_pk_schema(database_url: str) -> None:
    _create_baseline_c_schema(database_url)
    _execute(
        database_url,
        """
        ALTER TABLE transcript_checkpoints DROP CONSTRAINT transcript_checkpoints_pkey;
        ALTER TABLE transcript_checkpoints
            ADD CONSTRAINT transcript_checkpoints_pkey
            PRIMARY KEY (meeting_id, last_ack_seq);
        """,
    )


def _checkpoint_pk_columns(database_url: str) -> list[str]:
    rows = _rows(
        database_url,
        """
        SELECT a.attname AS column_name
        FROM pg_constraint c
        JOIN unnest(c.conkey) WITH ORDINALITY AS cols(attnum, ord) ON TRUE
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = cols.attnum
        WHERE c.conrelid = 'public.transcript_checkpoints'::regclass
          AND c.contype = 'p'
        ORDER BY cols.ord
        """,
    )
    return [row["column_name"] for row in rows]


def _column_exists(database_url: str, table: str, column: str) -> bool:
    return bool(
        _scalar(
            database_url,
            f"""
            SELECT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = '{table}'
                  AND column_name = '{column}'
            )
            """,
        )
    )


def _table_exists(database_url: str, table: str) -> bool:
    return bool(
        _scalar(
            database_url,
            f"""
            SELECT EXISTS (
                SELECT 1
                FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_name = '{table}'
            )
            """,
        )
    )


def _stream_length(database_url: str, table: str) -> int | None:
    return _scalar(
        database_url,
        f"""
        SELECT character_maximum_length
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = '{table}'
          AND column_name = 'stream_id'
        """,
    )


def _column_default(database_url: str, table: str, column: str) -> str | None:
    return _scalar(
        database_url,
        f"""
        SELECT column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = '{table}'
          AND column_name = '{column}'
        """,
    )


def _column_data_type(database_url: str, table: str, column: str) -> str | None:
    return _scalar(
        database_url,
        f"""
        SELECT data_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = '{table}'
          AND column_name = '{column}'
        """,
    )


def _index_definition(database_url: str, table: str, index_name: str):
    rows = _rows(
        database_url,
        f"""
        SELECT i.relname AS index_name,
               ix.indisunique AS is_unique,
               array_agg(a.attname ORDER BY ord.ordinality) AS columns
        FROM pg_class t
        JOIN pg_index ix ON ix.indrelid = t.oid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN unnest(ix.indkey) WITH ORDINALITY AS ord(attnum, ordinality) ON TRUE
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ord.attnum
        WHERE t.relname = '{table}'
          AND i.relname = '{index_name}'
        GROUP BY i.relname, ix.indisunique
        """,
    )
    if not rows:
        return None
    return {"columns": list(rows[0]["columns"]), "unique": bool(rows[0]["is_unique"])}


def _table_columns(database_url: str, table: str) -> list[str]:
    rows = _rows(
        database_url,
        f"""
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = '{table}'
        ORDER BY ordinal_position
        """,
    )
    return [row["column_name"] for row in rows]


def _primary_key_columns(database_url: str, table: str) -> list[str]:
    rows = _rows(
        database_url,
        f"""
        SELECT a.attname AS column_name
        FROM pg_constraint c
        JOIN unnest(c.conkey) WITH ORDINALITY AS cols(attnum, ord) ON TRUE
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = cols.attnum
        WHERE c.conrelid = 'public.{table}'::regclass
          AND c.contype = 'p'
        ORDER BY cols.ord
        """,
    )
    return [row["column_name"] for row in rows]


def test_fresh_database_reaches_revision_010_successfully():
    with _temporary_database(f"{DATABASE_PREFIX}fresh") as database_url:
        _run_alembic(database_url, "upgrade", "head")

        assert _scalar(database_url, "SELECT version_num FROM alembic_version") == "010"
        assert (
            _scalar(
                database_url,
                "SELECT data_type FROM information_schema.columns "
                "WHERE table_name='transcripts' AND column_name='meeting_id'",
            )
            == "bigint"
        )
        assert _column_exists(database_url, "transcript_fragments", "stream_id")
        assert _column_exists(database_url, "transcript_checkpoints", "stream_id")
        assert _checkpoint_pk_columns(database_url) == ["meeting_id", "stream_id"]
        assert _column_default(
            database_url, "transcript_fragments", "stream_id"
        ).startswith("''")
        assert _column_default(
            database_url, "transcript_checkpoints", "stream_id"
        ).startswith("''")
        assert _index_definition(
            database_url,
            "transcript_fragments",
            "ix_transcript_fragments_stream_id",
        ) == {"columns": ["stream_id"], "unique": False}
        assert _index_definition(
            database_url,
            "transcript_fragments",
            "ix_transcript_fragments_meeting_stream_seq",
        ) == {"columns": ["meeting_id", "stream_id", "seq"], "unique": False}
        assert _column_exists(
            database_url, "transcript_fragments", "recording_session_id"
        )
        assert _column_exists(database_url, "transcript_fragments", "attempt_id")
        assert (
            _column_data_type(
                database_url, "transcript_fragments", "recording_session_id"
            )
            == "bigint"
        )
        assert (
            _column_data_type(database_url, "transcript_fragments", "attempt_id")
            == "bigint"
        )
        assert _table_exists(database_url, "transcript_attempt_checkpoints")
        assert _primary_key_columns(database_url, "transcript_attempt_checkpoints") == [
            "meeting_id",
            "recording_session_id",
            "attempt_id",
            "stream_id",
        ]
        assert _index_definition(
            database_url,
            "transcript_fragments",
            "ix_transcript_fragments_v2_event_identity",
        ) == {
            "columns": [
                "meeting_id",
                "recording_session_id",
                "attempt_id",
                "stream_id",
                "seq",
            ],
            "unique": False,
        }
        assert _index_definition(
            database_url,
            "transcript_attempt_checkpoints",
            "ix_transcript_attempt_checkpoints_meeting_session_stream",
        ) == {
            "columns": ["meeting_id", "recording_session_id", "stream_id"],
            "unique": False,
        }


def test_revision_004_style_checkpoint_schema_upgrades_to_composite_pk():
    with _temporary_database(f"{DATABASE_PREFIX}rev004") as database_url:
        _create_revision_004_style_schema(database_url)
        _run_alembic(database_url, "stamp", "008")
        _run_alembic(database_url, "upgrade", "head")

        assert _checkpoint_pk_columns(database_url) == ["meeting_id", "stream_id"]
        assert _scalar(database_url, "SELECT stream_id FROM transcript_fragments") == ""
        assert (
            _scalar(database_url, "SELECT stream_id FROM transcript_checkpoints") == ""
        )
        assert _scalar(database_url, "SELECT COUNT(*) FROM transcript_fragments") == 1
        assert _scalar(database_url, "SELECT COUNT(*) FROM transcript_checkpoints") == 1


def test_baseline_c_adoption_preserves_composite_pk_and_legacy_rows():
    with _temporary_database(f"{DATABASE_PREFIX}baselinec") as database_url:
        _create_baseline_c_schema(database_url)
        _run_alembic(database_url, "stamp", "008")
        _run_alembic(database_url, "upgrade", "head")

        assert _checkpoint_pk_columns(database_url) == ["meeting_id", "stream_id"]
        assert _scalar(database_url, "SELECT stream_id FROM transcript_fragments") == ""
        assert (
            _scalar(database_url, "SELECT stream_id FROM transcript_checkpoints") == ""
        )
        assert _scalar(
            database_url,
            "SELECT recording_session_id IS NULL AND attempt_id IS NULL "
            "FROM transcript_fragments",
        )
        assert _column_exists(
            database_url, "transcript_fragments", "recording_session_id"
        )
        assert _column_exists(database_url, "transcript_fragments", "attempt_id")


def test_missing_required_table_fails_before_stream_id_is_added():
    with _temporary_database(f"{DATABASE_PREFIX}missingtable") as database_url:
        _create_minimal_required_schema(database_url, include_fragments=False)
        _run_alembic(database_url, "stamp", "008")
        result = _run_alembic(database_url, "upgrade", "head", check=False)

        assert result.returncode != 0
        assert "Required table 'transcript_fragments' is missing" in (
            result.stderr + result.stdout
        )
        assert not _column_exists(database_url, "transcript_checkpoints", "stream_id")


def test_missing_required_meeting_id_fails_before_mutation():
    with _temporary_database(f"{DATABASE_PREFIX}missingcol") as database_url:
        _create_minimal_required_schema(
            database_url,
            fragment_columns="seq INTEGER NOT NULL",
        )
        _run_alembic(database_url, "stamp", "008")
        result = _run_alembic(database_url, "upgrade", "head", check=False)

        assert result.returncode != 0
        assert "Required column transcript_fragments.meeting_id is missing" in (
            result.stderr + result.stdout
        )
        assert not _column_exists(database_url, "transcript_fragments", "stream_id")
        assert not _column_exists(database_url, "transcript_checkpoints", "stream_id")


def test_unexpected_checkpoint_primary_key_without_stream_id_fails_before_mutation():
    with _temporary_database(f"{DATABASE_PREFIX}badpkold") as database_url:
        _create_minimal_required_schema(
            database_url,
            checkpoint_pk="PRIMARY KEY (meeting_id, last_ack_seq)",
        )
        _run_alembic(database_url, "stamp", "008")
        result = _run_alembic(database_url, "upgrade", "head", check=False)

        assert result.returncode != 0
        assert "unexpected primary key" in (result.stderr + result.stdout)
        assert not _column_exists(database_url, "transcript_fragments", "stream_id")
        assert not _column_exists(database_url, "transcript_checkpoints", "stream_id")


def test_unexpected_checkpoint_primary_key_shape_fails_safely():
    with _temporary_database(f"{DATABASE_PREFIX}badpk") as database_url:
        _create_unexpected_checkpoint_pk_schema(database_url)
        _run_alembic(database_url, "stamp", "008")
        result = _run_alembic(database_url, "upgrade", "head", check=False)

        assert result.returncode != 0
        assert "unexpected primary key" in (result.stderr + result.stdout)
        assert _checkpoint_pk_columns(database_url) == ["meeting_id", "last_ack_seq"]


def test_existing_stream_id_type_is_not_narrowed():
    with _temporary_database(f"{DATABASE_PREFIX}wide") as database_url:
        _create_baseline_c_schema(database_url, stream_length=32)
        _run_alembic(database_url, "stamp", "008")
        _run_alembic(database_url, "upgrade", "head")

        assert _stream_length(database_url, "transcript_fragments") == 32
        assert _stream_length(database_url, "transcript_checkpoints") == 32


def test_incorrect_stream_id_default_is_corrected_to_empty_string():
    with _temporary_database(f"{DATABASE_PREFIX}defaultfix") as database_url:
        _create_baseline_c_schema(database_url, stream_default="default")
        _run_alembic(database_url, "stamp", "008")
        _run_alembic(database_url, "upgrade", "head")

        assert _column_default(
            database_url, "transcript_fragments", "stream_id"
        ).startswith("''")
        assert _column_default(
            database_url, "transcript_checkpoints", "stream_id"
        ).startswith("''")
        assert _scalar(database_url, "SELECT stream_id FROM transcript_fragments") == ""
        assert (
            _scalar(database_url, "SELECT stream_id FROM transcript_checkpoints") == ""
        )


def test_incompatible_preexisting_index_fails_safely():
    with _temporary_database(f"{DATABASE_PREFIX}badindex") as database_url:
        _create_baseline_c_schema(database_url)
        _execute(
            database_url,
            """
            DROP INDEX ix_transcript_fragments_stream_id;
            CREATE UNIQUE INDEX ix_transcript_fragments_stream_id
                ON transcript_fragments (seq);
            """,
        )
        _run_alembic(database_url, "stamp", "008")
        result = _run_alembic(database_url, "upgrade", "head", check=False)

        assert result.returncode != 0
        assert "ix_transcript_fragments_stream_id has unexpected definition" in (
            result.stderr + result.stdout
        )
        assert _index_definition(
            database_url,
            "transcript_fragments",
            "ix_transcript_fragments_stream_id",
        ) == {"columns": ["seq"], "unique": True}


def test_incompatible_preexisting_bridge_index_fails_safely():
    with _temporary_database(f"{DATABASE_PREFIX}badbridgeindex") as database_url:
        _create_baseline_c_schema(database_url)
        _execute(
            database_url,
            """
            CREATE UNIQUE INDEX ix_transcript_fragments_meeting_stream_seq
                ON transcript_fragments (meeting_id, seq);
            """,
        )
        _run_alembic(database_url, "stamp", "008")
        result = _run_alembic(database_url, "upgrade", "head", check=False)

        assert result.returncode != 0
        assert (
            "ix_transcript_fragments_meeting_stream_seq has unexpected definition"
            in (result.stderr + result.stdout)
        )
        assert _index_definition(
            database_url,
            "transcript_fragments",
            "ix_transcript_fragments_meeting_stream_seq",
        ) == {"columns": ["meeting_id", "seq"], "unique": True}


def test_downgrade_to_009_preserves_v2_schema_and_data():
    with _temporary_database(f"{DATABASE_PREFIX}rollback") as database_url:
        _create_baseline_c_schema(database_url, bridge_index=True)
        _run_alembic(database_url, "stamp", "008")
        _run_alembic(database_url, "upgrade", "head")
        _execute(
            database_url,
            """
            INSERT INTO transcript_fragments (
                meeting_id, stream_id, recording_session_id, attempt_id, seq,
                version, text, normalized_text, is_final, dedupe_key, created_at
            ) VALUES
                (505, 'tab', 50501, 1, 1, 1, 'keep', 'keep', TRUE, 'rollback-v2', NOW());

            INSERT INTO transcript_attempt_checkpoints (
                meeting_id, recording_session_id, attempt_id, stream_id,
                last_ack_seq, last_persisted_seq, last_finalized_seq, updated_at
            ) VALUES
                (505, 50501, 1, 'tab', 1, 1, 1, NOW());
            """,
        )
        _run_alembic(database_url, "downgrade", "009")

        assert _scalar(database_url, "SELECT version_num FROM alembic_version") == "009"
        assert _scalar(database_url, "SELECT COUNT(*) FROM transcript_fragments") == 2
        assert _scalar(database_url, "SELECT COUNT(*) FROM transcript_checkpoints") == 1
        assert _column_exists(database_url, "transcript_fragments", "stream_id")
        assert _column_exists(
            database_url, "transcript_fragments", "recording_session_id"
        )
        assert _column_exists(database_url, "transcript_fragments", "attempt_id")
        assert _table_exists(database_url, "transcript_attempt_checkpoints")
        assert (
            _scalar(
                database_url,
                "SELECT COUNT(*) FROM transcript_attempt_checkpoints "
                "WHERE meeting_id = 505 AND attempt_id = 1",
            )
            == 1
        )
        assert _index_definition(
            database_url,
            "transcript_fragments",
            "ix_transcript_fragments_meeting_stream_seq",
        ) == {"columns": ["meeting_id", "stream_id", "seq"], "unique": False}
        assert _index_definition(
            database_url,
            "transcript_fragments",
            "ix_transcript_fragments_v2_event_identity",
        ) == {
            "columns": [
                "meeting_id",
                "recording_session_id",
                "attempt_id",
                "stream_id",
                "seq",
            ],
            "unique": False,
        }
        assert _index_definition(
            database_url,
            "transcript_attempt_checkpoints",
            "ix_transcript_attempt_checkpoints_meeting_session_stream",
        ) == {
            "columns": ["meeting_id", "recording_session_id", "stream_id"],
            "unique": False,
        }

        _run_alembic(database_url, "upgrade", "head")
        assert _scalar(database_url, "SELECT version_num FROM alembic_version") == "010"
        assert (
            _scalar(
                database_url,
                "SELECT COUNT(*) FROM transcript_attempt_checkpoints "
                "WHERE meeting_id = 505 AND attempt_id = 1",
            )
            == 1
        )


def test_attempt_rows_with_same_meeting_stream_seq_can_coexist():
    with _temporary_database(f"{DATABASE_PREFIX}attemptfragments") as database_url:
        _create_baseline_c_schema(database_url)
        _run_alembic(database_url, "stamp", "008")
        _run_alembic(database_url, "upgrade", "head")
        _execute(
            database_url,
            """
            INSERT INTO transcript_fragments (
                meeting_id, stream_id, recording_session_id, attempt_id, seq,
                version, text, normalized_text, is_final, dedupe_key, created_at
            ) VALUES
                (303, 'tab', 9001, 1, 1, 1, 'hello', 'hello', TRUE, 'v2-a1', NOW()),
                (303, 'tab', 9001, 2, 1, 1, 'hello', 'hello', TRUE, 'v2-a2', NOW());
            """,
        )

        assert (
            _scalar(
                database_url,
                "SELECT COUNT(*) FROM transcript_fragments "
                "WHERE meeting_id = 303 AND stream_id = 'tab' AND seq = 1",
            )
            == 2
        )


def test_v2_checkpoint_rows_for_attempts_are_independent():
    with _temporary_database(f"{DATABASE_PREFIX}attemptckpt") as database_url:
        _create_baseline_c_schema(database_url)
        _run_alembic(database_url, "stamp", "008")
        _run_alembic(database_url, "upgrade", "head")
        _execute(
            database_url,
            """
            INSERT INTO transcript_attempt_checkpoints (
                meeting_id, recording_session_id, attempt_id, stream_id,
                last_ack_seq, last_persisted_seq, last_finalized_seq, updated_at
            ) VALUES
                (404, 9001, 1, 'mic', 1, 1, 1, NOW()),
                (404, 9001, 2, 'mic', 7, 7, 7, NOW());
            """,
        )

        assert (
            _scalar(
                database_url,
                "SELECT COUNT(*) FROM transcript_attempt_checkpoints "
                "WHERE meeting_id = 404 AND recording_session_id = 9001 AND stream_id = 'mic'",
            )
            == 2
        )
        assert (
            _scalar(
                database_url,
                "SELECT MAX(last_ack_seq) FROM transcript_attempt_checkpoints "
                "WHERE meeting_id = 404 AND recording_session_id = 9001 AND stream_id = 'mic'",
            )
            == 7
        )


def test_revision_010_does_not_alter_legacy_transcript_checkpoints():
    with _temporary_database(f"{DATABASE_PREFIX}legacyckpt") as database_url:
        _create_baseline_c_schema(database_url)
        before_columns = _table_columns(database_url, "transcript_checkpoints")
        before_pk = _checkpoint_pk_columns(database_url)
        _run_alembic(database_url, "stamp", "008")
        _run_alembic(database_url, "upgrade", "head")

        assert _table_columns(database_url, "transcript_checkpoints") == before_columns
        assert _checkpoint_pk_columns(database_url) == before_pk
        assert _scalar(database_url, "SELECT COUNT(*) FROM transcript_checkpoints") == 1


def test_incompatible_existing_v2_fragment_index_fails_before_mutation():
    with _temporary_database(f"{DATABASE_PREFIX}badv2fragmentindex") as database_url:
        _create_baseline_c_schema(database_url)
        _execute(
            database_url,
            """
            ALTER TABLE transcript_fragments
                ADD COLUMN recording_session_id BIGINT;
            ALTER TABLE transcript_fragments
                ADD COLUMN attempt_id BIGINT;
            CREATE UNIQUE INDEX ix_transcript_fragments_v2_event_identity
                ON transcript_fragments (meeting_id, stream_id, seq);
            """,
        )
        _run_alembic(database_url, "stamp", "009")
        result = _run_alembic(database_url, "upgrade", "head", check=False)

        assert result.returncode != 0
        assert (
            "ix_transcript_fragments_v2_event_identity has incompatible definition"
            in (result.stderr + result.stdout)
        )
        assert not _table_exists(database_url, "transcript_attempt_checkpoints")


def test_incompatible_existing_attempt_checkpoint_table_fails_before_mutation():
    with _temporary_database(f"{DATABASE_PREFIX}badattempttable") as database_url:
        _create_baseline_c_schema(database_url)
        _execute(
            database_url,
            """
            CREATE TABLE transcript_attempt_checkpoints (
                meeting_id BIGINT NOT NULL,
                recording_session_id BIGINT NOT NULL,
                attempt_id INTEGER NOT NULL,
                stream_id VARCHAR(8) NOT NULL,
                last_ack_seq INTEGER NOT NULL DEFAULT 0,
                last_persisted_seq INTEGER NOT NULL DEFAULT 0,
                last_finalized_seq INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMP NOT NULL,
                PRIMARY KEY (
                    meeting_id,
                    recording_session_id,
                    attempt_id,
                    stream_id
                )
            );
            """,
        )
        _run_alembic(database_url, "stamp", "009")
        result = _run_alembic(database_url, "upgrade", "head", check=False)

        assert result.returncode != 0
        assert "transcript_attempt_checkpoints.attempt_id has incompatible shape" in (
            result.stderr + result.stdout
        )
        assert not _column_exists(
            database_url, "transcript_fragments", "recording_session_id"
        )
        assert not _column_exists(database_url, "transcript_fragments", "attempt_id")
        assert (
            _index_definition(
                database_url,
                "transcript_fragments",
                "ix_transcript_fragments_v2_event_identity",
            )
            is None
        )


def test_incompatible_existing_attempt_checkpoint_pk_fails_before_mutation():
    with _temporary_database(f"{DATABASE_PREFIX}badattemptpk") as database_url:
        _create_baseline_c_schema(database_url)
        _execute(
            database_url,
            """
            CREATE TABLE transcript_attempt_checkpoints (
                meeting_id BIGINT NOT NULL,
                recording_session_id BIGINT NOT NULL,
                attempt_id BIGINT NOT NULL,
                stream_id VARCHAR(8) NOT NULL,
                last_ack_seq INTEGER NOT NULL DEFAULT 0,
                last_persisted_seq INTEGER NOT NULL DEFAULT 0,
                last_finalized_seq INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMP NOT NULL,
                PRIMARY KEY (meeting_id, recording_session_id, stream_id)
            );
            """,
        )
        _run_alembic(database_url, "stamp", "009")
        result = _run_alembic(database_url, "upgrade", "head", check=False)

        assert result.returncode != 0
        assert "transcript_attempt_checkpoints has incompatible primary key" in (
            result.stderr + result.stdout
        )
        assert not _column_exists(
            database_url, "transcript_fragments", "recording_session_id"
        )
        assert not _column_exists(database_url, "transcript_fragments", "attempt_id")


def test_incompatible_existing_attempt_lookup_index_fails_before_mutation():
    with _temporary_database(f"{DATABASE_PREFIX}badattemptlookup") as database_url:
        _create_baseline_c_schema(database_url)
        _execute(
            database_url,
            """
            CREATE TABLE transcript_attempt_checkpoints (
                meeting_id BIGINT NOT NULL,
                recording_session_id BIGINT NOT NULL,
                attempt_id BIGINT NOT NULL,
                stream_id VARCHAR(8) NOT NULL,
                last_ack_seq INTEGER NOT NULL DEFAULT 0,
                last_persisted_seq INTEGER NOT NULL DEFAULT 0,
                last_finalized_seq INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMP NOT NULL,
                PRIMARY KEY (
                    meeting_id,
                    recording_session_id,
                    attempt_id,
                    stream_id
                )
            );
            CREATE UNIQUE INDEX ix_transcript_attempt_checkpoints_meeting_session_stream
                ON transcript_attempt_checkpoints (
                    meeting_id,
                    recording_session_id,
                    attempt_id
                );
            """,
        )
        _run_alembic(database_url, "stamp", "009")
        result = _run_alembic(database_url, "upgrade", "head", check=False)

        assert result.returncode != 0
        assert (
            "ix_transcript_attempt_checkpoints_meeting_session_stream "
            "has incompatible definition"
        ) in (result.stderr + result.stdout)
        assert not _column_exists(
            database_url, "transcript_fragments", "recording_session_id"
        )
        assert not _column_exists(database_url, "transcript_fragments", "attempt_id")


def test_existing_compatible_v2_objects_are_accepted():
    with _temporary_database(f"{DATABASE_PREFIX}compatiblev2") as database_url:
        _create_baseline_c_schema(database_url)
        _execute(
            database_url,
            """
            ALTER TABLE transcript_fragments
                ADD COLUMN recording_session_id BIGINT;
            ALTER TABLE transcript_fragments
                ADD COLUMN attempt_id BIGINT;
            CREATE INDEX ix_transcript_fragments_v2_event_identity
                ON transcript_fragments (
                    meeting_id,
                    recording_session_id,
                    attempt_id,
                    stream_id,
                    seq
                );

            CREATE TABLE transcript_attempt_checkpoints (
                meeting_id BIGINT NOT NULL,
                recording_session_id BIGINT NOT NULL,
                attempt_id BIGINT NOT NULL,
                stream_id VARCHAR(8) NOT NULL,
                last_ack_seq INTEGER NOT NULL DEFAULT 0,
                last_persisted_seq INTEGER NOT NULL DEFAULT 0,
                last_finalized_seq INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMP NOT NULL,
                PRIMARY KEY (
                    meeting_id,
                    recording_session_id,
                    attempt_id,
                    stream_id
                )
            );
            CREATE INDEX ix_transcript_attempt_checkpoints_meeting_session_stream
                ON transcript_attempt_checkpoints (
                    meeting_id,
                    recording_session_id,
                    stream_id
                );
            """,
        )
        _run_alembic(database_url, "stamp", "009")
        _run_alembic(database_url, "upgrade", "head")

        assert _scalar(database_url, "SELECT version_num FROM alembic_version") == "010"
        assert _table_exists(database_url, "transcript_attempt_checkpoints")
        assert _primary_key_columns(database_url, "transcript_attempt_checkpoints") == [
            "meeting_id",
            "recording_session_id",
            "attempt_id",
            "stream_id",
        ]
        assert _index_definition(
            database_url,
            "transcript_attempt_checkpoints",
            "ix_transcript_attempt_checkpoints_meeting_session_stream",
        ) == {
            "columns": ["meeting_id", "recording_session_id", "stream_id"],
            "unique": False,
        }
