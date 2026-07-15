from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models import Base
from app.services.analysis_runs import (
    ANALYSIS_STATUS_COMPLETED,
    ANALYSIS_STATUS_UNAVAILABLE_FOR_SCOPE,
    AnalysisCacheIdentity,
    analysis_miss_response_metadata,
    find_completed_analysis_run_for_identity,
    latest_completed_analysis_run,
    persist_completed_analysis_run,
)


@pytest.fixture
def db_session():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


class _AnalyzerStub:
    provider = "gemini"
    model = "gemini-test"
    PROMPT_VERSION = "prompt-v1"
    SCHEMA_VERSION = "schema-v1"
    analysis_domain_mode = "it"

    def prepare_analysis_for_storage(self, *, transcript: str, data: dict) -> dict:
        return data


def _identity(
    meeting_id: int,
    *,
    recording_session_id: int | None = None,
    attempt_id: int | None = None,
    transcript_hash: str = "hash-a",
) -> AnalysisCacheIdentity:
    return AnalysisCacheIdentity(
        meeting_id=meeting_id,
        owner_id=None,
        canonical_transcript_hash=transcript_hash,
        canonical_transcript_version="canonical-v1",
        provider="gemini",
        model="gemini-test",
        prompt_version="prompt-v1",
        schema_version="schema-v1",
        transcript_language=None,
        recognition_mode=None,
        speaker_stabilization_version=None,
        analysis_input_mode="readable_fallback",
        analysis_feature_set="grouped-action-plan-v1-it",
        normalized_domain_mode="it",
        recording_session_id=recording_session_id,
        attempt_id=attempt_id,
    )


def _persist_payload(extra: dict | None = None) -> dict:
    payload = {"analysisFeatureSet": "grouped-action-plan-v1-it"}
    if extra:
        payload.update(extra)
    return payload


def test_v2_analysis_runs_are_isolated_by_attempt(db_session, monkeypatch):
    analyzer = _AnalyzerStub()
    monkeypatch.setattr(
        "app.services.analysis_runs._resolve_transcript_identity",
        lambda **_: ("hash-a", "canonical-v1", "readable_fallback"),
    )

    for session_id, attempt_id, summary in (
        (9001, 1, "Analysis attempt one"),
        (9001, 2, "Analysis attempt two"),
    ):
        persist_completed_analysis_run(
            db=db_session,
            meeting_id=42,
            analyzer=analyzer,
            analysis_payload=_persist_payload({"summary": summary, "keywords": [summary]}),
            summary=summary,
            fallback_transcript_hash="hash-a",
            fallback_text=summary,
            recording_session_id=session_id,
            attempt_id=attempt_id,
            normalized_domain_mode="it",
        )
    db_session.commit()

    attempt_one = latest_completed_analysis_run(db_session, 42, 9001, 1)
    attempt_two = latest_completed_analysis_run(db_session, 42, 9001, 2)
    assert attempt_one is not None
    assert attempt_two is not None
    assert attempt_one.summary == "Analysis attempt one"
    assert attempt_two.summary == "Analysis attempt two"


def test_v2_cache_lookup_does_not_return_legacy_run(db_session, monkeypatch):
    analyzer = _AnalyzerStub()
    monkeypatch.setattr(
        "app.services.analysis_runs._resolve_transcript_identity",
        lambda **_: ("legacy-hash", "canonical-v1", "readable_fallback"),
    )

    persist_completed_analysis_run(
        db=db_session,
        meeting_id=55,
        analyzer=analyzer,
        analysis_payload=_persist_payload({"summary": "Legacy analysis"}),
        summary="Legacy analysis",
        fallback_transcript_hash="legacy-hash",
        fallback_text="legacy transcript",
        normalized_domain_mode="it",
    )
    db_session.commit()

    identity = _identity(55, recording_session_id=9002, attempt_id=1)
    assert find_completed_analysis_run_for_identity(db_session, identity) is None
    miss = analysis_miss_response_metadata(db_session, identity)
    assert miss["analysisStatus"] == ANALYSIS_STATUS_UNAVAILABLE_FOR_SCOPE


def test_legacy_scope_only_returns_null_null_runs(db_session, monkeypatch):
    analyzer = _AnalyzerStub()
    monkeypatch.setattr(
        "app.services.analysis_runs._resolve_transcript_identity",
        lambda **_: ("legacy-hash", "canonical-v1", "readable_fallback"),
    )

    persist_completed_analysis_run(
        db=db_session,
        meeting_id=77,
        analyzer=analyzer,
        analysis_payload=_persist_payload({"summary": "Legacy only"}),
        summary="Legacy only",
        fallback_transcript_hash="legacy-hash",
        fallback_text="legacy transcript",
        normalized_domain_mode="it",
    )
    db_session.commit()

    v2_identity = _identity(77, recording_session_id=1, attempt_id=1)
    assert find_completed_analysis_run_for_identity(db_session, v2_identity) is None

    legacy_identity = _identity(77, transcript_hash="legacy-hash")
    legacy_run = find_completed_analysis_run_for_identity(db_session, legacy_identity)
    assert legacy_run is not None
    assert legacy_run.status == ANALYSIS_STATUS_COMPLETED
