"""Post-review remediation regressions: synthesisId security, dispatch, cache, stale, language."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.services.study import (
    MODE_ALL_READY,
    MODE_EXPLICIT,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PROCESSING,
    STATUS_QUEUED,
    STATUS_QUOTA_EXCEEDED,
    StudyValidationError,
    build_options_hash,
)
from app.services.study import service as study_service
from app.services.study.artifacts import artifact_gemini_schema


READY = [
    {
        "meetingId": 101,
        "transcriptHash": "th-101",
        "analysisRunId": 11,
        "analysisVersion": "education-study-v1",
        "ready": True,
        "educationStudy": {"overview": "OSI", "sections": [{"title": "L1", "summary": "bits"}]},
        "allowedSegmentIds": ["seg-1"],
    },
    {
        "meetingId": 102,
        "transcriptHash": "th-102",
        "analysisRunId": 12,
        "analysisVersion": "education-study-v1",
        "ready": True,
        "educationStudy": {"overview": "TCP", "sections": [{"title": "HS", "summary": "syn"}]},
        "allowedSegmentIds": ["seg-2"],
    },
]


def _patch_sources(monkeypatch, sources=None):
    src = sources if sources is not None else READY

    def _compute(db, *, owner_user_id, subject_id, source_selection_mode, meeting_ids, require_ready=True):
        from app.services.study import build_source_hash

        ready = [s for s in src if int(s["meetingId"]) in set(int(m) for m in meeting_ids) or not meeting_ids]
        if source_selection_mode == MODE_ALL_READY and meeting_ids is not None and len(meeting_ids) == 0:
            ready = []
        rows = [
            {
                "meetingId": int(s["meetingId"]),
                "transcriptHash": s.get("transcriptHash"),
                "analysisRunId": s.get("analysisRunId"),
                "analysisVersion": s.get("analysisVersion"),
            }
            for s in ready
        ]
        return (
            build_source_hash(
                subject_id=subject_id,
                sources=rows,
                source_selection_mode=source_selection_mode,
            ),
            ready,
            rows,
        )

    monkeypatch.setattr(study_service, "compute_current_source_hash", _compute)


def _sqlite_engine(tmp_path: Path):
    from tests.test_study_concurrent_idempotency import _build_sqlite_schema

    path = tmp_path / "remediation.db"
    engine = create_engine(f"sqlite+pysqlite:///{path}", future=True)
    _build_sqlite_schema(engine)
    return engine


@pytest.fixture()
def db_session(tmp_path: Path):
    engine = _sqlite_engine(tmp_path)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    db = Session()
    yield db
    db.close()
    engine.dispose()


def test_synthesis_id_of_other_owner_rejected(db_session, monkeypatch):
    _patch_sources(monkeypatch)
    foreign = study_service.prepare_synthesis(
        db_session,
        owner_user_id=2,
        subject_id=10,
        meeting_ids=[101, 102],
        source_selection_mode=MODE_EXPLICIT,
        language="vi",
    )
    synthesis_id = int(foreign["synthesis"]["id"])
    # Force COMPLETED foreign synthesis
    row = study_service._live_synthesis_query(db_session).filter_by(id=synthesis_id).first()
    row.status = STATUS_COMPLETED
    row.content_json = {"subjectOverview": "secret"}
    db_session.commit()

    with pytest.raises(StudyValidationError) as exc:
        study_service.prepare_artifacts(
            db_session,
            owner_user_id=1,
            subject_id=10,
            meeting_ids=[101, 102],
            artifact_types=["FLASHCARDS"],
            source_selection_mode=MODE_EXPLICIT,
            options={"language": "vi", "flashcardCount": 5},
            synthesis_id=synthesis_id,
        )
    assert exc.value.code in {"SYNTHESIS_NOT_OWNED", "SYNTHESIS_NOT_FOUND"}


def test_synthesis_source_mismatch_rejected(db_session, monkeypatch):
    _patch_sources(monkeypatch)
    syn = study_service.prepare_synthesis(
        db_session,
        owner_user_id=1,
        subject_id=10,
        meeting_ids=[101],
        source_selection_mode=MODE_EXPLICIT,
        language="vi",
    )
    synthesis_id = int(syn["synthesis"]["id"])
    row = study_service._live_synthesis_query(db_session).filter_by(id=synthesis_id).first()
    row.status = STATUS_COMPLETED
    row.content_json = {"subjectOverview": "ok"}
    db_session.commit()

    with pytest.raises(StudyValidationError) as exc:
        study_service.prepare_artifacts(
            db_session,
            owner_user_id=1,
            subject_id=10,
            meeting_ids=[101, 102],
            artifact_types=["FLASHCARDS"],
            source_selection_mode=MODE_EXPLICIT,
            options={"language": "vi", "flashcardCount": 5},
            synthesis_id=synthesis_id,
        )
    assert exc.value.code == "SYNTHESIS_SOURCE_MISMATCH"


def test_failed_record_is_not_cache_hit(db_session, monkeypatch):
    _patch_sources(monkeypatch)
    first = study_service.prepare_artifacts(
        db_session,
        owner_user_id=1,
        subject_id=10,
        meeting_ids=[101, 102],
        artifact_types=["FLASHCARDS"],
        source_selection_mode=MODE_EXPLICIT,
        options={"language": "vi", "flashcardCount": 5},
    )
    artifact_id = int(first["newlyCreatedArtifactIds"][0])
    row = study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    row.status = STATUS_FAILED
    row.error_code = "FAILED_VALIDATION"
    db_session.commit()

    second = study_service.prepare_artifacts(
        db_session,
        owner_user_id=1,
        subject_id=10,
        meeting_ids=[101, 102],
        artifact_types=["FLASHCARDS"],
        source_selection_mode=MODE_EXPLICIT,
        options={"language": "vi", "flashcardCount": 5},
    )
    assert second["cacheHitArtifactIds"] == []
    assert second["newlyCreatedArtifactIds"]
    assert int(second["newlyCreatedArtifactIds"][0]) != artifact_id


def test_completed_is_cache_hit(db_session, monkeypatch):
    _patch_sources(monkeypatch)
    first = study_service.prepare_artifacts(
        db_session,
        owner_user_id=1,
        subject_id=10,
        meeting_ids=[101, 102],
        artifact_types=["FLASHCARDS"],
        source_selection_mode=MODE_EXPLICIT,
        options={"language": "vi", "flashcardCount": 5},
    )
    artifact_id = int(first["newlyCreatedArtifactIds"][0])
    row = study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    row.status = STATUS_COMPLETED
    row.content_json = {"cards": []}
    db_session.commit()

    second = study_service.prepare_artifacts(
        db_session,
        owner_user_id=1,
        subject_id=10,
        meeting_ids=[101, 102],
        artifact_types=["FLASHCARDS"],
        source_selection_mode=MODE_EXPLICIT,
        options={"language": "vi", "flashcardCount": 5},
    )
    assert artifact_id in second["cacheHitArtifactIds"]
    assert second["newlyCreatedArtifactIds"] == []


def test_dispatch_twice_enqueues_once(db_session, monkeypatch):
    _patch_sources(monkeypatch)
    prep = study_service.prepare_artifacts(
        db_session,
        owner_user_id=1,
        subject_id=10,
        meeting_ids=[101, 102],
        artifact_types=["FLASHCARDS"],
        source_selection_mode=MODE_EXPLICIT,
        options={"language": "vi", "flashcardCount": 5},
    )
    artifact_id = int(prep["newlyCreatedArtifactIds"][0])
    study_service.confirm_quota_for_jobs(
        db_session,
        owner_user_id=1,
        synthesis_ids=[],
        artifact_ids=[artifact_id],
    )
    calls: list[str] = []

    class FakeAsync:
        def apply_async(self, args=None, task_id=None):
            calls.append(task_id or "")
            return SimpleNamespace(id=task_id)

    monkeypatch.setattr("app.tasks.generate_study_artifact", FakeAsync())
    monkeypatch.setattr("app.tasks.generate_subject_synthesis", FakeAsync())

    first = study_service.dispatch_study_jobs(
        db_session, owner_user_id=1, synthesis_ids=[], artifact_ids=[artifact_id]
    )
    second = study_service.dispatch_study_jobs(
        db_session, owner_user_id=1, synthesis_ids=[], artifact_ids=[artifact_id]
    )
    assert first["dispatchedArtifactIds"] == [artifact_id]
    assert second["dispatchedArtifactIds"] == []
    assert artifact_id in second["idempotentArtifactIds"]
    assert len(calls) == 1


def test_language_options_hash_differs_and_persisted(db_session, monkeypatch):
    _patch_sources(monkeypatch)
    vi = study_service.prepare_synthesis(
        db_session,
        owner_user_id=1,
        subject_id=10,
        meeting_ids=[101, 102],
        source_selection_mode=MODE_EXPLICIT,
        language="vi",
    )
    en = study_service.prepare_synthesis(
        db_session,
        owner_user_id=1,
        subject_id=10,
        meeting_ids=[101, 102],
        source_selection_mode=MODE_EXPLICIT,
        language="en",
    )
    assert vi["synthesis"]["optionsHash"] != en["synthesis"]["optionsHash"]
    assert build_options_hash({"language": "vi"}) != build_options_hash({"language": "en"})
    row = study_service._live_synthesis_query(db_session).filter_by(id=en["synthesis"]["id"]).first()
    assert row.options_json["language"] == "en"


def test_all_ready_empty_subject_is_stale(db_session, monkeypatch):
    _patch_sources(monkeypatch)
    prep = study_service.prepare_artifacts(
        db_session,
        owner_user_id=1,
        subject_id=10,
        meeting_ids=[101, 102],
        artifact_types=["FLASHCARDS"],
        source_selection_mode=MODE_ALL_READY,
        options={"language": "vi", "flashcardCount": 5},
    )
    artifact_id = int(prep["newlyCreatedArtifactIds"][0])
    row = study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    row.status = STATUS_COMPLETED
    row.source_selection_mode = MODE_ALL_READY
    db_session.commit()

    stale = study_service.evaluate_stale_for_row(
        db_session,
        owner_user_id=1,
        subject_id=10,
        source_selection_mode=MODE_ALL_READY,
        stored_source_hash=row.source_hash,
        stored_source_meeting_ids=[101, 102],
        current_subject_meeting_ids=[],
    )
    assert stale is True


def test_explicit_new_meeting_outside_selection_not_stale(db_session, monkeypatch):
    _patch_sources(monkeypatch)
    prep = study_service.prepare_artifacts(
        db_session,
        owner_user_id=1,
        subject_id=10,
        meeting_ids=[101],
        artifact_types=["FLASHCARDS"],
        source_selection_mode=MODE_EXPLICIT,
        options={"language": "vi", "flashcardCount": 5},
    )
    artifact_id = int(prep["newlyCreatedArtifactIds"][0])
    row = study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    row.status = STATUS_COMPLETED
    db_session.commit()

    stale = study_service.evaluate_stale_for_row(
        db_session,
        owner_user_id=1,
        subject_id=10,
        source_selection_mode=MODE_EXPLICIT,
        stored_source_hash=row.source_hash,
        stored_source_meeting_ids=[101],
        current_subject_meeting_ids=[101, 999],
    )
    assert stale is False


def test_explicit_source_leaving_subject_is_stale(db_session, monkeypatch):
    _patch_sources(monkeypatch)
    prep = study_service.prepare_artifacts(
        db_session,
        owner_user_id=1,
        subject_id=10,
        meeting_ids=[101, 102],
        artifact_types=["FLASHCARDS"],
        source_selection_mode=MODE_EXPLICIT,
        options={"language": "vi", "flashcardCount": 5},
    )
    artifact_id = int(prep["newlyCreatedArtifactIds"][0])
    row = study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    row.status = STATUS_COMPLETED
    db_session.commit()

    stale = study_service.evaluate_stale_for_row(
        db_session,
        owner_user_id=1,
        subject_id=10,
        source_selection_mode=MODE_EXPLICIT,
        stored_source_hash=row.source_hash,
        stored_source_meeting_ids=[101, 102],
        current_subject_meeting_ids=[101],
    )
    assert stale is True


def test_list_returns_stale_flag(db_session, monkeypatch):
    _patch_sources(monkeypatch)
    prep = study_service.prepare_artifacts(
        db_session,
        owner_user_id=1,
        subject_id=10,
        meeting_ids=[101, 102],
        artifact_types=["FLASHCARDS"],
        source_selection_mode=MODE_ALL_READY,
        options={"language": "vi", "flashcardCount": 5},
    )
    artifact_id = int(prep["newlyCreatedArtifactIds"][0])
    row = study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    row.status = STATUS_COMPLETED
    db_session.commit()

    listed = study_service.list_artifacts_for_subject(
        db_session,
        subject_id=10,
        owner_user_id=1,
        meeting_ids_for_stale=[],
    )
    match = next(i for i in listed["items"] if i["id"] == artifact_id)
    assert match["stale"] is True
    assert match["status"] == "STALE"


def test_artifact_gemini_schema_not_null():
    for artifact_type in (
        "MIND_MAP",
        "FLASHCARDS",
        "MULTIPLE_CHOICE",
        "ESSAY_QUESTIONS",
        "EXAM_BRIEF",
    ):
        schema = artifact_gemini_schema(artifact_type)
        assert schema["type"] == "OBJECT"
        assert "properties" in schema


def test_worker_ignores_foreign_synthesis_id(monkeypatch):
    row = SimpleNamespace(
        id=1,
        owner_user_id=1,
        subject_id=10,
        synthesis_id=999,
        artifact_type="FLASHCARDS",
        status=STATUS_QUEUED,
        source_hash="hash",
        source_selection_mode=MODE_EXPLICIT,
        options_json={"language": "vi", "flashcardCount": 5, "multipleChoiceCount": 5, "essayQuestionCount": 1, "difficulty": "MIXED"},
        sources=[SimpleNamespace(meeting_id=101)],
        content_json=None,
        error_code=None,
        error_message=None,
        generated_at=None,
        updated_at=None,
        processing_started_at=None,
        last_heartbeat_at=None,
    )
    db = MagicMock()
    monkeypatch.setattr(study_service, "claim_processing_artifact", lambda *_a, **_k: row)
    monkeypatch.setattr(study_service, "_guard_source_hash_unchanged", lambda *_a, **_k: None)
    monkeypatch.setattr(
        study_service,
        "compute_current_source_hash",
        lambda *a, **k: (
            "hash",
            [{"meetingId": 101, "ready": True, "educationStudy": {}, "allowedSegmentIds": ["seg-1"]}],
            [],
        ),
    )
    monkeypatch.setattr(
        study_service,
        "resolve_compatible_synthesis",
        MagicMock(side_effect=StudyValidationError("SYNTHESIS_NOT_OWNED", "Synthesis not found")),
    )
    captured = {}

    def gen(artifact_type, *, synthesis_content, ready_sources, options, call_gemini):
        captured["synthesis_content"] = synthesis_content
        return {"cards": [{"id": "c1", "front": "q", "back": "a"}]}

    monkeypatch.setattr(study_service, "generate_artifact_content", gen)
    study_service.process_artifact_job(db, 1)
    assert captured["synthesis_content"] is None
