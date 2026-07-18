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
        assert estimate_tokens(prompt, chars_per_token=4) <= limit
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
        prompts: list[str] = []

        def call_gemini(*, prompt: str, system_prompt: str, response_schema=None, _t=artifact_type):
            prompts.append(prompt)
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
        assert prompts, f"{artifact_type} should call provider when compaction succeeds"
        for prompt in prompts:
            assert estimate_tokens(prompt, chars_per_token=4) <= limit, artifact_type
