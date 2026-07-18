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


def test_phase2_technical_smoke_synthesis_and_artifacts(smoke_client):
    client, db, dispatch_calls = smoke_client

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

    idor = client.get(
        f"/api/internal/study-artifacts/{artifact_ids[0]}?ownerUserId=999",
        headers=HEADERS,
    )
    assert idor.status_code in {403, 404}
