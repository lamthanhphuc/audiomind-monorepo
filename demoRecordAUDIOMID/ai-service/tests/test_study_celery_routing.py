"""Celery routing and study job lifecycle without real Gemini."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.celery_app import celery_app
from app.config import get_settings
from app.services.study import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PROCESSING,
    STATUS_QUEUED,
    StudyTransientError,
    StudyValidationError,
)
from app.tasks import generate_study_artifact, generate_subject_synthesis


def test_study_tasks_are_bound_to_study_generation_queue():
    settings = get_settings()
    queue = settings.celery_study_generation_queue
    assert queue == "study_generation"
    routes = celery_app.conf.task_routes or {}
    assert routes["app.tasks.generate_subject_synthesis"]["queue"] == queue
    assert routes["app.tasks.generate_study_artifact"]["queue"] == queue
    assert generate_subject_synthesis.name == "app.tasks.generate_subject_synthesis"
    assert generate_study_artifact.name == "app.tasks.generate_study_artifact"


def test_process_artifact_job_lifecycle_queued_to_completed(monkeypatch):
    from app.services.study import service as study_service

    row = SimpleNamespace(
        id=7,
        owner_user_id=1,
        subject_id=12,
        synthesis_id=None,
        artifact_type="FLASHCARDS",
        status=STATUS_QUEUED,
        source_hash="hash",
        source_selection_mode="EXPLICIT",
        options_json={"language": "vi", "flashcardCount": 5, "multipleChoiceCount": 5, "essayQuestionCount": 1, "difficulty": "MIXED"},
        sources=[SimpleNamespace(meeting_id=101)],
        content_json=None,
        error_code=None,
        error_message=None,
        generated_at=None,
        updated_at=None,
    )
    db = MagicMock()
    monkeypatch.setattr(study_service, "claim_processing_artifact", lambda *_a, **_k: row)
    monkeypatch.setattr(
        study_service,
        "fetch_subject_meeting_ids",
        lambda subject_id, owner_user_id: [101],
    )
    monkeypatch.setattr(
        study_service,
        "compute_current_source_hash",
        lambda *a, **k: (
            "hash",
            [
                {
                    "meetingId": 101,
                    "ready": True,
                    "educationStudy": {"overview": "o", "sections": [{"title": "t", "summary": "s"}]},
                    "allowedSegmentIds": ["seg-1"],
                }
            ],
            [],
        ),
    )
    monkeypatch.setattr(
        study_service,
        "generate_artifact_content",
        lambda *a, **k: {"cards": [{"id": "c1", "front": "q", "back": "a"}]},
    )

    study_service.process_artifact_job(db, 7)
    assert row.status == STATUS_COMPLETED
    assert row.content_json is not None
    assert db.commit.call_count >= 1


def test_process_artifact_job_validation_does_not_raise_retryable(monkeypatch):
    from app.services.study import service as study_service

    row = SimpleNamespace(
        id=8,
        owner_user_id=1,
        subject_id=12,
        synthesis_id=None,
        artifact_type="FLASHCARDS",
        status=STATUS_QUEUED,
        source_hash="hash",
        source_selection_mode="EXPLICIT",
        options_json={"language": "vi", "flashcardCount": 5, "multipleChoiceCount": 5, "essayQuestionCount": 1, "difficulty": "MIXED"},
        sources=[SimpleNamespace(meeting_id=101)],
        content_json=None,
        error_code=None,
        error_message=None,
        generated_at=None,
        updated_at=None,
    )
    db = MagicMock()
    monkeypatch.setattr(study_service, "claim_processing_artifact", lambda *_a, **_k: row)
    monkeypatch.setattr(
        study_service,
        "fetch_subject_meeting_ids",
        lambda subject_id, owner_user_id: [101],
    )
    monkeypatch.setattr(
        study_service,
        "compute_current_source_hash",
        lambda *a, **k: ("hash", [{"meetingId": 101, "ready": True, "educationStudy": {}, "allowedSegmentIds": []}], []),
    )

    def boom(*_a, **_k):
        raise StudyValidationError("INVALID_FLASHCARDS", "bad")

    monkeypatch.setattr(study_service, "generate_artifact_content", boom)
    study_service.process_artifact_job(db, 8)
    assert row.status == STATUS_FAILED
    assert row.error_code == "INVALID_FLASHCARDS"


def test_process_artifact_job_transient_raises(monkeypatch):
    from app.services.study import service as study_service

    row = SimpleNamespace(
        id=9,
        owner_user_id=1,
        subject_id=12,
        synthesis_id=None,
        artifact_type="FLASHCARDS",
        status=STATUS_QUEUED,
        source_hash="hash",
        source_selection_mode="EXPLICIT",
        options_json={"language": "vi", "flashcardCount": 5, "multipleChoiceCount": 5, "essayQuestionCount": 1, "difficulty": "MIXED"},
        sources=[SimpleNamespace(meeting_id=101)],
        content_json=None,
        error_code=None,
        error_message=None,
        generated_at=None,
        updated_at=None,
        processing_started_at="started",
        last_heartbeat_at="beat",
    )
    db = MagicMock()
    monkeypatch.setattr(study_service, "claim_processing_artifact", lambda *_a, **_k: row)
    monkeypatch.setattr(
        study_service,
        "compute_current_source_hash",
        lambda *a, **k: ("hash", [{"meetingId": 101, "ready": True, "educationStudy": {}, "allowedSegmentIds": []}], []),
    )
    monkeypatch.setattr(
        study_service,
        "_load_compatible_synthesis_content",
        lambda *a, **k: None,
    )

    def boom(*_a, **_k):
        raise StudyTransientError("network")

    monkeypatch.setattr(study_service, "generate_artifact_content", boom)
    with pytest.raises(StudyTransientError):
        study_service.process_artifact_job(db, 9)
    # Transient errors requeue to QUEUED so Celery retry can re-claim.
    assert row.status == STATUS_QUEUED
    assert row.processing_started_at is None
    assert row.error_code == "TRANSIENT_AI_ERROR"


def test_worker_skips_when_claim_fails(monkeypatch):
    from app.services.study import service as study_service

    existing = SimpleNamespace(id=9, status=STATUS_COMPLETED)
    db = MagicMock()
    monkeypatch.setattr(study_service, "claim_processing_artifact", lambda *_a, **_k: None)
    query = MagicMock()
    db.query.return_value = query
    query.filter.return_value = query
    query.first.return_value = existing
    called = {"gemini": False}

    def boom(*_a, **_k):
        called["gemini"] = True
        return {}

    monkeypatch.setattr(study_service, "generate_artifact_content", boom)
    study_service.process_artifact_job(db, 9)
    assert called["gemini"] is False


def test_generate_study_artifact_task_retries_transient(monkeypatch):
    task = generate_study_artifact
    monkeypatch.setattr(
        "app.services.study.service.process_artifact_job",
        lambda *_a, **_k: (_ for _ in ()).throw(StudyTransientError("boom")),
    )
    monkeypatch.setattr("app.tasks.SessionLocal", lambda: MagicMock(close=lambda: None))
    with patch.object(task, "retry", side_effect=StudyTransientError("retry")) as retry:
        with pytest.raises(StudyTransientError):
            task.run(55)
        retry.assert_called()


def test_generate_study_artifact_task_no_retry_on_validation(monkeypatch):
    task = generate_study_artifact

    def fail_validation(db, artifact_id):
        # process_artifact_job swallows validation; simulate by returning
        return None

    monkeypatch.setattr("app.services.study.service.process_artifact_job", fail_validation)
    monkeypatch.setattr("app.tasks.SessionLocal", lambda: MagicMock(close=lambda: None))
    with patch.object(task, "retry") as retry:
        task.run(56)
        retry.assert_not_called()


def test_status_transitions_queued_processing_completed():
    """Document expected status progression for smoke/stub verification."""
    statuses = [STATUS_QUEUED, STATUS_PROCESSING, STATUS_COMPLETED]
    assert statuses[0] == "QUEUED"
    assert statuses[1] == "PROCESSING"
    assert statuses[2] == "COMPLETED"
