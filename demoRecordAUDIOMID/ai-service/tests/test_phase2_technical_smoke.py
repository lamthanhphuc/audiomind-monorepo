"""Phase 2 technical HTTP smoke with fake AI provider (no live Gemini).

HTTP (ASGI) → internal token → prepare → Celery eager dispatch →
fake gemini → validators → DB → GET COMPLETED.
"""

from __future__ import annotations

import json
import os

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "phase2-smoke-token")
os.environ.setdefault("AI_PROVIDER", "fake")

from app.celery_app import celery_app
from app.database import get_db
from app.main import app
from app.services.study import service as study_service
from tests.httpx_asgi import asgi_client

TOKEN = "phase2-smoke-token"
HEADERS = {"X-Internal-Service-Token": TOKEN}

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


def _patch_ready_sources(monkeypatch):
    def _compute(db, *, owner_user_id, subject_id, source_selection_mode, meeting_ids, require_ready=True):
        from app.services.study import build_source_hash

        source_hash = build_source_hash(
            subject_id=subject_id,
            source_selection_mode=source_selection_mode,
            sources=READY_SOURCES,
        )
        return source_hash, READY_SOURCES, READY_SOURCES

    monkeypatch.setattr(study_service, "compute_current_source_hash", _compute)


def _fake_gemini(*, prompt: str, system_prompt: str, response_schema=None) -> str:
    # Match on the Generate <TYPE> prefix from generate_artifact_content / synthesis prompts.
    if "Generate MIND_MAP" in prompt or "type MIND_MAP" in system_prompt:
        return json.dumps(
            {
                "root": {"id": "root", "label": "Subject", "type": "SUBJECT"},
                "nodes": [
                    {
                        "id": "n1",
                        "parentId": "root",
                        "label": "OSI",
                        "type": "TOPIC",
                        "sourceMeetingIds": [101],
                        "sourceSegmentIds": ["seg-1"],
                    }
                ],
                "edges": [{"source": "root", "target": "n1", "relation": "CONTAINS"}],
            }
        )
    if "Generate FLASHCARDS" in prompt or "type FLASHCARDS" in system_prompt:
        cards = [
            {
                "id": f"c{i}",
                "front": f"OSI layer {i}?",
                "back": f"Answer {i}",
                "difficulty": "EASY",
                "sourceMeetingIds": [101],
                "sourceSegmentIds": ["seg-1"],
            }
            for i in range(1, 6)
        ]
        return json.dumps({"cards": cards}, ensure_ascii=False)
    if "Generate MULTIPLE_CHOICE" in prompt or "type MULTIPLE_CHOICE" in system_prompt:
        questions = [
            {
                "id": f"q{i}",
                "question": f"TCP question {i}?",
                "options": [
                    {"id": "a", "text": f"opt-a-{i}"},
                    {"id": "b", "text": f"opt-b-{i}"},
                    {"id": "c", "text": f"opt-c-{i}"},
                    {"id": "d", "text": f"opt-d-{i}"},
                ],
                "correctOptionId": "c",
                "explanation": "SYN SYN-ACK ACK",
                "difficulty": "MEDIUM",
                "sourceMeetingIds": [102],
                "sourceSegmentIds": ["seg-2"],
            }
            for i in range(1, 6)
        ]
        return json.dumps({"questions": questions})
    if "Generate ESSAY_QUESTIONS" in prompt or "type ESSAY_QUESTIONS" in system_prompt:
        questions = [
            {
                "id": f"e{i}",
                "question": f"Explain OSI part {i}",
                "suggestedOutline": ["layers"],
                "keyPoints": ["7 layers"],
                "rubric": [{"criterion": f"clarity-{i}", "points": 5}],
                "difficulty": "MEDIUM",
                "sourceMeetingIds": [101],
                "sourceSegmentIds": ["seg-1"],
            }
            for i in range(1, 4)
        ]
        return json.dumps({"questions": questions})
    if "Generate EXAM_BRIEF" in prompt or "type EXAM_BRIEF" in system_prompt:
        return json.dumps(
            {
                "overview": "Exam focus",
                "mustRemember": ["OSI"],
                "importantTerms": ["TCP"],
                "formulas": [],
                "commonMistakes": ["confusing L3/L4"],
                "likelyExamTopics": ["handshake"],
                "lastMinuteChecklist": ["review OSI"],
                "sourceMeetingIds": [101, 102],
            }
        )
    # Subject synthesis hierarchical prompts
    return json.dumps(
        {
            "subjectOverview": "Networking basics",
            "learningObjectives": ["Understand OSI"],
            "chapters": [
                {
                    "title": "OSI",
                    "summary": "Seven layers",
                    "sourceMeetingIds": [101],
                    "sourceSegmentIds": ["seg-1"],
                }
            ],
            "importantTerms": [{"term": "OSI", "definition": "model"}],
            "crossMeetingThemes": [],
        },
        ensure_ascii=False,
    )


@pytest.fixture()
def smoke_client(monkeypatch):
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    with engine.begin() as conn:
        for stmt in [
            """
            CREATE TABLE subject_synthesis (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                subject_id INTEGER NOT NULL,
                owner_user_id INTEGER NOT NULL,
                status VARCHAR(30) NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                title VARCHAR(255),
                content_json JSON,
                options_json JSON,
                source_hash VARCHAR(64) NOT NULL,
                options_hash VARCHAR(64),
                source_selection_mode VARCHAR(20) NOT NULL,
                subject_membership_hash VARCHAR(64),
                prompt_version VARCHAR(100),
                schema_version VARCHAR(100),
                idempotency_key VARCHAR(256) NOT NULL,
                generation_request_id VARCHAR(64),
                error_code VARCHAR(100),
                error_message TEXT,
                warnings_json JSON,
                generated_at DATETIME,
                dispatch_requested_at DATETIME,
                celery_task_id VARCHAR(128),
                processing_started_at DATETIME,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_heartbeat_at DATETIME,
                quota_confirmed_at DATETIME,
                dispatch_attempt_count INTEGER NOT NULL DEFAULT 0,
                last_dispatch_error TEXT,
                last_dispatch_error_at DATETIME,
                next_dispatch_retry_at DATETIME,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                deleted_at DATETIME
            )
            """,
            """
            CREATE UNIQUE INDEX uq_subject_synthesis_idempotency_live
            ON subject_synthesis(idempotency_key) WHERE deleted_at IS NULL
            """,
            """
            CREATE TABLE subject_synthesis_source (
                synthesis_id INTEGER NOT NULL,
                meeting_id INTEGER NOT NULL,
                transcript_hash VARCHAR(64),
                analysis_run_id INTEGER,
                analysis_version VARCHAR(100),
                created_at DATETIME NOT NULL,
                PRIMARY KEY (synthesis_id, meeting_id)
            )
            """,
            """
            CREATE TABLE study_artifact (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_user_id INTEGER NOT NULL,
                subject_id INTEGER NOT NULL,
                synthesis_id INTEGER,
                artifact_type VARCHAR(40) NOT NULL,
                status VARCHAR(30) NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                title VARCHAR(255),
                options_json JSON,
                content_json JSON,
                source_hash VARCHAR(64) NOT NULL,
                options_hash VARCHAR(64) NOT NULL,
                source_selection_mode VARCHAR(20) NOT NULL,
                subject_membership_hash VARCHAR(64),
                prompt_version VARCHAR(100),
                schema_version VARCHAR(100),
                idempotency_key VARCHAR(256) NOT NULL,
                generation_request_id VARCHAR(64),
                error_code VARCHAR(100),
                error_message TEXT,
                warnings_json JSON,
                generated_at DATETIME,
                dispatch_requested_at DATETIME,
                celery_task_id VARCHAR(128),
                processing_started_at DATETIME,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_heartbeat_at DATETIME,
                quota_confirmed_at DATETIME,
                dispatch_attempt_count INTEGER NOT NULL DEFAULT 0,
                last_dispatch_error TEXT,
                last_dispatch_error_at DATETIME,
                next_dispatch_retry_at DATETIME,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                deleted_at DATETIME
            )
            """,
            """
            CREATE UNIQUE INDEX uq_study_artifact_idempotency_live
            ON study_artifact(idempotency_key) WHERE deleted_at IS NULL
            """,
            """
            CREATE TABLE study_artifact_source (
                artifact_id INTEGER NOT NULL,
                meeting_id INTEGER NOT NULL,
                transcript_hash VARCHAR(64),
                analysis_run_id INTEGER,
                analysis_version VARCHAR(100),
                created_at DATETIME NOT NULL,
                PRIMARY KEY (artifact_id, meeting_id)
            )
            """,
        ]:
            conn.execute(text(stmt))

    SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
    db = SessionLocal()

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    monkeypatch.setattr(
        "app.services.internal_service_auth._configured_internal_token",
        lambda settings=None: TOKEN,
    )
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", TOKEN)
    _patch_ready_sources(monkeypatch)
    monkeypatch.setattr(study_service, "_gemini_caller", lambda: _fake_gemini)

    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True

    dispatch_calls: list[tuple[str, int]] = []
    from app import tasks as tasks_module

    original_syn = tasks_module.generate_subject_synthesis.apply_async
    original_art = tasks_module.generate_study_artifact.apply_async

    def syn_apply_async(*args, **kwargs):
        call_args = kwargs.get("args") or (args[0] if args else [])
        synthesis_id = call_args[0] if call_args else None
        dispatch_calls.append(("synthesis", int(synthesis_id)))
        return original_syn(*args, **kwargs)

    def art_apply_async(*args, **kwargs):
        call_args = kwargs.get("args") or (args[0] if args else [])
        artifact_id = call_args[0] if call_args else None
        dispatch_calls.append(("artifact", int(artifact_id)))
        return original_art(*args, **kwargs)

    monkeypatch.setattr(tasks_module.generate_subject_synthesis, "apply_async", syn_apply_async)
    monkeypatch.setattr(tasks_module.generate_study_artifact, "apply_async", art_apply_async)

    # Tasks use SessionLocal from app.database — point them at our smoke DB.
    monkeypatch.setattr("app.database.SessionLocal", SessionLocal)
    monkeypatch.setattr("app.tasks.SessionLocal", SessionLocal)

    with asgi_client(app) as client:
        yield client, db, dispatch_calls

    app.dependency_overrides.clear()
    celery_app.conf.task_always_eager = False
    db.close()
    engine.dispose()


def _confirm_quota(client, *, synthesis_ids=None, artifact_ids=None):
    resp = client.post(
        "/api/internal/study/confirm-quota",
        headers=HEADERS,
        json={
            "ownerUserId": 1,
            "synthesisIds": synthesis_ids or [],
            "artifactIds": artifact_ids or [],
        },
    )
    assert resp.status_code == 200, resp.text
    return resp


def test_phase2_technical_smoke_synthesis_and_artifacts(smoke_client, monkeypatch):
    """11-item Phase 2 smoke checklist (HTTP + unit edges)."""
    client, db, dispatch_calls = smoke_client
    passed: list[str] = []

    # 1) Internal auth denial
    denied = client.post(
        "/api/internal/subjects/10/synthesis/prepare",
        headers={"X-Internal-Service-Token": "wrong"},
        json={
            "ownerUserId": 1,
            "subjectId": 10,
            "meetingIds": [101, 102],
            "sourceSelectionMode": "EXPLICIT",
        },
    )
    assert denied.status_code in {401, 403}
    passed.append("1-auth-denied")

    # 2) Synthesis prepare → confirm-quota → dispatch → COMPLETED
    prep = client.post(
        "/api/internal/subjects/10/synthesis/prepare",
        headers=HEADERS,
        json={
            "ownerUserId": 1,
            "subjectId": 10,
            "meetingIds": [101, 102],
            "sourceSelectionMode": "EXPLICIT",
            "language": "vi",
        },
    )
    assert prep.status_code == 200, prep.text
    synthesis_id = int(prep.json()["synthesis"]["id"])
    assert prep.json()["synthesis"]["status"] == "QUEUED"

    _confirm_quota(client, synthesis_ids=[synthesis_id])
    dispatched = client.post(
        "/api/internal/study/dispatch",
        headers=HEADERS,
        json={"ownerUserId": 1, "synthesisIds": [synthesis_id], "artifactIds": []},
    )
    assert dispatched.status_code == 200, dispatched.text
    assert ("synthesis", synthesis_id) in dispatch_calls

    got = client.get(
        f"/api/internal/subjects/10/synthesis?ownerUserId=1&meetingIds=101,102",
        headers=HEADERS,
    )
    assert got.status_code == 200, got.text
    syn = got.json()
    assert syn["status"] == "COMPLETED"
    assert syn["content"]["subjectOverview"]
    assert syn.get("promptVersion") or syn.get("prompt_version")
    assert syn["sources"]
    passed.append("2-synthesis-completed")

    # 3) All five artifact types COMPLETED
    types = [
        "MIND_MAP",
        "FLASHCARDS",
        "MULTIPLE_CHOICE",
        "ESSAY_QUESTIONS",
        "EXAM_BRIEF",
    ]
    prep_a = client.post(
        "/api/internal/study-artifacts/prepare",
        headers=HEADERS,
        json={
            "ownerUserId": 1,
            "subjectId": 10,
            "meetingIds": [101, 102],
            "artifactTypes": types,
            "sourceSelectionMode": "EXPLICIT",
            "options": {
                "language": "vi",
                "flashcardCount": 5,
                "multipleChoiceCount": 5,
                "essayQuestionCount": 3,
            },
            "synthesisId": synthesis_id,
        },
    )
    assert prep_a.status_code == 200, prep_a.text
    artifact_ids = [int(x) for x in prep_a.json()["newlyCreatedArtifactIds"]]
    assert len(artifact_ids) == 5

    _confirm_quota(client, artifact_ids=artifact_ids)
    before_art = len([c for c in dispatch_calls if c[0] == "artifact"])
    disp = client.post(
        "/api/internal/study/dispatch",
        headers=HEADERS,
        json={"ownerUserId": 1, "synthesisIds": [], "artifactIds": artifact_ids},
    )
    assert disp.status_code == 200, disp.text
    assert len([c for c in dispatch_calls if c[0] == "artifact"]) == before_art + 5

    for aid in artifact_ids:
        resp = client.get(
            f"/api/internal/study-artifacts/{aid}?ownerUserId=1&meetingIds=101,102",
            headers=HEADERS,
        )
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        assert payload["status"] == "COMPLETED", payload
        assert payload["content"]
    passed.append("3-artifacts-completed")

    # 4) Cache hit (no new dispatch)
    before = len([c for c in dispatch_calls if c[0] == "artifact"])
    prep_cache = client.post(
        "/api/internal/study-artifacts/prepare",
        headers=HEADERS,
        json={
            "ownerUserId": 1,
            "subjectId": 10,
            "meetingIds": [101, 102],
            "artifactTypes": ["FLASHCARDS"],
            "sourceSelectionMode": "EXPLICIT",
            "options": {
                "language": "vi",
                "flashcardCount": 5,
                "multipleChoiceCount": 5,
                "essayQuestionCount": 3,
            },
        },
    )
    assert prep_cache.status_code == 200
    assert prep_cache.json()["cacheHitArtifactIds"]
    assert not prep_cache.json()["newlyCreatedArtifactIds"]
    assert len([c for c in dispatch_calls if c[0] == "artifact"]) == before
    passed.append("4-cache-hit")

    # 5) Force regen version bump
    regen = client.post(
        "/api/internal/study-artifacts/prepare",
        headers=HEADERS,
        json={
            "ownerUserId": 1,
            "subjectId": 10,
            "meetingIds": [101, 102],
            "artifactTypes": ["FLASHCARDS"],
            "sourceSelectionMode": "EXPLICIT",
            "options": {
                "language": "vi",
                "flashcardCount": 5,
                "multipleChoiceCount": 5,
                "essayQuestionCount": 3,
            },
            "force": True,
        },
    )
    assert regen.status_code == 200
    new_id = int(regen.json()["newlyCreatedArtifactIds"][0])
    assert new_id not in artifact_ids
    _confirm_quota(client, artifact_ids=[new_id])
    client.post(
        "/api/internal/study/dispatch",
        headers=HEADERS,
        json={"ownerUserId": 1, "synthesisIds": [], "artifactIds": [new_id]},
    )
    regen_get = client.get(
        f"/api/internal/study-artifacts/{new_id}?ownerUserId=1",
        headers=HEADERS,
    )
    assert regen_get.json()["status"] == "COMPLETED"
    assert regen_get.json()["version"] >= 2
    passed.append("5-force-regen")

    # 6) Soft delete
    deleted = client.delete(
        f"/api/internal/study-artifacts/{new_id}?ownerUserId=1",
        headers=HEADERS,
    )
    assert deleted.status_code == 200
    missing = client.get(
        f"/api/internal/study-artifacts/{new_id}?ownerUserId=1",
        headers=HEADERS,
    )
    assert missing.status_code in {403, 404}
    passed.append("6-soft-delete")

    # 7) Recreate after delete
    recreate = client.post(
        "/api/internal/study-artifacts/prepare",
        headers=HEADERS,
        json={
            "ownerUserId": 1,
            "subjectId": 10,
            "meetingIds": [101, 102],
            "artifactTypes": ["FLASHCARDS"],
            "sourceSelectionMode": "EXPLICIT",
            "options": {
                "language": "vi",
                "flashcardCount": 5,
                "multipleChoiceCount": 5,
                "essayQuestionCount": 3,
            },
            "force": True,
        },
    )
    assert recreate.status_code == 200
    assert recreate.json()["newlyCreatedArtifactIds"]
    passed.append("7-recreate-after-delete")

    # 8) IDOR protection
    idor = client.get(
        f"/api/internal/study-artifacts/{artifact_ids[0]}?ownerUserId=999",
        headers=HEADERS,
    )
    assert idor.status_code in {403, 404}
    passed.append("8-idor")

    # 9) Transient retry → second success
    from app.services.study import StudyTransientError, STATUS_COMPLETED, STATUS_QUEUED
    from app.services.study import service as study_service

    retry_prep = client.post(
        "/api/internal/study-artifacts/prepare",
        headers=HEADERS,
        json={
            "ownerUserId": 1,
            "subjectId": 10,
            "meetingIds": [101, 102],
            "artifactTypes": ["EXAM_BRIEF"],
            "sourceSelectionMode": "EXPLICIT",
            "options": {"language": "vi"},
            "force": True,
        },
    )
    assert retry_prep.status_code == 200
    retry_id = int(retry_prep.json()["newlyCreatedArtifactIds"][0])
    _confirm_quota(client, artifact_ids=[retry_id])

    provider_calls: list[str] = []
    original_gemini = study_service._gemini_caller()

    def flaky_gemini(*, prompt: str, system_prompt: str, response_schema=None) -> str:
        provider_calls.append("call")
        if len(provider_calls) == 1:
            raise StudyTransientError("transient")
        return original_gemini(prompt=prompt, system_prompt=system_prompt, response_schema=response_schema)

    monkeypatch.setattr(study_service, "_gemini_caller", lambda: flaky_gemini)
    with pytest.raises(StudyTransientError):
        study_service.process_artifact_job(db, retry_id)
    row = study_service._live_artifact_query(db).filter_by(id=retry_id).first()
    assert row.status == STATUS_QUEUED
    study_service.process_artifact_job(db, retry_id)
    db.refresh(row)
    assert row.status == STATUS_COMPLETED
    assert len(provider_calls) == 2
    monkeypatch.setattr(study_service, "_gemini_caller", lambda: original_gemini)
    passed.append("9-transient-retry")

    # 10) Source changed after prepare aborts provider
    stale_prep = client.post(
        "/api/internal/study-artifacts/prepare",
        headers=HEADERS,
        json={
            "ownerUserId": 1,
            "subjectId": 10,
            "meetingIds": [101, 102],
            "artifactTypes": ["MIND_MAP"],
            "sourceSelectionMode": "EXPLICIT",
            "options": {"language": "vi"},
            "force": True,
        },
    )
    stale_id = int(stale_prep.json()["newlyCreatedArtifactIds"][0])
    _confirm_quota(client, artifact_ids=[stale_id])
    stale_calls: list[str] = []

    def counting_gemini(*, prompt: str, system_prompt: str, response_schema=None) -> str:
        stale_calls.append("call")
        return original_gemini(prompt=prompt, system_prompt=system_prompt, response_schema=response_schema)

    monkeypatch.setattr(study_service, "_gemini_caller", lambda: counting_gemini)

    def changed_hash(db_arg, *, owner_user_id, subject_id, source_selection_mode, meeting_ids, require_ready=True):
        return ("hash-changed", READY_SOURCES, READY_SOURCES)

    monkeypatch.setattr(study_service, "compute_current_source_hash", changed_hash)
    study_service.process_artifact_job(db, stale_id)
    stale_row = study_service._live_artifact_query(db).filter_by(id=stale_id).first()
    assert stale_row.status == "STALE"
    assert stale_row.error_code == "SOURCE_CHANGED_AFTER_PREPARE"
    assert stale_calls == []
    _patch_ready_sources(monkeypatch)
    monkeypatch.setattr(study_service, "_gemini_caller", lambda: original_gemini)
    passed.append("10-source-changed-abort")

    # 11) Confirm-quota + dispatchable redispatch (broker fail then succeed)
    from types import SimpleNamespace
    from datetime import datetime, timedelta

    redis_prep = client.post(
        "/api/internal/study-artifacts/prepare",
        headers=HEADERS,
        json={
            "ownerUserId": 1,
            "subjectId": 10,
            "meetingIds": [101, 102],
            "artifactTypes": ["ESSAY_QUESTIONS"],
            "sourceSelectionMode": "EXPLICIT",
            "options": {"language": "vi", "essayQuestionCount": 1},
            "force": True,
        },
    )
    redis_id = int(redis_prep.json()["newlyCreatedArtifactIds"][0])
    _confirm_quota(client, artifact_ids=[redis_id])
    redis_row = study_service._live_artifact_query(db).filter_by(id=redis_id).first()
    quota_at = redis_row.quota_confirmed_at
    assert quota_at is not None

    apply_calls: list[str] = []

    def flaky_apply(*args, **kwargs):
        apply_calls.append("x")
        if len(apply_calls) == 1:
            raise RuntimeError("broker down")
        return SimpleNamespace(id=kwargs.get("task_id"))

    monkeypatch.setattr("app.tasks.generate_study_artifact.apply_async", flaky_apply)
    with pytest.raises(RuntimeError):
        study_service.dispatch_study_jobs(
            db, owner_user_id=1, synthesis_ids=[], artifact_ids=[redis_id]
        )
    db.refresh(redis_row)
    assert redis_row.quota_confirmed_at == quota_at
    redis_row.next_dispatch_retry_at = datetime.utcnow() - timedelta(seconds=1)
    db.commit()
    second = study_service.dispatch_study_jobs(
        db, owner_user_id=1, synthesis_ids=[], artifact_ids=[redis_id]
    )
    assert second["dispatchedArtifactIds"] == [redis_id]
    assert len(apply_calls) == 2
    db.refresh(redis_row)
    assert redis_row.quota_confirmed_at == quota_at
    # Third remediation: each successful claim increments attempt count (claim=1, then claim=2).
    assert int(redis_row.dispatch_attempt_count or 0) == 2
    passed.append("11-confirm-quota-redispatch")

    # 12) Programming error (TypeError) → FAILED without Celery requeue
    prog_prep = client.post(
        "/api/internal/study-artifacts/prepare",
        headers=HEADERS,
        json={
            "ownerUserId": 1,
            "subjectId": 10,
            "meetingIds": [101],
            "artifactTypes": ["FLASHCARDS"],
            "sourceSelectionMode": "EXPLICIT",
            "options": {"language": "vi", "flashcardCount": 5},
            "force": True,
        },
    )
    prog_id = int(prog_prep.json()["newlyCreatedArtifactIds"][0])
    _confirm_quota(client, artifact_ids=[prog_id])

    def boom_type(*_a, **_k):
        raise TypeError("smoke programming error")

    monkeypatch.setattr(study_service, "generate_artifact_content", boom_type)
    monkeypatch.setattr(
        study_service,
        "fetch_subject_meeting_ids",
        # Match stored sources from smoke READY_SOURCES patch ([101,102]).
        lambda subject_id, owner_user_id: [101, 102],
    )
    study_service.process_artifact_job(db, prog_id)
    prog_row = study_service._live_artifact_query(db).filter_by(id=prog_id).first()
    assert prog_row.status == "FAILED"
    assert prog_row.error_code == "PROGRAMMING_ERROR"
    passed.append("12-programming-error-no-retry")

    # MCQ duplicate option IDs rejected (unit assertion in smoke)
    from app.services.study.artifacts import validate_mcq
    from app.services.study import StudyValidationError

    with pytest.raises(StudyValidationError) as mcq_exc:
        validate_mcq(
            {
                "questions": [
                    {
                        "id": "dup",
                        "question": "Bad?",
                        "options": [
                            {"id": "A", "text": "a1"},
                            {"id": "A", "text": "a2"},
                            {"id": "B", "text": "b"},
                            {"id": "C", "text": "c"},
                        ],
                        "correctOptionId": "A",
                        "explanation": "x",
                        "sourceMeetingIds": [101],
                        "sourceSegmentIds": ["seg-1"],
                    }
                ]
            },
            max_count=5,
            allowed_segments_by_meeting={101: {"seg-1"}},
        )
    # Duplicate option IDs drop the question; with min count may raise INVALID_MCQ
    # or FAILED_VALIDATION depending on min enforcement.
    assert mcq_exc.value.code in {"INVALID_MCQ", "FAILED_VALIDATION"}

    assert len(passed) >= 12, passed
    print("PHASE2_SMOKE_PASS: " + ",".join(passed))
    print("Technical fake-provider smoke: PASS")
    print("Technical smoke: PASS")
    print("Real Gemini smoke: NOT RUN")
    print(
        "Final remediation coverage notes: quota UNKNOWN vs DENIED, "
        "membership internal pagination, artifact prompt ceilings, "
        "helper TypeError→PROGRAMMING_ERROR — see test_phase2_final_hardening.py"
    )
