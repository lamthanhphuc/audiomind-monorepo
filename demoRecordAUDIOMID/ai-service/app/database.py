from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.orm import declarative_base
from sqlalchemy import text
from tenacity import retry, stop_after_attempt, wait_fixed
from app.config import get_settings

settings = get_settings()

engine = create_engine(settings.database_url)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


@retry(stop=stop_after_attempt(10), wait=wait_fixed(3), reraise=True)
def wait_for_database() -> None:
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))


def ensure_bigint_meeting_id() -> None:
    migration_sql = text("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'transcripts'
                  AND column_name = 'meeting_id'
                  AND data_type <> 'bigint'
            ) THEN
                ALTER TABLE transcripts ALTER COLUMN meeting_id TYPE BIGINT;
            END IF;

            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'analysis'
                  AND column_name = 'meeting_id'
                  AND data_type <> 'bigint'
            ) THEN
                ALTER TABLE analysis ALTER COLUMN meeting_id TYPE BIGINT;
            END IF;
        END$$;
        """)

    with engine.begin() as connection:
        connection.execute(migration_sql)


def ensure_transcript_canonical_sidecar_columns() -> None:
    if engine.dialect.name == "postgresql":
        migration_sql = text("""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_schema = 'public'
                      AND table_name = 'transcripts'
                ) THEN
                    IF NOT EXISTS (
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name = 'transcripts'
                          AND column_name = 'raw_transcript_hash'
                    ) THEN
                        ALTER TABLE transcripts ADD COLUMN raw_transcript_hash VARCHAR(64);
                    END IF;

                    IF NOT EXISTS (
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name = 'transcripts'
                          AND column_name = 'canonical_transcript_rows'
                    ) THEN
                        ALTER TABLE transcripts ADD COLUMN canonical_transcript_rows JSON;
                    END IF;

                    IF NOT EXISTS (
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name = 'transcripts'
                          AND column_name = 'canonical_transcript_version'
                    ) THEN
                        ALTER TABLE transcripts ADD COLUMN canonical_transcript_version VARCHAR(64);
                    END IF;

                    IF NOT EXISTS (
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name = 'transcripts'
                          AND column_name = 'canonical_transcript_hash'
                    ) THEN
                        ALTER TABLE transcripts ADD COLUMN canonical_transcript_hash VARCHAR(64);
                    END IF;

                    IF NOT EXISTS (
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name = 'transcripts'
                          AND column_name = 'canonical_generated_at'
                    ) THEN
                        ALTER TABLE transcripts ADD COLUMN canonical_generated_at TIMESTAMP;
                    END IF;

                    IF NOT EXISTS (
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name = 'transcripts'
                          AND column_name = 'canonical_stats'
                    ) THEN
                        ALTER TABLE transcripts ADD COLUMN canonical_stats JSON;
                    END IF;
                END IF;
            END$$;
            """)

        with engine.begin() as connection:
            connection.execute(migration_sql)
        return

    if engine.dialect.name != "sqlite":
        return

    with engine.begin() as connection:
        table_exists = connection.execute(
            text(
                "SELECT name FROM sqlite_master "
                "WHERE type='table' AND name='transcripts'"
            )
        ).fetchone()
        if table_exists is None:
            return

        existing_columns = {
            str(row[1])
            for row in connection.execute(text("PRAGMA table_info(transcripts)"))
        }

        statements = []
        if "raw_transcript_hash" not in existing_columns:
            statements.append(
                "ALTER TABLE transcripts ADD COLUMN raw_transcript_hash VARCHAR(64)"
            )
        if "canonical_transcript_rows" not in existing_columns:
            statements.append(
                "ALTER TABLE transcripts ADD COLUMN canonical_transcript_rows TEXT"
            )
        if "canonical_transcript_version" not in existing_columns:
            statements.append(
                "ALTER TABLE transcripts ADD COLUMN canonical_transcript_version VARCHAR(64)"
            )
        if "canonical_transcript_hash" not in existing_columns:
            statements.append(
                "ALTER TABLE transcripts ADD COLUMN canonical_transcript_hash VARCHAR(64)"
            )
        if "canonical_generated_at" not in existing_columns:
            statements.append(
                "ALTER TABLE transcripts ADD COLUMN canonical_generated_at DATETIME"
            )
        if "canonical_stats" not in existing_columns:
            statements.append("ALTER TABLE transcripts ADD COLUMN canonical_stats TEXT")

        for statement in statements:
            connection.execute(text(statement))


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
