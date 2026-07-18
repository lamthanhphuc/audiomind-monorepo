"""Phase 2 second-remediation regressions: retry, dispatch recovery, reconcile, MCQ, reducer."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import get_settings
from app.services.study import (
    MODE_ALL_READY,
    MODE_EXPLICIT,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_QUEUED,
    STATUS_STALE,
    StudyTransientError,
    StudyValidationError,
)
from app.services.study import service as study_service
from app.services.study.artifacts import validate_mcq
from app.services.study.synthesis import run_hierarchical_synthesis


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

    path = tmp_path / "second_remediation.db"
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


def _prepare_flashcards(db, monkeypatch, *, confirm_quota: bool = True) -> int:
    _patch_sources(monkeypatch)
    prep = study_service.prepare_artifacts(
        db,
        owner_user_id=1,
        subject_id=10,
        meeting_ids=[101, 102],
        artifact_types=["FLASHCARDS"],
        source_selection_mode=MODE_EXPLICIT,
        options={"language": "vi", "flashcardCount": 5},
    )
    artifact_id = int(prep["newlyCreatedArtifactIds"][0])
    if confirm_quota:
        study_service.confirm_quota_for_jobs(
            db,
            owner_user_id=1,
            synthesis_ids=[],
            artifact_ids=[artifact_id],
        )
    return artifact_id


def _ok_flashcards():
    return {
        "cards": [
            {
                "id": f"c{i}",
                "front": f"q{i}",
                "back": f"a{i}",
                "difficulty": "EASY",
                "sourceMeetingIds": [101],
                "sourceSegmentIds": ["seg-1"],
            }
            for i in range(1, 6)
        ]
    }


def test_transient_retry_second_claim_succeeds(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(db_session, monkeypatch)
    provider_calls: list[str] = []

    def flaky_generate(*_a, **_k):
        provider_calls.append("gen")
        if len(provider_calls) == 1:
            raise StudyTransientError("gemini timeout")
        return _ok_flashcards()

    monkeypatch.setattr(study_service, "generate_artifact_content", flaky_generate)

    with pytest.raises(StudyTransientError):
        study_service.process_artifact_job(db_session, artifact_id)

    row = study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    assert row.status == STATUS_QUEUED
    assert row.status != STATUS_FAILED
    assert row.error_code == "TRANSIENT_AI_ERROR"

    study_service.process_artifact_job(db_session, artifact_id)
    db_session.refresh(row)
    assert row.status == STATUS_COMPLETED
    assert len(provider_calls) == 2


def test_max_retries_marks_failed(db_session, monkeypatch, tmp_path):
    artifact_id = _prepare_flashcards(db_session, monkeypatch)

    def always_transient(*_a, **_k):
        raise StudyTransientError("still failing")

    monkeypatch.setattr(study_service, "generate_artifact_content", always_transient)

    settings = get_settings()
    monkeypatch.setattr(settings, "study_generation_max_retries", 0)

    engine = db_session.get_bind()
    SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr("app.tasks.SessionLocal", SessionLocal)

    from app.tasks import generate_study_artifact

    generate_study_artifact.push_request(id="retry-exhaust", retries=0)
    try:
        generate_study_artifact.run(artifact_id)
    finally:
        generate_study_artifact.pop_request()

    row = study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    assert row.status == STATUS_FAILED
    assert row.error_code == "TRANSIENT_AI_ERROR"
    assert "Exhausted retries" in (row.error_message or "")


def test_validation_error_no_retry_failed_immediately(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(db_session, monkeypatch)

    def bad_validate(*_a, **_k):
        raise StudyValidationError("INVALID_FLASHCARDS", "bad cards")

    monkeypatch.setattr(study_service, "generate_artifact_content", bad_validate)

    study_service.process_artifact_job(db_session, artifact_id)

    row = study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    assert row.status == STATUS_FAILED
    assert row.status != STATUS_QUEUED
    assert row.error_code == "INVALID_FLASHCARDS"


def test_duplicate_task_after_completed_noops(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(db_session, monkeypatch)
    provider_calls: list[str] = []

    def gen(*_a, **_k):
        provider_calls.append("gen")
        return _ok_flashcards()

    monkeypatch.setattr(study_service, "generate_artifact_content", gen)
    study_service.process_artifact_job(db_session, artifact_id)
    assert len(provider_calls) == 1

    row = study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    assert row.status == STATUS_COMPLETED

    study_service.process_artifact_job(db_session, artifact_id)
    assert len(provider_calls) == 1
    db_session.refresh(row)
    assert row.status == STATUS_COMPLETED


def test_source_changed_after_prepare_aborts_provider(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(db_session, monkeypatch)
    provider_calls: list[str] = []

    def gen(*_a, **_k):
        provider_calls.append("gen")
        return _ok_flashcards()

    monkeypatch.setattr(study_service, "generate_artifact_content", gen)

    # After prepare, make source hash diverge.
    def changed_hash(db, *, owner_user_id, subject_id, source_selection_mode, meeting_ids, require_ready=True):
        return (
            "changed-after-prepare-hash",
            READY,
            [
                {
                    "meetingId": 101,
                    "transcriptHash": "th-101-new",
                    "analysisRunId": 11,
                    "analysisVersion": "education-study-v1",
                }
            ],
        )

    monkeypatch.setattr(study_service, "compute_current_source_hash", changed_hash)

    study_service.process_artifact_job(db_session, artifact_id)

    row = study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    assert row.status == STATUS_STALE
    assert row.error_code == "SOURCE_CHANGED_AFTER_PREPARE"
    assert provider_calls == []


def test_broker_failure_redispatch_keeps_quota(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(db_session, monkeypatch)
    row = study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    quota_at = row.quota_confirmed_at
    assert quota_at is not None

    apply_calls: list[str] = []

    def flaky_apply_async(*args, **kwargs):
        apply_calls.append(kwargs.get("task_id") or "")
        if len(apply_calls) == 1:
            raise RuntimeError("broker unavailable")
        return SimpleNamespace(id=kwargs.get("task_id"))

    monkeypatch.setattr("app.tasks.generate_study_artifact.apply_async", flaky_apply_async)
    monkeypatch.setattr("app.tasks.generate_subject_synthesis.apply_async", flaky_apply_async)

    with pytest.raises(RuntimeError, match="broker unavailable"):
        study_service.dispatch_study_jobs(
            db_session, owner_user_id=1, synthesis_ids=[], artifact_ids=[artifact_id]
        )

    db_session.refresh(row)
    assert row.status == STATUS_QUEUED
    assert row.dispatch_requested_at is None
    assert row.celery_task_id is None
    assert row.dispatch_attempt_count >= 1
    assert row.quota_confirmed_at == quota_at

    # Allow immediate retry (backoff would otherwise block claim_dispatch).
    row.next_dispatch_retry_at = datetime.utcnow() - timedelta(seconds=1)
    db_session.commit()

    second = study_service.dispatch_study_jobs(
        db_session, owner_user_id=1, synthesis_ids=[], artifact_ids=[artifact_id]
    )
    assert second["dispatchedArtifactIds"] == [artifact_id]
    assert len(apply_calls) == 2
    db_session.refresh(row)
    assert row.quota_confirmed_at == quota_at


def test_reconcile_enqueues_orphan_not_terminal(db_session, monkeypatch):
    _patch_sources(monkeypatch)
    orphan_id = _prepare_flashcards(db_session, monkeypatch)

    # Terminal + deleted rows must not be enqueued.
    completed = study_service.prepare_artifacts(
        db_session,
        owner_user_id=1,
        subject_id=10,
        meeting_ids=[101],
        artifact_types=["MIND_MAP"],
        source_selection_mode=MODE_EXPLICIT,
        options={"language": "vi", "flashcardCount": 5},
    )
    completed_id = int(completed["newlyCreatedArtifactIds"][0])
    crow = study_service._live_artifact_query(db_session).filter_by(id=completed_id).first()
    crow.status = STATUS_COMPLETED
    crow.quota_confirmed_at = datetime.utcnow()
    crow.dispatch_requested_at = None
    db_session.commit()

    failed = study_service.prepare_artifacts(
        db_session,
        owner_user_id=1,
        subject_id=10,
        meeting_ids=[102],
        artifact_types=["EXAM_BRIEF"],
        source_selection_mode=MODE_EXPLICIT,
        options={"language": "vi", "flashcardCount": 5},
    )
    failed_id = int(failed["newlyCreatedArtifactIds"][0])
    frow = study_service._live_artifact_query(db_session).filter_by(id=failed_id).first()
    frow.status = STATUS_FAILED
    frow.quota_confirmed_at = datetime.utcnow()
    frow.dispatch_requested_at = None
    db_session.commit()

    deleted = study_service.prepare_artifacts(
        db_session,
        owner_user_id=1,
        subject_id=10,
        meeting_ids=[101, 102],
        artifact_types=["ESSAY_QUESTIONS"],
        source_selection_mode=MODE_EXPLICIT,
        options={"language": "vi", "essayQuestionCount": 1},
    )
    deleted_id = int(deleted["newlyCreatedArtifactIds"][0])
    drow = study_service._live_artifact_query(db_session).filter_by(id=deleted_id).first()
    drow.quota_confirmed_at = datetime.utcnow()
    drow.dispatch_requested_at = None
    drow.deleted_at = datetime.utcnow()
    db_session.commit()

    enqueued: list[int] = []

    class FakeAsync:
        def apply_async(self, args=None, task_id=None):
            enqueued.append(int(args[0]))
            return SimpleNamespace(id=task_id)

    monkeypatch.setattr("app.tasks.generate_study_artifact", FakeAsync())
    monkeypatch.setattr("app.tasks.generate_subject_synthesis", FakeAsync())

    result = study_service.reconcile_study_generation_jobs(db_session)
    assert result["enqueuedArtifact"] >= 1
    assert orphan_id in enqueued
    assert completed_id not in enqueued
    assert failed_id not in enqueued
    assert deleted_id not in enqueued


def test_validate_mcq_rejects_duplicate_option_ids():
    allowed = {101: {"seg-1"}}
    raw = {
        "questions": [
            {
                "id": "q1",
                "question": "What is OSI?",
                "options": [
                    {"id": "A", "text": "opt-a"},
                    {"id": "A", "text": "opt-b"},
                    {"id": "B", "text": "opt-c"},
                    {"id": "C", "text": "opt-d"},
                ],
                "correctOptionId": "A",
                "explanation": "because layers",
                "difficulty": "EASY",
                "sourceMeetingIds": [101],
                "sourceSegmentIds": ["seg-1"],
            }
        ]
        + [
            {
                "id": f"q{i}",
                "question": f"Valid Q{i}?",
                "options": [
                    {"id": "A", "text": f"a-{i}"},
                    {"id": "B", "text": f"b-{i}"},
                    {"id": "C", "text": f"c-{i}"},
                    {"id": "D", "text": f"d-{i}"},
                ],
                "correctOptionId": "B",
                "explanation": "ok",
                "difficulty": "EASY",
                "sourceMeetingIds": [101],
                "sourceSegmentIds": ["seg-1"],
            }
            for i in range(2, 7)
        ]
    }
    result = validate_mcq(raw, max_count=10, allowed_segments_by_meeting=allowed)
    ids = [q["id"] for q in result["questions"]]
    assert "q1" not in ids
    assert all(len({o["id"] for o in q["options"]}) == 4 for q in result["questions"])


def test_hierarchical_reducer_multi_round_calls_gemini(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "subject_synthesis_max_meetings_per_batch", 1)
    monkeypatch.setattr(settings, "subject_synthesis_max_input_tokens", 1)
    monkeypatch.setattr(settings, "subject_synthesis_max_parallel_batches", 1)
    monkeypatch.setattr(settings, "subject_synthesis_chars_per_token", 4)

    gemini_calls: list[str] = []

    def call_gemini(*, prompt: str, system_prompt: str, response_schema=None) -> str:
        # build_reducer_prompt starts with "Merge batch synthesis..."
        kind = "reduce" if "Merge batch" in prompt else "batch"
        gemini_calls.append(kind)
        return json.dumps(
            {
                "subjectOverview": "Networking",
                "learningObjectives": ["OSI"],
                "chapters": [
                    {
                        "title": "OSI",
                        "summary": "layers",
                        "sourceMeetingIds": [101],
                        "sourceSegmentIds": ["seg-1"],
                    }
                ],
                "importantTerms": [],
                "mustRemember": [],
                "knowledgeGaps": [],
                "examFocus": [],
            }
        )

    many_sources = []
    for i in range(4):
        mid = 200 + i
        many_sources.append(
            {
                "meetingId": mid,
                "transcriptHash": f"th-{mid}",
                "analysisRunId": mid,
                "analysisVersion": "education-study-v1",
                "ready": True,
                "educationStudy": {
                    "overview": f"Topic {i} " + ("detail " * 20),
                    "sections": [{"title": f"S{i}", "summary": "x" * 40}],
                },
                "allowedSegmentIds": [f"seg-{mid}"],
            }
        )

    result = run_hierarchical_synthesis(many_sources, language="vi", call_gemini=call_gemini)
    assert result["subjectOverview"]
    reduce_calls = sum(1 for c in gemini_calls if c == "reduce")
    batch_calls = sum(1 for c in gemini_calls if c == "batch")
    assert batch_calls >= 4
    assert reduce_calls >= 1
    assert len(gemini_calls) > batch_calls  # multi-round reduce path invoked gemini again


def test_get_artifact_empty_subject_is_stale(db_session, monkeypatch):
    """GET after ALL_READY subject empties meeting list → STALE flag."""
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
    row.content_json = {"cards": []}
    db_session.commit()

    got = study_service.get_artifact_for_owner(
        db_session,
        artifact_id=artifact_id,
        owner_user_id=1,
        meeting_ids_for_stale=[],
    )
    assert got["stale"] is True
    assert got["status"] == "STALE"
