"""Concurrent idempotency + soft-delete integration for Phase 2 study artifacts.

Prefers PostgreSQL (partial unique index + real races). Falls back to a
file-based SQLite schema with INTEGER PKs that still enforce the live
idempotency unique index.
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import (
    BigInteger,
    Column,
    DateTime,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    create_engine,
    select,
    text,
)
from sqlalchemy.orm import Session, sessionmaker

from app.services.study import (
    ARTIFACT_FLASHCARDS,
    MODE_EXPLICIT,
    StudyAuthorizationError,
)
from app.services.study import service as study_service

READY_SOURCES = [
    {
        "meetingId": 101,
        "transcriptHash": "th-101",
        "analysisRunId": 11,
        "analysisVersion": "education-study-v1",
        "ready": True,
        "educationStudy": {
            "overview": "OSI",
            "sections": [{"title": "L1", "summary": "bits"}],
        },
        "allowedSegmentIds": ["seg-1"],
    },
    {
        "meetingId": 102,
        "transcriptHash": "th-102",
        "analysisRunId": 12,
        "analysisVersion": "education-study-v1",
        "ready": True,
        "educationStudy": {
            "overview": "TCP",
            "sections": [{"title": "Handshake", "summary": "syn"}],
        },
        "allowedSegmentIds": ["seg-2"],
    },
]


def _postgres_url() -> str | None:
    return os.getenv("PHASE2_CONCURRENT_DATABASE_URL") or os.getenv(
        "MIGRATION_TEST_ADMIN_DATABASE_URL"
    )


def _build_sqlite_schema(engine) -> None:
    """SQLite-friendly tables: INTEGER PK autoincrement + partial unique indexes."""
    meta = MetaData()
    Table(
        "subject_synthesis",
        meta,
        Column("id", Integer, primary_key=True, autoincrement=True),
        Column("subject_id", Integer, nullable=False),
        Column("owner_user_id", Integer, nullable=False),
        Column("status", String(30), nullable=False),
        Column("version", Integer, nullable=False, default=1),
        Column("title", String(255)),
        Column("content_json", Text),
        Column("source_hash", String(64), nullable=False),
        Column("options_hash", String(64)),
        Column("source_selection_mode", String(20), nullable=False),
        Column("prompt_version", String(100)),
        Column("schema_version", String(100)),
        Column("idempotency_key", String(256), nullable=False),
        Column("generation_request_id", String(64)),
        Column("error_code", String(100)),
        Column("error_message", Text),
        Column("warnings_json", Text),
        Column("generated_at", DateTime),
        Column("created_at", DateTime, nullable=False),
        Column("updated_at", DateTime, nullable=False),
        Column("deleted_at", DateTime),
    )
    Table(
        "subject_synthesis_source",
        meta,
        Column("synthesis_id", Integer, primary_key=True),
        Column("meeting_id", Integer, primary_key=True),
        Column("transcript_hash", String(64)),
        Column("analysis_run_id", Integer),
        Column("analysis_version", String(100)),
        Column("created_at", DateTime, nullable=False),
    )
    Table(
        "study_artifact",
        meta,
        Column("id", Integer, primary_key=True, autoincrement=True),
        Column("owner_user_id", Integer, nullable=False),
        Column("subject_id", Integer, nullable=False),
        Column("synthesis_id", Integer),
        Column("artifact_type", String(40), nullable=False),
        Column("status", String(30), nullable=False),
        Column("version", Integer, nullable=False, default=1),
        Column("title", String(255)),
        Column("options_json", Text),
        Column("content_json", Text),
        Column("source_hash", String(64), nullable=False),
        Column("options_hash", String(64), nullable=False),
        Column("source_selection_mode", String(20), nullable=False),
        Column("prompt_version", String(100)),
        Column("schema_version", String(100)),
        Column("idempotency_key", String(256), nullable=False),
        Column("generation_request_id", String(64)),
        Column("error_code", String(100)),
        Column("error_message", Text),
        Column("warnings_json", Text),
        Column("generated_at", DateTime),
        Column("created_at", DateTime, nullable=False),
        Column("updated_at", DateTime, nullable=False),
        Column("deleted_at", DateTime),
    )
    Table(
        "study_artifact_source",
        meta,
        Column("artifact_id", Integer, primary_key=True),
        Column("meeting_id", Integer, primary_key=True),
        Column("transcript_hash", String(64)),
        Column("analysis_run_id", Integer),
        Column("analysis_version", String(100)),
        Column("created_at", DateTime, nullable=False),
    )
    meta.create_all(engine)
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS uq_study_artifact_idempotency_live
                ON study_artifact(idempotency_key)
                WHERE deleted_at IS NULL
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS uq_subject_synthesis_idempotency_live
                ON subject_synthesis(idempotency_key)
                WHERE deleted_at IS NULL
                """
            )
        )


@pytest.fixture()
def race_session_factory(tmp_path: Path):
    pg = _postgres_url()
    if pg:
        db_name = f"phase2_race_{uuid.uuid4().hex[:8]}"
        admin = create_engine(pg, isolation_level="AUTOCOMMIT")
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}"'))
            conn.execute(text(f'CREATE DATABASE "{db_name}"'))
        from sqlalchemy.engine import make_url

        url = make_url(pg).set(database=db_name).render_as_string(hide_password=False)
        engine = create_engine(url, pool_size=5, max_overflow=10)
        from app.models import Base, StudyArtifact, SubjectSynthesis

        Base.metadata.create_all(
            bind=engine,
            tables=[
                SubjectSynthesis.__table__,
                SubjectSynthesis.__table__.metadata.tables["subject_synthesis_source"],
                StudyArtifact.__table__,
                StudyArtifact.__table__.metadata.tables["study_artifact_source"],
            ],
        )
        with engine.begin() as conn:
            conn.execute(
                text(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_study_artifact_idempotency_live
                    ON study_artifact(idempotency_key)
                    WHERE deleted_at IS NULL
                    """
                )
            )
            conn.execute(
                text(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_subject_synthesis_idempotency_live
                    ON subject_synthesis(idempotency_key)
                    WHERE deleted_at IS NULL
                    """
                )
            )
    else:
        db_file = tmp_path / "phase2_race.sqlite"
        engine = create_engine(
            f"sqlite+pysqlite:///{db_file}",
            connect_args={"check_same_thread": False, "timeout": 30},
        )
        _build_sqlite_schema(engine)

    SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)

    def factory() -> Session:
        return SessionLocal()

    yield factory

    engine.dispose()
    if pg:
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
        admin.dispose()


def _patch_sources(monkeypatch):
    def _compute(db, *, owner_user_id, subject_id, source_selection_mode, meeting_ids):
        from app.services.study import build_source_hash

        source_hash = build_source_hash(
            subject_id=subject_id,
            source_selection_mode=source_selection_mode,
            sources=READY_SOURCES,
        )
        return source_hash, READY_SOURCES, READY_SOURCES

    monkeypatch.setattr(study_service, "compute_current_source_hash", _compute)


def test_concurrent_prepare_artifacts_creates_single_active_row(
    race_session_factory, monkeypatch
):
    _patch_sources(monkeypatch)
    barrier = threading.Barrier(2)
    results: list[dict[str, Any]] = []
    errors: list[BaseException] = []
    newly_ids: list[int] = []
    lock = threading.Lock()

    original_live = study_service._live_artifact_query

    def gated_live(db):
        query = original_live(db)
        original_first = query.first

        def first_with_barrier(*args, **kwargs):
            row = original_first(*args, **kwargs)
            if row is None:
                barrier.wait(timeout=5)
                time.sleep(0.05)
            return row

        query.first = first_with_barrier  # type: ignore[method-assign]
        return query

    monkeypatch.setattr(study_service, "_live_artifact_query", gated_live)

    def worker():
        db = race_session_factory()
        try:
            payload = study_service.prepare_artifacts(
                db,
                owner_user_id=1,
                subject_id=10,
                meeting_ids=[101, 102],
                artifact_types=[ARTIFACT_FLASHCARDS],
                source_selection_mode=MODE_EXPLICIT,
                options={"language": "vi", "flashcardCount": 5},
                force=False,
            )
            with lock:
                results.append(payload)
                newly_ids.extend(int(x) for x in (payload.get("newlyCreatedArtifactIds") or []))
        except BaseException as exc:  # noqa: BLE001
            with lock:
                errors.append(exc)
        finally:
            db.close()

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=20)

    assert not errors, f"unexpected errors: {errors}"
    assert len(results) == 2
    ids = sorted({int(i) for r in results for i in (r.get("artifactIds") or [])})
    assert len(ids) == 1
    assert len(set(newly_ids)) <= 1

    verify = race_session_factory()
    try:
        live_count = verify.execute(
            text("SELECT COUNT(*) FROM study_artifact WHERE deleted_at IS NULL")
        ).scalar()
        assert live_count == 1
        version = verify.execute(
            text("SELECT version FROM study_artifact WHERE deleted_at IS NULL")
        ).scalar()
        assert version == 1
    finally:
        verify.close()


def test_concurrent_prepare_synthesis_creates_single_active_row(
    race_session_factory, monkeypatch
):
    _patch_sources(monkeypatch)
    barrier = threading.Barrier(2)
    results: list[dict[str, Any]] = []
    errors: list[BaseException] = []

    original_live = study_service._live_synthesis_query

    def gated_live(db):
        query = original_live(db)
        original_first = query.first

        def first_with_barrier(*args, **kwargs):
            row = original_first(*args, **kwargs)
            if row is None:
                barrier.wait(timeout=5)
                time.sleep(0.05)
            return row

        query.first = first_with_barrier  # type: ignore[method-assign]
        return query

    monkeypatch.setattr(study_service, "_live_synthesis_query", gated_live)

    def worker():
        db = race_session_factory()
        try:
            payload = study_service.prepare_synthesis(
                db,
                owner_user_id=1,
                subject_id=10,
                meeting_ids=[101, 102],
                source_selection_mode=MODE_EXPLICIT,
                language="vi",
                force=False,
            )
            results.append(payload)
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)
        finally:
            db.close()

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=20)

    assert not errors, f"unexpected errors: {errors}"
    assert len(results) == 2
    synthesis_ids = sorted(
        {
            int(r["synthesis"]["id"])
            for r in results
            if r.get("synthesis") and r["synthesis"].get("id") is not None
        }
    )
    assert len(synthesis_ids) == 1

    verify = race_session_factory()
    try:
        live_count = verify.execute(
            text("SELECT COUNT(*) FROM subject_synthesis WHERE deleted_at IS NULL")
        ).scalar()
        assert live_count == 1
    finally:
        verify.close()


def test_soft_delete_allows_recreate_and_hides_from_cache(race_session_factory, monkeypatch):
    _patch_sources(monkeypatch)
    db = race_session_factory()
    try:
        first = study_service.prepare_artifacts(
            db,
            owner_user_id=1,
            subject_id=10,
            meeting_ids=[101, 102],
            artifact_types=[ARTIFACT_FLASHCARDS],
            source_selection_mode=MODE_EXPLICIT,
            options={"language": "vi", "flashcardCount": 5},
            force=False,
        )
        artifact_a = int(first["newlyCreatedArtifactIds"][0])
        study_service.soft_delete_artifact(db, artifact_id=artifact_a, owner_user_id=1)

        listed = study_service.list_artifacts_for_subject(
            db, subject_id=10, owner_user_id=1, artifact_type=None, status=None
        )
        assert all(int(item["id"]) != artifact_a for item in listed)

        with pytest.raises(StudyAuthorizationError):
            study_service.get_artifact_for_owner(db, artifact_id=artifact_a, owner_user_id=1)

        second = study_service.prepare_artifacts(
            db,
            owner_user_id=1,
            subject_id=10,
            meeting_ids=[101, 102],
            artifact_types=[ARTIFACT_FLASHCARDS],
            source_selection_mode=MODE_EXPLICIT,
            options={"language": "vi", "flashcardCount": 5},
            force=False,
        )
        newly = second.get("newlyCreatedArtifactIds") or []
        assert newly, "soft-deleted key must allow a new active row"
        artifact_b = int(newly[0])
        assert artifact_b != artifact_a
        assert artifact_a not in (second.get("cacheHitArtifactIds") or [])

        live_count = db.execute(
            text("SELECT COUNT(*) FROM study_artifact WHERE deleted_at IS NULL")
        ).scalar()
        assert live_count == 1
        deleted_at = db.execute(
            text("SELECT deleted_at FROM study_artifact WHERE id = :id"),
            {"id": artifact_a},
        ).scalar()
        assert deleted_at is not None
    finally:
        db.close()
