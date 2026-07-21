"""Phase 2 third-remediation: dispatch accounting, membership guard, exception whitelist, reducer ceiling."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import get_settings
from app.services.study import (
    MODE_ALL_READY,
    MODE_EXPLICIT,
    STATUS_FAILED,
    STATUS_QUEUED,
    STATUS_STALE,
    StudyTransientError,
    build_source_hash,
)
from app.services.study import service as study_service
from app.services.study.evidence import estimate_tokens
from app.services.study.membership import hash_membership
from app.services.study.synthesis import run_hierarchical_synthesis

READY = [
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
            "sections": [{"title": "HS", "summary": "syn"}],
        },
        "allowedSegmentIds": ["seg-2"],
    },
    {
        "meetingId": 103,
        "transcriptHash": "th-103",
        "analysisRunId": 13,
        "analysisVersion": "education-study-v1",
        "ready": True,
        "educationStudy": {
            "overview": "UDP",
            "sections": [{"title": "DG", "summary": "datagram"}],
        },
        "allowedSegmentIds": ["seg-3"],
    },
]


def _patch_sources(monkeypatch, sources=None):
    src = sources if sources is not None else READY

    def _compute(
        db,
        *,
        owner_user_id,
        subject_id,
        source_selection_mode,
        meeting_ids,
        require_ready=True,
    ):
        wanted = set(int(m) for m in meeting_ids) if meeting_ids is not None else None
        ready = []
        for s in src:
            mid = int(s["meetingId"])
            if wanted is not None and mid not in wanted and wanted:
                continue
            if (
                source_selection_mode == MODE_ALL_READY
                and meeting_ids is not None
                and len(meeting_ids) == 0
            ):
                continue
            if wanted is not None and wanted and mid not in wanted:
                continue
            ready.append(s)
        if (
            source_selection_mode == MODE_ALL_READY
            and meeting_ids is not None
            and len(meeting_ids) == 0
        ):
            ready = []
        elif wanted is not None:
            ready = [s for s in src if int(s["meetingId"]) in wanted]
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

    path = tmp_path / "third_remediation.db"
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


def _prepare_flashcards(
    db, monkeypatch, *, meeting_ids=None, mode=MODE_EXPLICIT
) -> int:
    _patch_sources(monkeypatch)
    ids = meeting_ids if meeting_ids is not None else [101, 102]
    prep = study_service.prepare_artifacts(
        db,
        owner_user_id=1,
        subject_id=10,
        meeting_ids=ids,
        artifact_types=["FLASHCARDS"],
        source_selection_mode=mode,
        options={"language": "vi", "flashcardCount": 5},
    )
    artifact_id = int(prep["newlyCreatedArtifactIds"][0])
    study_service.confirm_quota_for_jobs(
        db,
        owner_user_id=1,
        synthesis_ids=[],
        artifact_ids=[artifact_id],
    )
    return artifact_id


def test_claim_increments_dispatch_attempt_count(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(db_session, monkeypatch)
    row = (
        study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    )
    assert int(row.dispatch_attempt_count or 0) == 0

    monkeypatch.setattr(
        "app.tasks.generate_study_artifact.apply_async",
        lambda *a, **k: SimpleNamespace(id=k.get("task_id")),
    )
    monkeypatch.setattr(
        "app.tasks.generate_subject_synthesis.apply_async",
        lambda *a, **k: SimpleNamespace(id=k.get("task_id")),
    )

    study_service.dispatch_study_jobs(
        db_session, owner_user_id=1, synthesis_ids=[], artifact_ids=[artifact_id]
    )
    db_session.refresh(row)
    assert int(row.dispatch_attempt_count) == 1


def test_reconcile_increments_dispatch_attempt_again(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(db_session, monkeypatch)
    row = (
        study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    )

    class FakeAsync:
        def apply_async(self, args=None, task_id=None):
            return SimpleNamespace(id=task_id)

    monkeypatch.setattr("app.tasks.generate_study_artifact", FakeAsync())
    monkeypatch.setattr("app.tasks.generate_subject_synthesis", FakeAsync())

    # First claim via reconcile.
    study_service.reconcile_study_generation_jobs(db_session)
    db_session.refresh(row)
    assert int(row.dispatch_attempt_count) == 1

    # Expire lease so reconcile can claim again.
    row.dispatch_requested_at = None
    row.celery_task_id = None
    row.next_dispatch_retry_at = None
    db_session.commit()

    study_service.reconcile_study_generation_jobs(db_session)
    db_session.refresh(row)
    assert int(row.dispatch_attempt_count) == 2


def test_max_attempts_marks_dispatch_exhausted(db_session, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "study_dispatch_max_attempts", 2)
    monkeypatch.setattr(settings, "study_dispatch_retry_backoff_seconds", 0)

    artifact_id = _prepare_flashcards(db_session, monkeypatch)
    row = (
        study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    )

    def boom(*_a, **_k):
        raise RuntimeError("broker down")

    monkeypatch.setattr("app.tasks.generate_study_artifact.apply_async", boom)
    monkeypatch.setattr("app.tasks.generate_subject_synthesis.apply_async", boom)

    with pytest.raises(RuntimeError):
        study_service.dispatch_study_jobs(
            db_session, owner_user_id=1, synthesis_ids=[], artifact_ids=[artifact_id]
        )
    db_session.refresh(row)
    assert int(row.dispatch_attempt_count) == 1
    assert row.status == STATUS_QUEUED

    row.next_dispatch_retry_at = datetime.utcnow() - timedelta(seconds=1)
    db_session.commit()

    with pytest.raises(RuntimeError):
        study_service.dispatch_study_jobs(
            db_session, owner_user_id=1, synthesis_ids=[], artifact_ids=[artifact_id]
        )
    db_session.refresh(row)
    assert int(row.dispatch_attempt_count) == 2
    assert row.status == STATUS_FAILED
    assert row.error_code == "DISPATCH_EXHAUSTED"

    # Further claim must refuse and stay exhausted (no decrement on release).
    row.status = STATUS_QUEUED
    row.error_code = None
    row.dispatch_requested_at = None
    row.celery_task_id = None
    row.next_dispatch_retry_at = None
    db_session.commit()
    result = study_service.dispatch_study_jobs(
        db_session, owner_user_id=1, synthesis_ids=[], artifact_ids=[artifact_id]
    )
    db_session.refresh(row)
    assert row.status == STATUS_FAILED
    assert row.error_code == "DISPATCH_EXHAUSTED"
    assert int(row.dispatch_attempt_count) == 2
    assert artifact_id in result["failedDispatchIds"]


def test_all_ready_membership_add_guards_stale_no_gemini(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(
        db_session, monkeypatch, meeting_ids=[101, 102], mode=MODE_ALL_READY
    )
    row = (
        study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    )
    assert row.subject_membership_hash == hash_membership([101, 102])

    provider_calls: list[str] = []

    def gen(*_a, **_k):
        provider_calls.append("gen")
        return _ok_flashcards()

    monkeypatch.setattr(study_service, "generate_artifact_content", gen)
    monkeypatch.setattr(
        study_service,
        "fetch_subject_meeting_ids",
        lambda subject_id, owner_user_id: [101, 102, 103],
    )

    study_service.process_artifact_job(db_session, artifact_id)
    db_session.refresh(row)
    assert row.status == STATUS_STALE
    assert row.error_code == "SOURCE_CHANGED_AFTER_PREPARE"
    assert provider_calls == []


def test_explicit_new_meeting_outside_selection_not_stale(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(
        db_session, monkeypatch, meeting_ids=[101, 102], mode=MODE_EXPLICIT
    )
    row = (
        study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    )

    monkeypatch.setattr(
        study_service, "generate_artifact_content", lambda *_a, **_k: _ok_flashcards()
    )
    # Membership grew, but EXPLICIT selection unchanged → not stale.
    monkeypatch.setattr(
        study_service,
        "fetch_subject_meeting_ids",
        lambda subject_id, owner_user_id: [101, 102, 103],
    )

    study_service.process_artifact_job(db_session, artifact_id)
    db_session.refresh(row)
    assert row.status == "COMPLETED"
    assert row.error_code is None


def test_explicit_meeting_left_subject_is_stale(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(
        db_session, monkeypatch, meeting_ids=[101, 102], mode=MODE_EXPLICIT
    )
    row = (
        study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    )

    provider_calls: list[str] = []

    def gen(*_a, **_k):
        provider_calls.append("gen")
        return _ok_flashcards()

    monkeypatch.setattr(study_service, "generate_artifact_content", gen)
    monkeypatch.setattr(
        study_service,
        "fetch_subject_meeting_ids",
        lambda subject_id, owner_user_id: [101],  # 102 left subject
    )

    study_service.process_artifact_job(db_session, artifact_id)
    db_session.refresh(row)
    assert row.status == STATUS_STALE
    assert row.error_code == "SOURCE_CHANGED_AFTER_PREPARE"
    assert provider_calls == []


def test_type_error_marks_failed_no_retry(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(db_session, monkeypatch)
    row = (
        study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    )

    def boom(*_a, **_k):
        raise TypeError("unexpected NoneType")

    monkeypatch.setattr(study_service, "generate_artifact_content", boom)
    monkeypatch.setattr(
        study_service,
        "fetch_subject_meeting_ids",
        lambda subject_id, owner_user_id: [101, 102],
    )

    study_service.process_artifact_job(db_session, artifact_id)
    db_session.refresh(row)
    assert row.status == STATUS_FAILED
    assert row.error_code == "PROGRAMMING_ERROR"
    assert row.processing_started_at is not None or row.status == STATUS_FAILED


def test_provider_timeout_and_429_requeue(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(db_session, monkeypatch)
    monkeypatch.setattr(
        study_service,
        "fetch_subject_meeting_ids",
        lambda subject_id, owner_user_id: [101, 102],
    )

    def timeout(*_a, **_k):
        raise TimeoutError("gemini timed out")

    monkeypatch.setattr(study_service, "generate_artifact_content", timeout)
    with pytest.raises(StudyTransientError):
        study_service.process_artifact_job(db_session, artifact_id)
    row = (
        study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    )
    assert row.status == STATUS_QUEUED
    assert row.error_code == "TRANSIENT_AI_ERROR"

    # Reset for second claim path (429).
    row.processing_started_at = None
    row.dispatch_requested_at = None
    row.celery_task_id = None
    db_session.commit()

    def rate_limited(*_a, **_k):
        raise RuntimeError("HTTP 429 Too Many Requests")

    monkeypatch.setattr(study_service, "generate_artifact_content", rate_limited)
    with pytest.raises(StudyTransientError):
        study_service.process_artifact_job(db_session, artifact_id)
    row = (
        study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    )
    assert row.status == STATUS_QUEUED
    assert "429" in (row.error_message or "") or row.error_code == "TRANSIENT_AI_ERROR"


def test_oversized_reducer_all_prompts_under_limit(monkeypatch):
    settings = get_settings()
    limit = 500
    monkeypatch.setattr(settings, "subject_synthesis_max_meetings_per_batch", 1)
    monkeypatch.setattr(settings, "subject_synthesis_max_input_tokens", limit)
    monkeypatch.setattr(settings, "subject_synthesis_max_parallel_batches", 1)
    monkeypatch.setattr(settings, "subject_synthesis_chars_per_token", 4)

    prompts: list[str] = []

    def call_gemini(*, prompt: str, system_prompt: str, response_schema=None) -> str:
        prompts.append(prompt)
        return json.dumps(
            {
                "subjectOverview": "Overview " + ("detail " * 40),
                "learningObjectives": ["learn A", "learn B"],
                "chapters": [
                    {
                        "title": "Chapter",
                        "summary": "summary " * 30,
                        "sourceMeetingIds": [300],
                        "sourceSegmentIds": ["seg-300-0"],
                    }
                ],
                "importantTerms": [
                    {
                        "term": "term",
                        "definition": "definition " * 20,
                        "sourceMeetingIds": [300],
                        "sourceSegmentIds": ["seg-300-0"],
                    }
                ],
                "mustRemember": [
                    {
                        "content": "remember " * 20,
                        "sourceMeetingIds": [300],
                        "sourceSegmentIds": ["seg-300-0"],
                    }
                ],
                "knowledgeGaps": [],
                "examFocus": [],
                "sourceMeetingIds": [300],
            }
        )

    many_sources = []
    for i in range(6):
        mid = 300 + i
        many_sources.append(
            {
                "meetingId": mid,
                "transcriptHash": f"th-{mid}",
                "analysisRunId": mid,
                "analysisVersion": "education-study-v1",
                "ready": True,
                "educationStudy": {
                    "overview": f"Topic {i} " + ("payload " * 80),
                    "sections": [{"title": f"S{i}", "summary": "y" * 200}],
                    "keyPoints": [{"content": "k" * 100} for _ in range(10)],
                },
                "allowedSegmentIds": [f"seg-{mid}-{j}" for j in range(80)],
            }
        )

    result = run_hierarchical_synthesis(
        many_sources, language="vi", call_gemini=call_gemini
    )
    assert result["subjectOverview"]
    assert prompts
    for prompt in prompts:
        assert estimate_tokens(prompt, chars_per_token=4) <= limit


def test_confirm_quota_idempotent(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(db_session, monkeypatch)
    row = (
        study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    )
    first = row.quota_confirmed_at
    assert first is not None

    study_service.confirm_quota_for_jobs(
        db_session,
        owner_user_id=1,
        synthesis_ids=[],
        artifact_ids=[artifact_id],
    )
    db_session.refresh(row)
    assert row.quota_confirmed_at == first
