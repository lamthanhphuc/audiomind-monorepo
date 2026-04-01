from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
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
    migration_sql = text(
        """
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
        """
    )

    with engine.begin() as connection:
        connection.execute(migration_sql)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
