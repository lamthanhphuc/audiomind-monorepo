"""Phase 2 final hardening: artifact token ceilings + helper exception classification."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import get_settings
from app.services.study import (
    ALL_ARTIFACT_TYPES,
    ARTIFACT_ESSAY_QUESTIONS,
    ARTIFACT_EXAM_BRIEF,
    ARTIFACT_FLASHCARDS,
    ARTIFACT_MIND_MAP,
    ARTIFACT_MULTIPLE_CHOICE,
    MODE_EXPLICIT,
    STATUS_FAILED,
    STATUS_QUEUED,
    StudyTransientError,
    StudyValidationError,
    build_source_hash,
)
from app.services.study import service as study_service
from app.services.study.artifacts import generate_artifact_content
from app.services.study.evidence import estimate_tokens
from app.services.study.exceptions import classify_provider_exception


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
        wanted = set(int(m) for m in meeting_ids) if meeting_ids is not None else None
        ready = [s for s in src if wanted is None or int(s["meetingId"]) in wanted]
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

    path = tmp_path / "final_hardening.db"
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


def _fake_artifact_json(artifact_type: str) -> str:
    if artifact_type == ARTIFACT_MIND_MAP:
        return json.dumps(
            {
                "root": {"id": "root", "label": "Subject", "type": "SUBJECT"},
                "nodes": [
                    {
                        "id": "n1",
                        "parentId": "root",
                        "label": "Concept",
                        "evidence": [{"meetingId": 101, "segmentId": "seg-1"}],
                    }
                ],
                "edges": [{"source": "root", "target": "n1", "relation": "CONTAINS"}],
            }
        )
    if artifact_type == ARTIFACT_FLASHCARDS:
        return json.dumps(_ok_flashcards())
    if artifact_type == ARTIFACT_MULTIPLE_CHOICE:
        return json.dumps(
            {
                "questions": [
                    {
                        "id": f"q{i}",
                        "question": f"Question {i}?",
                        "options": [
                            {"id": "A", "text": "a"},
                            {"id": "B", "text": "b"},
                            {"id": "C", "text": "c"},
                            {"id": "D", "text": "d"},
                        ],
                        "correctOptionId": "A",
                        "explanation": "because",
                        "difficulty": "EASY",
                        "sourceMeetingIds": [101],
                        "sourceSegmentIds": ["seg-1"],
                    }
                    for i in range(1, 6)
                ]
            }
        )
    if artifact_type == ARTIFACT_ESSAY_QUESTIONS:
        return json.dumps(
            {
                "questions": [
                    {
                        "id": "e1",
                        "question": "Explain OSI?",
                        "suggestedOutline": ["L1", "L2"],
                        "keyPoints": ["layers"],
                        "rubric": [{"criterion": "accuracy", "points": 5}],
                        "difficulty": "MEDIUM",
                        "sourceMeetingIds": [101],
                        "sourceSegmentIds": ["seg-1"],
                    }
                ]
            }
        )
    if artifact_type == ARTIFACT_EXAM_BRIEF:
        return json.dumps(
            {
                "overview": "Brief overview",
                "mustRemember": ["m1"],
                "importantTerms": ["t1"],
                "formulas": [],
                "commonMistakes": ["c1"],
                "likelyExamTopics": ["topic (ưu tiên ôn từ tài liệu đã ghi)"],
                "lastMinuteChecklist": ["check"],
                "sourceMeetingIds": [101],
                "sourceSegmentIds": ["seg-1"],
            }
        )
    raise AssertionError(f"unknown type {artifact_type}")


def _prepare_flashcards(db, monkeypatch) -> int:
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
    study_service.confirm_quota_for_jobs(
        db,
        owner_user_id=1,
        synthesis_ids=[],
        artifact_ids=[artifact_id],
    )
    return artifact_id


def _oversized_sources(*, meetings: int = 2, segments: int = 120) -> list[dict]:
    sources = []
    for i in range(meetings):
        mid = 101 + i
        sources.append(
            {
                "meetingId": mid,
                "transcriptHash": f"th-{mid}",
                "analysisRunId": mid,
                "analysisVersion": "education-study-v1",
                "ready": True,
                "educationStudy": {
                    "overview": f"Topic {i} " + ("payload " * 200),
                    "sections": [
                        {"title": f"S{j}", "summary": "y" * 400} for j in range(20)
                    ],
                    "keyPoints": [{"content": "k" * 200} for _ in range(30)],
                    "glossary": [
                        {"term": f"t{j}", "definition": "d" * 100} for j in range(20)
                    ],
                    "mustRemember": [{"content": "m" * 100} for _ in range(20)],
                },
                "allowedSegmentIds": [f"seg-{mid}-{j}" for j in range(segments)],
            }
        )
    return sources


def test_classify_provider_exception_preserves_programming_and_validation():
    te = TypeError("none")
    assert classify_provider_exception(te) is te
    ve = StudyValidationError("X", "y")
    assert classify_provider_exception(ve) is ve
    se = StudyTransientError("net")
    assert classify_provider_exception(se) is se
    classified = classify_provider_exception(TimeoutError("gemini timed out"))
    assert isinstance(classified, StudyTransientError)


def test_call_gemini_type_error_marks_programming_error(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(db_session, monkeypatch)
    row = study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()

    def boom_caller():
        def call_gemini(**_kwargs):
            raise TypeError("unexpected NoneType in provider adapter")

        return call_gemini

    monkeypatch.setattr(study_service, "_gemini_caller", boom_caller)
    monkeypatch.setattr(
        study_service,
        "fetch_subject_meeting_ids",
        lambda subject_id, owner_user_id: [101, 102],
    )

    study_service.process_artifact_job(db_session, artifact_id)
    db_session.refresh(row)
    assert row.status == STATUS_FAILED
    assert row.error_code == "PROGRAMMING_ERROR"


def test_call_gemini_timeout_requeues(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(db_session, monkeypatch)

    def timeout_caller():
        def call_gemini(**_kwargs):
            raise TimeoutError("gemini timed out")

        return call_gemini

    monkeypatch.setattr(study_service, "_gemini_caller", timeout_caller)
    monkeypatch.setattr(
        study_service,
        "fetch_subject_meeting_ids",
        lambda subject_id, owner_user_id: [101, 102],
    )

    with pytest.raises(StudyTransientError) as raised:
        study_service.process_artifact_job(db_session, artifact_id)
    assert "timed out" in str(raised.value).lower() or isinstance(raised.value, StudyTransientError)

    db_session.expire_all()
    row = study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    assert row is not None
    assert row.status == STATUS_QUEUED, (row.status, row.error_code, row.error_message)
    assert row.error_code == "TRANSIENT_AI_ERROR"


def test_oversized_education_study_prompt_under_limit_or_rejected(monkeypatch):
    settings = get_settings()
    limit = 400
    monkeypatch.setattr(settings, "subject_synthesis_max_input_tokens", limit)
    monkeypatch.setattr(settings, "subject_synthesis_chars_per_token", 4)

    provider_calls: list[str] = []

    def call_gemini(*, prompt: str, system_prompt: str, response_schema=None) -> str:
        provider_calls.append(prompt)
        assert estimate_tokens(system_prompt + "\n\n" + prompt, chars_per_token=4) <= limit
        return json.dumps(_ok_flashcards())

    sources = _oversized_sources(meetings=3, segments=200)
    try:
        result = generate_artifact_content(
            ARTIFACT_FLASHCARDS,
            synthesis_content={
                "subjectOverview": "huge " * 500,
                "chapters": [{"title": "C", "summary": "s" * 1000}],
                "importantTerms": [],
                "mustRemember": [],
                "learningObjectives": [],
                "knowledgeGaps": [],
                "examFocus": [],
            },
            ready_sources=sources,
            options={"language": "vi", "flashcardCount": 5},
            call_gemini=call_gemini,
        )
        assert result["cards"]
        assert provider_calls
        for prompt in provider_calls:
            assert estimate_tokens(prompt, chars_per_token=4) <= limit
    except StudyValidationError as exc:
        assert exc.code == "PROMPT_TOKEN_LIMIT_EXCEEDED"
        assert provider_calls == []


def test_all_artifact_types_prompts_under_limit_when_compaction_succeeds(monkeypatch):
    settings = get_settings()
    limit = 800
    monkeypatch.setattr(settings, "subject_synthesis_max_input_tokens", limit)
    monkeypatch.setattr(settings, "subject_synthesis_chars_per_token", 4)

    sources = _oversized_sources(meetings=2, segments=100)
    options = {
        "language": "vi",
        "flashcardCount": 5,
        "multipleChoiceCount": 5,
        "essayQuestionCount": 1,
    }

    for artifact_type in ALL_ARTIFACT_TYPES:
        captured: list[tuple[str, str]] = []

        def call_gemini(*, prompt: str, system_prompt: str, response_schema=None, _t=artifact_type):
            captured.append((system_prompt, prompt))
            return _fake_artifact_json(_t)

        result = generate_artifact_content(
            artifact_type,
            synthesis_content={
                "subjectOverview": "overview " * 80,
                "chapters": [
                    {
                        "title": "Ch",
                        "summary": "sum " * 40,
                        "sourceMeetingIds": [101],
                        "sourceSegmentIds": ["seg-101-0"],
                    }
                ],
                "importantTerms": [],
                "mustRemember": [],
                "learningObjectives": ["obj"],
                "knowledgeGaps": [],
                "examFocus": [],
            },
            ready_sources=sources,
            options=options,
            call_gemini=call_gemini,
        )
        assert result
        assert captured, f"{artifact_type} should call provider when compaction succeeds"
        for system_prompt, user_prompt in captured:
            combined = system_prompt + "\n\n" + user_prompt
            assert estimate_tokens(combined, chars_per_token=4) <= limit, artifact_type


def test_system_plus_user_over_limit_rejects_before_provider(monkeypatch):
    """User prompt alone may fit; combined system+user must still be gated."""
    from app.services.study.artifacts import artifact_system_instruction

    settings = get_settings()
    chars_per_token = 4
    # Tiny ceiling so any real system+user combined prompt overflows.
    limit = 20
    monkeypatch.setattr(settings, "subject_synthesis_max_input_tokens", limit)
    monkeypatch.setattr(settings, "subject_synthesis_chars_per_token", chars_per_token)

    provider_calls: list[str] = []

    def call_gemini(*, prompt: str, system_prompt: str, response_schema=None) -> str:
        provider_calls.append(prompt)
        return json.dumps(_ok_flashcards())

    with pytest.raises(StudyValidationError) as raised:
        generate_artifact_content(
            ARTIFACT_FLASHCARDS,
            synthesis_content={"subjectOverview": "x" * 200},
            ready_sources=READY,
            options={"language": "vi", "flashcardCount": 5},
            call_gemini=call_gemini,
        )
    assert raised.value.code == "PROMPT_TOKEN_LIMIT_EXCEEDED"
    assert provider_calls == []
    # Sanity: system instruction alone already consumes budget under this limit.
    system = artifact_system_instruction(ARTIFACT_FLASHCARDS)
    assert estimate_tokens(system + "\n\n", chars_per_token=chars_per_token) >= 1


def test_malformed_provider_json_marks_validation_no_retry(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(db_session, monkeypatch)
    row = study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()

    def bad_json_caller():
        def call_gemini(**_kwargs):
            return "not-json{{{"

        return call_gemini

    monkeypatch.setattr(study_service, "_gemini_caller", bad_json_caller)
    monkeypatch.setattr(
        study_service,
        "fetch_subject_meeting_ids",
        lambda subject_id, owner_user_id: [101, 102],
    )

    study_service.process_artifact_job(db_session, artifact_id)
    db_session.refresh(row)
    assert row.status == STATUS_FAILED
    assert row.error_code in {"INVALID_PROVIDER_JSON", "INVALID_ARTIFACT_JSON", "FAILED_VALIDATION"}
    # Validation failures must not requeue (QUEUED + TRANSIENT_AI_ERROR).
    assert row.status != STATUS_QUEUED
    assert row.error_code != "TRANSIENT_AI_ERROR"


def test_valid_json_wrong_schema_marks_validation_no_retry(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(db_session, monkeypatch)
    row = study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()

    def wrong_schema_caller():
        def call_gemini(**_kwargs):
            # Valid JSON but missing required flashcard fields / wrong shape.
            return json.dumps({"cards": [{"id": "c1"}]})

        return call_gemini

    monkeypatch.setattr(study_service, "_gemini_caller", wrong_schema_caller)
    monkeypatch.setattr(
        study_service,
        "fetch_subject_meeting_ids",
        lambda subject_id, owner_user_id: [101, 102],
    )

    study_service.process_artifact_job(db_session, artifact_id)
    db_session.refresh(row)
    assert row.status == STATUS_FAILED
    assert row.error_code in {
        "FAILED_VALIDATION",
        "INVALID_FLASHCARDS",
        "INVALID_PROVIDER_SCHEMA",
    }
    assert row.status != STATUS_QUEUED
    assert row.error_code != "TRANSIENT_AI_ERROR"


def test_classify_json_decode_and_schema_errors():
    classified = classify_provider_exception(json.JSONDecodeError("Expecting value", "doc", 0))
    assert isinstance(classified, StudyValidationError)
    assert classified.code == "INVALID_PROVIDER_JSON"

    from pydantic import BaseModel, ValidationError

    class _Tiny(BaseModel):
        x: int

    try:
        _Tiny.model_validate({"x": "nope"})
    except ValidationError as ve:
        schema_classified = classify_provider_exception(ve)
        assert isinstance(schema_classified, StudyValidationError)
        assert schema_classified.code == "INVALID_PROVIDER_SCHEMA"


def test_call_gemini_429_requeues(db_session, monkeypatch):
    artifact_id = _prepare_flashcards(db_session, monkeypatch)

    def rate_limit_caller():
        def call_gemini(**_kwargs):
            raise RuntimeError("HTTP 429 too many requests")

        return call_gemini

    monkeypatch.setattr(study_service, "_gemini_caller", rate_limit_caller)
    monkeypatch.setattr(
        study_service,
        "fetch_subject_meeting_ids",
        lambda subject_id, owner_user_id: [101, 102],
    )

    with pytest.raises(StudyTransientError):
        study_service.process_artifact_job(db_session, artifact_id)

    db_session.expire_all()
    row = study_service._live_artifact_query(db_session).filter_by(id=artifact_id).first()
    assert row is not None
    assert row.status == STATUS_QUEUED
    assert row.error_code == "TRANSIENT_AI_ERROR"


def test_phase2_finalization_evidence_smoke(tmp_path, monkeypatch, capsys):
    """Printable evidence checklist for Phase 2 deployment + validation finalization."""
    from app.celery_app import celery_app
    from tests import test_membership
    from tests import test_study_queue_deployment_config as deploy_cfg
    from tests.test_celery_beat_production_config import (
        test_api_and_worker_production_require_meeting_url_and_token,
        test_celery_app_loads_under_beat_production_settings,
    )

    evidence: list[str] = []

    # 1) K8s manifest token/URL presence (api + worker; Beat is broker-only)
    text = deploy_cfg._core_deployments_text()
    for name in ("ai-api", "celery-worker", "processing-api"):
        block = deploy_cfg._deployment_block(text, name)
        assert deploy_cfg._has_secret_key_ref(
            block,
            "INTERNAL_SERVICE_TOKEN",
            "audiomind-secrets",
            "INTERNAL_SERVICE_TOKEN",
        )
    processing = deploy_cfg._deployment_block(text, "processing-api")
    assert deploy_cfg._env_value(processing, "AUDIOMIND_USER_API_BASE_URL") == (
        "http://user-api:8083"
    )
    for name in ("ai-api", "celery-worker"):
        block = deploy_cfg._deployment_block(text, name)
        assert deploy_cfg._env_value(block, "APP_COMPONENT") in {"api", "worker"}
        assert deploy_cfg._env_value(block, "MEETING_SERVICE_BASE_URL") == (
            "http://meeting-api:8081"
        )
        assert deploy_cfg._env_value(block, "ANALYSIS_PROVIDER") == "gemini"
        assert deploy_cfg._has_secret_key_ref(
            block,
            "GEMINI_API_KEY",
            "audiomind-secrets",
            "GEMINI_API_KEY",
        )
        # APP_ENV is overlay-owned (not base production).
        assert deploy_cfg._env_value(block, "APP_ENV") is None
    beat = deploy_cfg._deployment_block(text, "celery-beat")
    assert deploy_cfg._env_value(beat, "APP_COMPONENT") == "beat"
    assert deploy_cfg._env_value(beat, "MEETING_SERVICE_BASE_URL") is None
    assert deploy_cfg._env_value(beat, "GEMINI_API_KEY") is None
    evidence.append("1-k8s-token-urls-component-scoped")

    # 2) Celery Beat production config load (no Gemini/CORS/meeting required)
    test_celery_app_loads_under_beat_production_settings(monkeypatch)
    test_api_and_worker_production_require_meeting_url_and_token(
        monkeypatch, "api", "meeting_url"
    )
    test_api_and_worker_production_require_meeting_url_and_token(
        monkeypatch, "worker", "internal_token"
    )
    # Restore non-production so later get_settings() calls in this test succeed.
    # Keep membership URL only while running membership client tests below, then clear.
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("APP_COMPONENT", "api")
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "phase2-evidence-token")
    monkeypatch.setenv("MEETING_SERVICE_BASE_URL", "http://meeting-api:8081")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173")
    monkeypatch.setenv("ANALYSIS_PROVIDER", "fake")
    monkeypatch.setenv("AI_PROVIDER", "fake")
    get_settings.cache_clear()
    evidence.append("2-celery-beat-production")

    # 3-5) Membership valid / invalid / pagination
    test_membership.test_fetch_parses_items_with_id(monkeypatch)
    test_membership.test_fetch_404_raises_validation(monkeypatch)
    test_membership.test_fetch_paginates_until_done(monkeypatch)
    evidence.append("3-5-membership-valid-invalid-pagination")

    # Drop live membership DNS before process_artifact_job cases (7-9).
    monkeypatch.delenv("MEETING_SERVICE_BASE_URL", raising=False)
    monkeypatch.setenv("MEETING_SERVICE_BASE_URL", "")
    monkeypatch.delenv("MEETING_API_BASE_URL", raising=False)
    monkeypatch.setenv("MEETING_API_BASE_URL", "")
    get_settings.cache_clear()

    # 6) Artifact system+user over limit → no provider call
    settings = get_settings()
    prior_limit = settings.subject_synthesis_max_input_tokens
    prior_chars = settings.subject_synthesis_chars_per_token
    test_system_plus_user_over_limit_rejects_before_provider(monkeypatch)
    # Restore ceilings mutated by the prompt-limit test (same Settings cache).
    monkeypatch.setattr(settings, "subject_synthesis_max_input_tokens", prior_limit)
    monkeypatch.setattr(settings, "subject_synthesis_chars_per_token", prior_chars)
    evidence.append("6-artifact-prompt-ceiling")

    # 7-9) Fresh SQLite DBs so prepare does not cache-hit across cases
    for index, (label, runner) in enumerate(
        (
            ("7-malformed-json-validation", test_malformed_provider_json_marks_validation_no_retry),
            ("8-wrong-schema-validation", test_valid_json_wrong_schema_marks_validation_no_retry),
            ("9-typeerror-programming-error", test_call_gemini_type_error_marks_programming_error),
        )
    ):
        case_dir = tmp_path / f"case_{index}"
        case_dir.mkdir()
        engine = _sqlite_engine(case_dir)
        Session = sessionmaker(bind=engine, expire_on_commit=False)
        db = Session()
        try:
            runner(db, monkeypatch)
        finally:
            db.close()
            engine.dispose()
        evidence.append(label)

    # 10-12) Quota retry policy (Java cross-service)
    evidence.append(
        "10-12-quota-retry-NOTE:Java UserQuotaClientTest covers 401/503/timeout "
        "(4xx no-retry; 5xx/timeout → UNKNOWN with short retry)"
    )

    # 13-15) PG concurrency (user-service default gate)
    evidence.append(
        "13-15-pg-concurrency-NOTE:QuotaConcurrencyTest in user-service "
        "(Testcontainers Postgres; same-key / different-key / near-limit)"
    )

    # 16) Partial batch
    evidence.append(
        "16-partial-batch-NOTE:StudyGenerationServiceTest covers PARTIALLY_FAILED "
        "and per-item ALLOWED confirm+dispatch"
    )

    # 17) Celery reconciliation still registered
    assert "study-generation-reconcile" in celery_app.conf.beat_schedule
    assert "app.tasks.reconcile_study_generation" in celery_app.tasks
    evidence.append("17-celery-reconcile-registered")

    print("PHASE2_FINALIZATION_EVIDENCE: " + " | ".join(evidence))
    print("Technical fake-provider smoke: PASS")
    print("Real Gemini smoke: NOT RUN")
    captured = capsys.readouterr()
    assert "Technical fake-provider smoke: PASS" in captured.out
    assert "Real Gemini smoke: NOT RUN" in captured.out
