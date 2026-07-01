"""Disposable local validation for Alembic revisions 009 and 010.

This helper intentionally requires MIGRATION_TEST_ADMIN_DATABASE_URL and only
creates databases whose names start with audiomind_phase1c_.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]
PREFIX = os.getenv("MIGRATION_TEST_DATABASE_PREFIX", "audiomind_phase1c_")


def _admin_url() -> str:
    value = os.getenv("MIGRATION_TEST_ADMIN_DATABASE_URL")
    if not value:
        raise SystemExit("MIGRATION_TEST_ADMIN_DATABASE_URL is required")
    return value


def _assert_disposable(name: str) -> None:
    if not name.startswith("audiomind_phase1c_"):
        raise AssertionError(f"Refusing non-disposable database name: {name}")


class DisposableDatabases:
    def __init__(self) -> None:
        self._engine = create_engine(_admin_url(), isolation_level="AUTOCOMMIT")
        self.used: list[str] = []

    def url(self, name: str) -> str:
        return (
            make_url(_admin_url())
            .set(database=name)
            .render_as_string(hide_password=False)
        )

    def create(self, suffix: str) -> str:
        name = f"{PREFIX}{suffix}"
        _assert_disposable(name)
        self.drop(name)
        with self._engine.connect() as connection:
            connection.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
            connection.execute(text(f'CREATE DATABASE "{name}"'))
        self.used.append(name)
        return self.url(name)

    def drop(self, name: str) -> None:
        _assert_disposable(name)
        with self._engine.connect() as connection:
            connection.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))

    def close(self) -> None:
        for name in self.used:
            self.drop(name)
        self._engine.dispose()


def run_alembic(
    database_url: str, *args: str, check: bool = True
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    result = subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=AI_SERVICE_ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    if check and result.returncode:
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        raise SystemExit(result.returncode)
    return result


def execute(database_url: str, sql: str) -> None:
    engine = create_engine(database_url)
    try:
        with engine.begin() as connection:
            for statement in sql.split(";"):
                if statement.strip():
                    connection.execute(text(statement))
    finally:
        engine.dispose()


def scalar(database_url: str, sql: str):
    engine = create_engine(database_url)
    try:
        with engine.connect() as connection:
            return connection.execute(text(sql)).scalar()
    finally:
        engine.dispose()


def checkpoint_pk_columns(database_url: str) -> list[str]:
    engine = create_engine(database_url)
    try:
        with engine.connect() as connection:
            rows = connection.execute(text("""
                    SELECT a.attname
                    FROM pg_constraint c
                    JOIN unnest(c.conkey) WITH ORDINALITY cols(attnum, ord) ON TRUE
                    JOIN pg_attribute a
                      ON a.attrelid = c.conrelid
                     AND a.attnum = cols.attnum
                    WHERE c.conrelid = 'public.transcript_checkpoints'::regclass
                      AND c.contype = 'p'
                    ORDER BY cols.ord
                    """)).fetchall()
            return [row[0] for row in rows]
    finally:
        engine.dispose()


def column_exists(database_url: str, table: str, column: str) -> bool:
    return bool(
        scalar(
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


def table_exists(database_url: str, table: str) -> bool:
    return bool(
        scalar(
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


def stream_length(database_url: str, table: str) -> int | None:
    return scalar(
        database_url,
        f"""
        SELECT character_maximum_length
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = '{table}'
          AND column_name = 'stream_id'
        """,
    )


def column_default(database_url: str, table: str, column: str) -> str | None:
    return scalar(
        database_url,
        f"""
        SELECT column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = '{table}'
          AND column_name = '{column}'
        """,
    )


def column_data_type(database_url: str, table: str, column: str) -> str | None:
    return scalar(
        database_url,
        f"""
        SELECT data_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = '{table}'
          AND column_name = '{column}'
        """,
    )


def index_definition(database_url: str, table: str, index_name: str) -> dict | None:
    engine = create_engine(database_url)
    try:
        with engine.connect() as connection:
            rows = connection.execute(text(f"""
                    SELECT ix.indisunique AS is_unique,
                           array_agg(a.attname ORDER BY ord.ordinality) AS columns
                    FROM pg_class t
                    JOIN pg_index ix ON ix.indrelid = t.oid
                    JOIN pg_class i ON i.oid = ix.indexrelid
                    JOIN unnest(ix.indkey) WITH ORDINALITY AS ord(attnum, ordinality)
                      ON TRUE
                    JOIN pg_attribute a
                      ON a.attrelid = t.oid
                     AND a.attnum = ord.attnum
                    WHERE t.relname = '{table}'
                      AND i.relname = '{index_name}'
                    GROUP BY ix.indisunique
                    """)).mappings().all()
            if not rows:
                return None
            return {
                "columns": list(rows[0]["columns"]),
                "unique": bool(rows[0]["is_unique"]),
            }
    finally:
        engine.dispose()


def table_columns(database_url: str, table: str) -> list[str]:
    engine = create_engine(database_url)
    try:
        with engine.connect() as connection:
            rows = connection.execute(text(f"""
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = '{table}'
                    ORDER BY ordinal_position
                    """)).fetchall()
            return [row[0] for row in rows]
    finally:
        engine.dispose()


def primary_key_columns(database_url: str, table: str) -> list[str]:
    engine = create_engine(database_url)
    try:
        with engine.connect() as connection:
            rows = connection.execute(text(f"""
                    SELECT a.attname
                    FROM pg_constraint c
                    JOIN unnest(c.conkey) WITH ORDINALITY cols(attnum, ord) ON TRUE
                    JOIN pg_attribute a
                      ON a.attrelid = c.conrelid
                     AND a.attnum = cols.attnum
                    WHERE c.conrelid = 'public.{table}'::regclass
                      AND c.contype = 'p'
                    ORDER BY cols.ord
                    """)).fetchall()
            return [row[0] for row in rows]
    finally:
        engine.dispose()


def revision_004_style_schema() -> str:
    return """
    CREATE TABLE transcripts (id SERIAL PRIMARY KEY, meeting_id INTEGER NOT NULL);
    CREATE TABLE analysis (id SERIAL PRIMARY KEY, meeting_id INTEGER NOT NULL UNIQUE);
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
    """


def minimal_required_schema(
    include_fragments: bool = True,
    fragment_columns: str = "meeting_id BIGINT NOT NULL, seq INTEGER NOT NULL",
    checkpoint_pk: str = "PRIMARY KEY (meeting_id)",
) -> str:
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
    return f"""
    CREATE TABLE transcripts (id SERIAL PRIMARY KEY, meeting_id INTEGER NOT NULL);
    CREATE TABLE analysis (id SERIAL PRIMARY KEY, meeting_id INTEGER NOT NULL UNIQUE);
    {fragments_sql}
    CREATE TABLE transcript_checkpoints (
        meeting_id BIGINT NOT NULL,
        last_ack_seq INTEGER NOT NULL DEFAULT 0,
        last_persisted_seq INTEGER NOT NULL DEFAULT 0,
        last_finalized_seq INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL,
        {checkpoint_pk}
    );
    """


def baseline_c_schema(
    stream_length_value: int = 8,
    stream_default: str | None = None,
    bridge_index: bool = False,
) -> str:
    default_clause = (
        f" DEFAULT '{stream_default}'" if stream_default is not None else ""
    )
    return f"""
    CREATE TABLE transcripts (id SERIAL PRIMARY KEY, meeting_id BIGINT NOT NULL);
    CREATE TABLE analysis (id SERIAL PRIMARY KEY, meeting_id BIGINT NOT NULL UNIQUE);
    CREATE TABLE transcript_fragments (
        id SERIAL PRIMARY KEY,
        meeting_id BIGINT NOT NULL,
        stream_id VARCHAR({stream_length_value}){default_clause} NOT NULL,
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
        stream_id VARCHAR({stream_length_value}){default_clause} NOT NULL,
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
    """


def validate() -> None:
    databases = DisposableDatabases()
    try:
        fresh = databases.create("fresh_manual")
        run_alembic(fresh, "upgrade", "head")
        assert scalar(fresh, "SELECT version_num FROM alembic_version") == "010"
        assert (
            scalar(
                fresh,
                "SELECT data_type FROM information_schema.columns "
                "WHERE table_name='transcripts' AND column_name='meeting_id'",
            )
            == "bigint"
        )
        assert column_exists(fresh, "transcript_fragments", "stream_id")
        assert column_exists(fresh, "transcript_checkpoints", "stream_id")
        assert checkpoint_pk_columns(fresh) == ["meeting_id", "stream_id"]
        assert column_default(fresh, "transcript_fragments", "stream_id").startswith(
            "''"
        )
        assert column_default(fresh, "transcript_checkpoints", "stream_id").startswith(
            "''"
        )
        assert index_definition(
            fresh, "transcript_fragments", "ix_transcript_fragments_stream_id"
        ) == {"columns": ["stream_id"], "unique": False}
        assert index_definition(
            fresh, "transcript_fragments", "ix_transcript_fragments_meeting_stream_seq"
        ) == {"columns": ["meeting_id", "stream_id", "seq"], "unique": False}
        assert column_exists(fresh, "transcript_fragments", "recording_session_id")
        assert column_exists(fresh, "transcript_fragments", "attempt_id")
        assert (
            column_data_type(fresh, "transcript_fragments", "recording_session_id")
            == "bigint"
        )
        assert column_data_type(fresh, "transcript_fragments", "attempt_id") == "bigint"
        assert table_exists(fresh, "transcript_attempt_checkpoints")
        assert primary_key_columns(fresh, "transcript_attempt_checkpoints") == [
            "meeting_id",
            "recording_session_id",
            "attempt_id",
            "stream_id",
        ]
        assert index_definition(
            fresh, "transcript_fragments", "ix_transcript_fragments_v2_event_identity"
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
        assert index_definition(
            fresh,
            "transcript_attempt_checkpoints",
            "ix_transcript_attempt_checkpoints_meeting_session_stream",
        ) == {
            "columns": ["meeting_id", "recording_session_id", "stream_id"],
            "unique": False,
        }
        print("PASS fresh")

        rev004 = databases.create("rev004_manual")
        execute(rev004, revision_004_style_schema())
        run_alembic(rev004, "stamp", "008")
        run_alembic(rev004, "upgrade", "head")
        assert checkpoint_pk_columns(rev004) == ["meeting_id", "stream_id"]
        assert scalar(rev004, "SELECT stream_id FROM transcript_fragments") == ""
        assert scalar(rev004, "SELECT stream_id FROM transcript_checkpoints") == ""
        print("PASS rev004")

        baseline = databases.create("baselinec_manual")
        execute(baseline, baseline_c_schema())
        run_alembic(baseline, "stamp", "008")
        run_alembic(baseline, "upgrade", "head")
        assert checkpoint_pk_columns(baseline) == ["meeting_id", "stream_id"]
        assert scalar(baseline, "SELECT stream_id FROM transcript_fragments") == ""
        assert scalar(baseline, "SELECT stream_id FROM transcript_checkpoints") == ""
        assert scalar(
            baseline,
            "SELECT recording_session_id IS NULL AND attempt_id IS NULL FROM transcript_fragments",
        )
        assert column_exists(baseline, "transcript_fragments", "recording_session_id")
        assert column_exists(baseline, "transcript_fragments", "attempt_id")
        print("PASS baselinec")

        missing_table = databases.create("missingtable_manual")
        execute(missing_table, minimal_required_schema(include_fragments=False))
        run_alembic(missing_table, "stamp", "008")
        result = run_alembic(missing_table, "upgrade", "head", check=False)
        assert result.returncode != 0
        assert "Required table 'transcript_fragments' is missing" in (
            result.stderr + result.stdout
        )
        assert not column_exists(missing_table, "transcript_checkpoints", "stream_id")
        print("PASS missingtable")

        missing_column = databases.create("missingcol_manual")
        execute(
            missing_column,
            minimal_required_schema(fragment_columns="seq INTEGER NOT NULL"),
        )
        run_alembic(missing_column, "stamp", "008")
        result = run_alembic(missing_column, "upgrade", "head", check=False)
        assert result.returncode != 0
        assert "Required column transcript_fragments.meeting_id is missing" in (
            result.stderr + result.stdout
        )
        assert not column_exists(missing_column, "transcript_fragments", "stream_id")
        assert not column_exists(missing_column, "transcript_checkpoints", "stream_id")
        print("PASS missingcol")

        bad_old_pk = databases.create("badpkold_manual")
        execute(
            bad_old_pk,
            minimal_required_schema(
                checkpoint_pk="PRIMARY KEY (meeting_id, last_ack_seq)"
            ),
        )
        run_alembic(bad_old_pk, "stamp", "008")
        result = run_alembic(bad_old_pk, "upgrade", "head", check=False)
        assert result.returncode != 0
        assert "unexpected primary key" in (result.stderr + result.stdout)
        assert not column_exists(bad_old_pk, "transcript_fragments", "stream_id")
        assert not column_exists(bad_old_pk, "transcript_checkpoints", "stream_id")
        print("PASS badpkold")

        badpk = databases.create("badpk_manual")
        execute(badpk, baseline_c_schema())
        execute(
            badpk,
            """
            ALTER TABLE transcript_checkpoints DROP CONSTRAINT transcript_checkpoints_pkey;
            ALTER TABLE transcript_checkpoints
                ADD CONSTRAINT transcript_checkpoints_pkey
                PRIMARY KEY (meeting_id, last_ack_seq);
            """,
        )
        run_alembic(badpk, "stamp", "008")
        result = run_alembic(badpk, "upgrade", "head", check=False)
        assert result.returncode != 0
        assert "unexpected primary key" in (result.stderr + result.stdout)
        assert checkpoint_pk_columns(badpk) == ["meeting_id", "last_ack_seq"]
        print("PASS badpk")

        defaultfix = databases.create("defaultfix_manual")
        execute(defaultfix, baseline_c_schema(stream_default="default"))
        run_alembic(defaultfix, "stamp", "008")
        run_alembic(defaultfix, "upgrade", "head")
        assert column_default(
            defaultfix, "transcript_fragments", "stream_id"
        ).startswith("''")
        assert column_default(
            defaultfix, "transcript_checkpoints", "stream_id"
        ).startswith("''")
        assert scalar(defaultfix, "SELECT stream_id FROM transcript_fragments") == ""
        assert scalar(defaultfix, "SELECT stream_id FROM transcript_checkpoints") == ""
        print("PASS defaultfix")

        badindex = databases.create("badindex_manual")
        execute(badindex, baseline_c_schema())
        execute(
            badindex,
            """
            DROP INDEX ix_transcript_fragments_stream_id;
            CREATE UNIQUE INDEX ix_transcript_fragments_stream_id
                ON transcript_fragments (seq);
            """,
        )
        run_alembic(badindex, "stamp", "008")
        result = run_alembic(badindex, "upgrade", "head", check=False)
        assert result.returncode != 0
        assert "ix_transcript_fragments_stream_id has unexpected definition" in (
            result.stderr + result.stdout
        )
        assert index_definition(
            badindex, "transcript_fragments", "ix_transcript_fragments_stream_id"
        ) == {"columns": ["seq"], "unique": True}
        print("PASS badindex")

        badbridge = databases.create("badbridgeindex_manual")
        execute(badbridge, baseline_c_schema())
        execute(
            badbridge,
            """
            CREATE UNIQUE INDEX ix_transcript_fragments_meeting_stream_seq
                ON transcript_fragments (meeting_id, seq);
            """,
        )
        run_alembic(badbridge, "stamp", "008")
        result = run_alembic(badbridge, "upgrade", "head", check=False)
        assert result.returncode != 0
        assert (
            "ix_transcript_fragments_meeting_stream_seq has unexpected definition"
            in (result.stderr + result.stdout)
        )
        assert index_definition(
            badbridge,
            "transcript_fragments",
            "ix_transcript_fragments_meeting_stream_seq",
        ) == {"columns": ["meeting_id", "seq"], "unique": True}
        print("PASS badbridgeindex")

        bad_v2_fragment_index = databases.create("badv2fragmentindex_manual")
        execute(bad_v2_fragment_index, baseline_c_schema())
        execute(
            bad_v2_fragment_index,
            """
            ALTER TABLE transcript_fragments
                ADD COLUMN recording_session_id BIGINT;
            ALTER TABLE transcript_fragments
                ADD COLUMN attempt_id BIGINT;
            CREATE UNIQUE INDEX ix_transcript_fragments_v2_event_identity
                ON transcript_fragments (meeting_id, stream_id, seq);
            """,
        )
        run_alembic(bad_v2_fragment_index, "stamp", "009")
        result = run_alembic(bad_v2_fragment_index, "upgrade", "head", check=False)
        assert result.returncode != 0
        assert (
            "ix_transcript_fragments_v2_event_identity has incompatible definition"
            in (result.stderr + result.stdout)
        )
        assert not table_exists(bad_v2_fragment_index, "transcript_attempt_checkpoints")
        print("PASS badv2fragmentindex")

        bad_attempt_table = databases.create("badattempttable_manual")
        execute(bad_attempt_table, baseline_c_schema())
        execute(
            bad_attempt_table,
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
        run_alembic(bad_attempt_table, "stamp", "009")
        result = run_alembic(bad_attempt_table, "upgrade", "head", check=False)
        assert result.returncode != 0
        assert "transcript_attempt_checkpoints.attempt_id has incompatible shape" in (
            result.stderr + result.stdout
        )
        assert not column_exists(
            bad_attempt_table, "transcript_fragments", "recording_session_id"
        )
        assert not column_exists(
            bad_attempt_table, "transcript_fragments", "attempt_id"
        )
        print("PASS badattempttable")

        bad_attempt_pk = databases.create("badattemptpk_manual")
        execute(bad_attempt_pk, baseline_c_schema())
        execute(
            bad_attempt_pk,
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
        run_alembic(bad_attempt_pk, "stamp", "009")
        result = run_alembic(bad_attempt_pk, "upgrade", "head", check=False)
        assert result.returncode != 0
        assert "transcript_attempt_checkpoints has incompatible primary key" in (
            result.stderr + result.stdout
        )
        assert not column_exists(
            bad_attempt_pk, "transcript_fragments", "recording_session_id"
        )
        assert not column_exists(bad_attempt_pk, "transcript_fragments", "attempt_id")
        print("PASS badattemptpk")

        bad_attempt_lookup = databases.create("badattemptlookup_manual")
        execute(bad_attempt_lookup, baseline_c_schema())
        execute(
            bad_attempt_lookup,
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
        run_alembic(bad_attempt_lookup, "stamp", "009")
        result = run_alembic(bad_attempt_lookup, "upgrade", "head", check=False)
        assert result.returncode != 0
        assert (
            "ix_transcript_attempt_checkpoints_meeting_session_stream "
            "has incompatible definition"
        ) in (result.stderr + result.stdout)
        assert not column_exists(
            bad_attempt_lookup, "transcript_fragments", "recording_session_id"
        )
        assert not column_exists(
            bad_attempt_lookup, "transcript_fragments", "attempt_id"
        )
        print("PASS badattemptlookup")

        compatible_v2 = databases.create("compatiblev2_manual")
        execute(compatible_v2, baseline_c_schema())
        execute(
            compatible_v2,
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
        run_alembic(compatible_v2, "stamp", "009")
        run_alembic(compatible_v2, "upgrade", "head")
        assert scalar(compatible_v2, "SELECT version_num FROM alembic_version") == "010"
        assert table_exists(compatible_v2, "transcript_attempt_checkpoints")
        assert primary_key_columns(compatible_v2, "transcript_attempt_checkpoints") == [
            "meeting_id",
            "recording_session_id",
            "attempt_id",
            "stream_id",
        ]
        assert index_definition(
            compatible_v2,
            "transcript_attempt_checkpoints",
            "ix_transcript_attempt_checkpoints_meeting_session_stream",
        ) == {
            "columns": ["meeting_id", "recording_session_id", "stream_id"],
            "unique": False,
        }
        print("PASS compatiblev2")

        wide = databases.create("wide_manual")
        execute(wide, baseline_c_schema(32))
        run_alembic(wide, "stamp", "008")
        run_alembic(wide, "upgrade", "head")
        assert stream_length(wide, "transcript_fragments") == 32
        assert stream_length(wide, "transcript_checkpoints") == 32
        print("PASS wide")

        rollback = databases.create("rollback_manual")
        execute(rollback, baseline_c_schema(bridge_index=True))
        run_alembic(rollback, "stamp", "008")
        run_alembic(rollback, "upgrade", "head")
        execute(
            rollback,
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
        run_alembic(rollback, "downgrade", "009")
        assert scalar(rollback, "SELECT version_num FROM alembic_version") == "009"
        assert scalar(rollback, "SELECT COUNT(*) FROM transcript_fragments") == 2
        assert scalar(rollback, "SELECT COUNT(*) FROM transcript_checkpoints") == 1
        assert column_exists(rollback, "transcript_fragments", "stream_id")
        assert column_exists(rollback, "transcript_fragments", "recording_session_id")
        assert column_exists(rollback, "transcript_fragments", "attempt_id")
        assert table_exists(rollback, "transcript_attempt_checkpoints")
        assert (
            scalar(
                rollback,
                "SELECT COUNT(*) FROM transcript_attempt_checkpoints "
                "WHERE meeting_id = 505 AND attempt_id = 1",
            )
            == 1
        )
        assert index_definition(
            rollback,
            "transcript_fragments",
            "ix_transcript_fragments_meeting_stream_seq",
        ) == {"columns": ["meeting_id", "stream_id", "seq"], "unique": False}
        assert index_definition(
            rollback,
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
        assert index_definition(
            rollback,
            "transcript_attempt_checkpoints",
            "ix_transcript_attempt_checkpoints_meeting_session_stream",
        ) == {
            "columns": ["meeting_id", "recording_session_id", "stream_id"],
            "unique": False,
        }
        run_alembic(rollback, "upgrade", "head")
        assert scalar(rollback, "SELECT version_num FROM alembic_version") == "010"
        assert (
            scalar(
                rollback,
                "SELECT COUNT(*) FROM transcript_attempt_checkpoints "
                "WHERE meeting_id = 505 AND attempt_id = 1",
            )
            == 1
        )
        print("PASS rollback")

        attempt_fragments = databases.create("attemptfragments_manual")
        execute(attempt_fragments, baseline_c_schema())
        run_alembic(attempt_fragments, "stamp", "008")
        run_alembic(attempt_fragments, "upgrade", "head")
        execute(
            attempt_fragments,
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
            scalar(
                attempt_fragments,
                "SELECT COUNT(*) FROM transcript_fragments "
                "WHERE meeting_id = 303 AND stream_id = 'tab' AND seq = 1",
            )
            == 2
        )
        print("PASS attemptfragments")

        attempt_ckpt = databases.create("attemptckpt_manual")
        execute(attempt_ckpt, baseline_c_schema())
        run_alembic(attempt_ckpt, "stamp", "008")
        run_alembic(attempt_ckpt, "upgrade", "head")
        execute(
            attempt_ckpt,
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
            scalar(
                attempt_ckpt,
                "SELECT COUNT(*) FROM transcript_attempt_checkpoints "
                "WHERE meeting_id = 404 AND recording_session_id = 9001 AND stream_id = 'mic'",
            )
            == 2
        )
        assert (
            scalar(
                attempt_ckpt,
                "SELECT MAX(last_ack_seq) FROM transcript_attempt_checkpoints "
                "WHERE meeting_id = 404 AND recording_session_id = 9001 AND stream_id = 'mic'",
            )
            == 7
        )
        print("PASS attemptckpt")

        legacy_ckpt = databases.create("legacyckpt_manual")
        execute(legacy_ckpt, baseline_c_schema())
        before_columns = table_columns(legacy_ckpt, "transcript_checkpoints")
        before_pk = checkpoint_pk_columns(legacy_ckpt)
        run_alembic(legacy_ckpt, "stamp", "008")
        run_alembic(legacy_ckpt, "upgrade", "head")
        assert table_columns(legacy_ckpt, "transcript_checkpoints") == before_columns
        assert checkpoint_pk_columns(legacy_ckpt) == before_pk
        assert scalar(legacy_ckpt, "SELECT COUNT(*) FROM transcript_checkpoints") == 1
        print("PASS legacyckpt")
    finally:
        used = list(databases.used)
        databases.close()
        print("DROPPED " + ",".join(used))


if __name__ == "__main__":
    validate()
