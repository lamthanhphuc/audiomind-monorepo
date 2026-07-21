from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models import Base
from app.services.analysis_runs import (
    AnalysisCacheIdentity,
    begin_analysis_run,
    build_analysis_run_idempotency_key_for_identity,
    find_completed_analysis_run_for_identity,
    persist_completed_analysis_run,
)
from app.services.analysis_versioning import (
    merge_domain_analysis_payload,
    normalize_domain_mode,
    resolve_analysis_versions,
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
    PROMPT_VERSION = "gemini-business-v2"
    SCHEMA_VERSION = "gemini-business-v2"
    analysis_domain_mode = "it"

    def prepare_analysis_for_storage(self, *, transcript: str, data: dict) -> dict:
        return data


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("general", "general"),
        ("IT", "it"),
        ("education", "education"),
        ("foo", "it"),
        (None, "it"),
    ],
)
def test_normalize_domain_mode(raw, expected):
    assert normalize_domain_mode(raw) == expected


def test_resolve_analysis_versions_are_domain_specific():
    assert resolve_analysis_versions("education") == {
        "promptVersion": "education-analysis-v1",
        "schemaVersion": "education-study-v1",
        "analysisFeatureSet": "education-study-v1",
    }
    assert resolve_analysis_versions("business")["analysisFeatureSet"] == (
        "grouped-action-plan-v1-business"
    )


def _identity_for_domain(
    domain: str, transcript_hash: str = "hash-shared"
) -> AnalysisCacheIdentity:
    normalized, payload = merge_domain_analysis_payload(domain)
    versions = resolve_analysis_versions(normalized)
    return AnalysisCacheIdentity(
        meeting_id=101,
        owner_id=None,
        canonical_transcript_hash=transcript_hash,
        canonical_transcript_version="canonical-v1",
        provider="gemini",
        model="gemini-test",
        prompt_version=versions["promptVersion"],
        schema_version=versions["schemaVersion"],
        transcript_language=None,
        recognition_mode=None,
        speaker_stabilization_version=None,
        analysis_input_mode="readable_fallback",
        analysis_feature_set=versions["analysisFeatureSet"],
        normalized_domain_mode=normalized,
    )


def test_domain_cache_miss_across_modes(db_session, monkeypatch):
    analyzer = _AnalyzerStub()
    monkeypatch.setattr(
        "app.services.analysis_runs._resolve_transcript_identity",
        lambda **_: ("hash-shared", "canonical-v1", "readable_fallback"),
    )

    it_identity = _identity_for_domain("it")
    normalized, payload = merge_domain_analysis_payload(
        "it",
        {
            "analysisFeatureSet": it_identity.analysis_feature_set,
        },
    )
    persist_completed_analysis_run(
        db=db_session,
        meeting_id=101,
        analyzer=analyzer,
        analysis_payload=payload,
        summary="IT summary",
        fallback_transcript_hash="hash-shared",
        fallback_text="shared transcript",
        normalized_domain_mode=normalized,
    )
    db_session.commit()

    for other in ("general", "business", "education"):
        other_identity = _identity_for_domain(other)
        assert (
            find_completed_analysis_run_for_identity(db_session, other_identity) is None
        )


def test_same_domain_cache_hit(db_session, monkeypatch):
    analyzer = _AnalyzerStub()
    monkeypatch.setattr(
        "app.services.analysis_runs._resolve_transcript_identity",
        lambda **_: ("hash-shared", "canonical-v1", "readable_fallback"),
    )

    identity = _identity_for_domain("it")
    normalized, payload = merge_domain_analysis_payload(
        "it",
        {
            "analysisFeatureSet": identity.analysis_feature_set,
        },
    )
    persist_completed_analysis_run(
        db=db_session,
        meeting_id=101,
        analyzer=analyzer,
        analysis_payload=payload,
        summary="IT summary",
        fallback_transcript_hash="hash-shared",
        fallback_text="shared transcript",
        normalized_domain_mode=normalized,
    )
    db_session.commit()

    assert find_completed_analysis_run_for_identity(db_session, identity) is not None


def test_idempotency_key_consistent_across_lookup_begin_persist(
    db_session, monkeypatch
):
    analyzer = _AnalyzerStub()
    monkeypatch.setattr(
        "app.services.analysis_runs._resolve_transcript_identity",
        lambda **_: ("hash-shared", "canonical-v1", "readable_fallback"),
    )

    identity = _identity_for_domain("business")
    lookup_key = build_analysis_run_idempotency_key_for_identity(identity)
    run, _ = begin_analysis_run(db=db_session, identity=identity)
    begin_key = run.idempotency_key
    db_session.commit()

    normalized, payload = merge_domain_analysis_payload(
        "business",
        {
            "analysisFeatureSet": identity.analysis_feature_set,
        },
    )
    persisted = persist_completed_analysis_run(
        db=db_session,
        meeting_id=101,
        analyzer=analyzer,
        analysis_payload=payload,
        summary="Business summary",
        fallback_transcript_hash="hash-shared",
        fallback_text="shared transcript",
        run=run,
        normalized_domain_mode=normalized,
    )
    persist_key = persisted.idempotency_key

    assert lookup_key == begin_key == persist_key


def test_merge_domain_analysis_payload_overrides_mismatched_business_versions_for_education():
    normalized, payload = merge_domain_analysis_payload(
        "education",
        {
            "promptVersion": "gemini-business-v2",
            "schemaVersion": "gemini-business-v2",
            "analysisFeatureSet": "grouped-action-plan-v1",
        },
    )
    assert normalized == "education"
    assert payload["promptVersion"] == "education-analysis-v1"
    assert payload["schemaVersion"] == "education-study-v1"
    assert payload["analysisFeatureSet"] == "education-study-v1"
    assert payload["domainMode"] == "education"
