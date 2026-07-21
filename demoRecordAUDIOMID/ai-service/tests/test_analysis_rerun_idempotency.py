import importlib
import sys
import types
from datetime import datetime

import pytest
from app.models import Base, MeetingAnalysisRun, Transcript
from app.services.analysis_runs import (
    ANALYSIS_MODE_CACHE_ONLY,
    ANALYSIS_MODE_FAILED_RETRY,
    ANALYSIS_MODE_FORCE,
    ANALYSIS_STATUS_ANALYZING,
    ANALYSIS_STATUS_FAILED,
    begin_analysis_run,
    build_analysis_cache_identity,
    persist_completed_analysis_run,
)
from app.services.analysis_versioning import merge_domain_analysis_payload
from app.services.segment_identity import (
    assign_stable_segment_ids,
    format_aligned_transcript_for_analysis,
)
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Matches app.pipeline._normalized_stt_provider() for default settings.stt_provider=deepgram.
_BATCH_RECOGNITION_MODE = "deepgram"
_BATCH_LANGUAGE = "vi"


class FakeBatchAnalyzer:
    def __init__(
        self,
        *,
        provider: str = "gemini",
        model: str = "gemini-2.5-flash",
        prompt_version: str = "gemini-business-v2",
        schema_version: str = "gemini-business-v2",
    ):
        self.provider = provider
        self.model = model
        self.PROMPT_VERSION = prompt_version
        self.SCHEMA_VERSION = schema_version
        self.analysis_domain_mode = "it"
        self.calls = []

    def format_transcript_for_analysis(self, segments):
        return "\n".join(
            f"{segment.get('speaker') or 'SPEAKER_1'}: {segment.get('text') or ''}"
            for segment in segments
        )

    def analyze_meeting(self, transcript, metadata=None):
        self.calls.append((transcript, metadata or {}))
        return _analysis_payload("Provider summary")

    def prepare_analysis_for_storage(self, transcript, data):
        return dict(data)

    def sanitize_technical_terms(self, transcript, technical_terms, keywords):
        return list(technical_terms or [])


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


def _load_processing_pipeline(monkeypatch):
    existing_pipeline_module = sys.modules.get("app.pipeline")
    if existing_pipeline_module is not None:
        return existing_pipeline_module.ProcessingPipeline, existing_pipeline_module

    audio_processor_stub = types.ModuleType("app.services.audio_processor")
    audio_processor_stub.AudioProcessor = type("AudioProcessor", (), {})
    monkeypatch.setitem(
        sys.modules, "app.services.audio_processor", audio_processor_stub
    )

    pipeline_module = importlib.import_module("app.pipeline")
    sys.modules.pop("app.pipeline", None)
    return pipeline_module.ProcessingPipeline, pipeline_module


def _make_batch_pipeline(monkeypatch, analyzer):
    ProcessingPipeline, pipeline_module = _load_processing_pipeline(monkeypatch)
    pipeline = object.__new__(ProcessingPipeline)
    pipeline.ai_analyzer = analyzer
    pipeline.audio_processor = types.SimpleNamespace(load_audio=lambda path: None)
    pipeline.diarization_available = False
    pipeline.speaker_diarizer = None
    pipeline._ensure_models_loaded = lambda: None
    pipeline._resolve_audio_path = lambda path: path
    pipeline._record_baseline_snapshot = lambda meeting_id, runtime_device: None
    pipeline._should_enable_diarization = lambda runtime_device: False
    pipeline._should_use_native_deepgram_diarization = lambda: False
    pipeline._deduplicate_repeated_segments = lambda segments: segments
    monkeypatch.setattr(pipeline_module, "get_runtime_device", lambda: "cpu")
    monkeypatch.setattr(pipeline_module.settings, "gemini_cost_guard_enabled", False)
    return pipeline


def _segments():
    return [
        {
            "seq": 1,
            "speaker": "SPEAKER_1",
            "start": 0.0,
            "end": 1.5,
            "text": "Can cap nhat API gateway",
            "is_final": True,
        }
    ]


def _aligned_segments(meeting_id: int, segments=None):
    return assign_stable_segment_ids(meeting_id, list(segments or _segments()))


def _formatted_transcript(meeting_id: int, segments=None):
    """Same analysis transcript text ProcessingPipeline hashes for cache identity."""
    return format_aligned_transcript_for_analysis(
        _aligned_segments(meeting_id, segments)
    )


def _analysis_payload(summary):
    return {
        "summary": summary,
        "meetingSummary": summary,
        "keywords": ["api"],
        "technical_terms": ["API"],
        "technicalTerms": [
            {
                "term": "API",
                "meaning": "Application Programming Interface",
                "category": "protocol",
            }
        ],
        "action_items": [{"task": "Scale API", "owner": None, "deadline": None}],
        "actionItems": ["Scale API"],
        "source": "test",
    }


def _identity_for_current_batch(
    db_session,
    meeting_id: int,
    analyzer,
    *,
    segments=None,
    language: str = _BATCH_LANGUAGE,
):
    """Build the identity ProcessingPipeline.process_meeting would build for this input."""
    normalized, domain_payload = merge_domain_analysis_payload(
        analyzer.analysis_domain_mode,
        default_domain=analyzer.analysis_domain_mode,
    )
    return build_analysis_cache_identity(
        db=db_session,
        meeting_id=meeting_id,
        analyzer=analyzer,
        fallback_transcript_hash=None,
        fallback_text=_formatted_transcript(meeting_id, segments),
        analysis_payload=domain_payload,
        recognition_mode=_BATCH_RECOGNITION_MODE,
        transcript_language=language,
        normalized_domain_mode=normalized,
    )


def _seed_completed_run(
    db_session,
    *,
    meeting_id: int,
    analyzer=None,
    summary: str = "Cached summary",
    fallback_text: str | None = None,
    segments=None,
):
    analyzer = analyzer or FakeBatchAnalyzer()
    identity = _identity_for_current_batch(
        db_session,
        meeting_id,
        analyzer,
        segments=segments,
    )
    # Persist with the exact fallback text that identity used, unless overridden
    # (e.g. intentional stale transcript-hash fixtures).
    text = (
        fallback_text
        if fallback_text is not None
        else _formatted_transcript(meeting_id, segments)
    )
    _, domain_payload = merge_domain_analysis_payload(
        identity.normalized_domain_mode,
        _analysis_payload(summary),
        default_domain=identity.normalized_domain_mode,
    )
    run = persist_completed_analysis_run(
        db=db_session,
        meeting_id=meeting_id,
        analyzer=analyzer,
        analysis_payload=domain_payload,
        summary=summary,
        fallback_transcript_hash=None,
        fallback_text=text,
        recognition_mode=identity.recognition_mode,
        transcript_language=identity.transcript_language,
        normalized_domain_mode=identity.normalized_domain_mode,
    )
    db_session.commit()
    return run


def _run_batch(pipeline, db_session, meeting_id: int):
    return pipeline.process_meeting(
        audio_path="audio.wav",
        meeting_id=meeting_id,
        db=db_session,
        language="vi",
        precomputed_transcript_segments=_segments(),
    )


def _run_batch_with_mode(
    pipeline,
    db_session,
    meeting_id: int,
    mode: str,
    *,
    reason: str | None = None,
):
    return pipeline.process_meeting(
        audio_path="audio.wav",
        meeting_id=meeting_id,
        db=db_session,
        language="vi",
        precomputed_transcript_segments=_segments(),
        analysis_mode=mode,
        requested_by="test-user",
        rerun_reason=reason,
    )


def test_cache_only_hit_returns_cached_result_without_provider(db_session, monkeypatch):
    meeting_id = 7101
    analyzer = FakeBatchAnalyzer()
    _seed_completed_run(db_session, meeting_id=meeting_id, analyzer=analyzer)
    pipeline = _make_batch_pipeline(monkeypatch, analyzer)

    result = _run_batch_with_mode(
        pipeline, db_session, meeting_id, ANALYSIS_MODE_CACHE_ONLY
    )

    assert analyzer.calls == []
    assert result["analysis"]["summary"] == "Cached summary"
    assert result["analysis"]["cacheHit"] is True
    assert result["analysis"]["analysisStatus"] == "COMPLETED"


def test_cache_only_miss_returns_no_analysis_without_provider(db_session, monkeypatch):
    meeting_id = 7102
    analyzer = FakeBatchAnalyzer()
    pipeline = _make_batch_pipeline(monkeypatch, analyzer)

    result = _run_batch_with_mode(
        pipeline, db_session, meeting_id, ANALYSIS_MODE_CACHE_ONLY
    )

    assert analyzer.calls == []
    assert result["status"] == "no_analysis"
    assert result["analysis"]["analysisStatus"] == "NO_ANALYSIS"
    assert result["analysis"]["cacheHit"] is False
    assert result["analysis"]["stale"] is False
    assert db_session.query(MeetingAnalysisRun).count() == 0


def test_cache_only_identity_mismatch_returns_stale_without_provider(
    db_session, monkeypatch
):
    meeting_id = 7103
    current_analyzer = FakeBatchAnalyzer()
    stale_analyzer = FakeBatchAnalyzer(model="old-model")
    # Same transcript/domain/versions as current identity; only model differs.
    _seed_completed_run(
        db_session,
        meeting_id=meeting_id,
        analyzer=stale_analyzer,
    )
    pipeline = _make_batch_pipeline(monkeypatch, current_analyzer)

    result = _run_batch_with_mode(
        pipeline, db_session, meeting_id, ANALYSIS_MODE_CACHE_ONLY
    )

    assert current_analyzer.calls == []
    assert result["status"] == "stale"
    assert result["analysis"]["analysisStatus"] == "STALE"
    assert result["analysis"]["stale"] is True
    assert result["analysis"]["staleReason"] == "model_changed"


def test_auto_in_progress_same_identity_does_not_call_provider(db_session, monkeypatch):
    meeting_id = 7104
    analyzer = FakeBatchAnalyzer()
    identity = _identity_for_current_batch(db_session, meeting_id, analyzer)
    run, created = begin_analysis_run(
        db=db_session,
        identity=identity,
        requested_by="test-user",
    )
    assert created is True
    db_session.commit()
    pipeline = _make_batch_pipeline(monkeypatch, analyzer)

    result = _run_batch(pipeline, db_session, meeting_id)

    assert analyzer.calls == []
    assert result["status"] == "analyzing"
    assert result["analysis"]["analysisStatus"] == ANALYSIS_STATUS_ANALYZING
    assert result["analysis"]["cacheHit"] is False
    assert (
        db_session.query(MeetingAnalysisRun)
        .filter(MeetingAnalysisRun.meeting_id == meeting_id)
        .count()
        == 1
    )
    assert run.status == ANALYSIS_STATUS_ANALYZING


def test_force_bypasses_completed_cache_and_preserves_history(db_session, monkeypatch):
    meeting_id = 7105
    analyzer = FakeBatchAnalyzer()
    old_run = _seed_completed_run(
        db_session,
        meeting_id=meeting_id,
        analyzer=analyzer,
        summary="Old cached summary",
    )
    pipeline = _make_batch_pipeline(monkeypatch, analyzer)

    result = _run_batch_with_mode(
        pipeline,
        db_session,
        meeting_id,
        ANALYSIS_MODE_FORCE,
        reason="manual refresh",
    )

    assert len(analyzer.calls) == 1
    assert result["analysis"]["summary"] == "Provider summary"
    assert result["analysis"]["cacheHit"] is False
    runs = (
        db_session.query(MeetingAnalysisRun)
        .filter(MeetingAnalysisRun.meeting_id == meeting_id)
        .order_by(MeetingAnalysisRun.id.asc())
        .all()
    )
    assert len(runs) == 2
    assert runs[0].id == old_run.id
    assert runs[0].summary == "Old cached summary"
    assert runs[1].summary == "Provider summary"
    assert runs[1].requested_by == "test-user"
    assert runs[1].rerun_reason == "manual refresh"


def test_stale_detection_reports_transcript_hash_change(db_session, monkeypatch):
    meeting_id = 7106
    analyzer = FakeBatchAnalyzer()
    _seed_completed_run(
        db_session,
        meeting_id=meeting_id,
        analyzer=analyzer,
        fallback_text="SPEAKER_1: old transcript",
    )
    pipeline = _make_batch_pipeline(monkeypatch, analyzer)

    result = _run_batch_with_mode(
        pipeline, db_session, meeting_id, ANALYSIS_MODE_CACHE_ONLY
    )

    assert result["analysis"]["analysisStatus"] == "STALE"
    assert result["analysis"]["staleReason"] == "transcript_hash_changed"
    assert analyzer.calls == []


def test_stale_detection_reports_canonical_version_change(db_session, monkeypatch):
    meeting_id = 7107
    now = datetime.utcnow()
    db_session.add(
        Transcript(
            meeting_id=meeting_id,
            speaker="SPEAKER_1",
            start_time=0.0,
            end_time=1.0,
            text="Can cap nhat API gateway",
            canonical_transcript_rows=[
                {
                    "speaker": "SPEAKER_1",
                    "start_time": 0.0,
                    "end_time": 1.0,
                    "text": "Can cap nhat API gateway",
                }
            ],
            canonical_transcript_hash="a" * 64,
            canonical_transcript_version="canonical-v2",
            canonical_generated_at=now,
        )
    )
    db_session.add(
        MeetingAnalysisRun(
            meeting_id=meeting_id,
            status="COMPLETED",
            provider="gemini",
            model="gemini-2.5-flash",
            prompt_version="gemini-business-v2",
            schema_version="gemini-business-v2",
            canonical_transcript_hash="a" * 64,
            canonical_transcript_version="canonical-v1",
            analysis_input_mode="canonical",
            recognition_mode=_BATCH_RECOGNITION_MODE,
            transcript_language=_BATCH_LANGUAGE,
            analysis_payload_json={
                **_analysis_payload("Old canonical summary"),
                "analysisFeatureSet": "grouped-action-plan-v1-it",
            },
            summary="Old canonical summary",
            idempotency_key="stale-canonical-version-7107",
            created_at=now,
            updated_at=now,
            completed_at=now,
        )
    )
    db_session.commit()
    analyzer = FakeBatchAnalyzer()
    pipeline = _make_batch_pipeline(monkeypatch, analyzer)

    result = _run_batch_with_mode(
        pipeline, db_session, meeting_id, ANALYSIS_MODE_CACHE_ONLY
    )

    assert result["analysis"]["analysisStatus"] == "STALE"
    assert result["analysis"]["staleReason"] == "canonical_version_changed"
    assert analyzer.calls == []


def test_failed_retry_only_retries_retryable_failed_identity(db_session, monkeypatch):
    meeting_id = 7108
    analyzer = FakeBatchAnalyzer()
    identity = _identity_for_current_batch(db_session, meeting_id, analyzer)
    failed_run, _ = begin_analysis_run(
        db=db_session,
        identity=identity,
        requested_by="test-user",
    )
    failed_run.status = ANALYSIS_STATUS_FAILED
    db_session.commit()
    pipeline = _make_batch_pipeline(monkeypatch, analyzer)

    result = _run_batch_with_mode(
        pipeline, db_session, meeting_id, ANALYSIS_MODE_FAILED_RETRY
    )

    assert len(analyzer.calls) == 1
    assert result["analysis"]["analysisStatus"] == "COMPLETED"
    assert (
        db_session.query(MeetingAnalysisRun)
        .filter(MeetingAnalysisRun.meeting_id == meeting_id)
        .count()
        == 1
    )
    assert failed_run.status == "COMPLETED"


def test_failed_retry_analyzes_when_no_prior_run(db_session, monkeypatch):
    """Background recovery after EMPTY_TRANSCRIPT: no run exists yet for the scope."""
    meeting_id = 7109
    analyzer = FakeBatchAnalyzer()
    pipeline = _make_batch_pipeline(monkeypatch, analyzer)

    result = _run_batch_with_mode(
        pipeline, db_session, meeting_id, ANALYSIS_MODE_FAILED_RETRY
    )

    assert len(analyzer.calls) == 1
    assert result["analysis"]["analysisStatus"] == "COMPLETED"
    assert (
        db_session.query(MeetingAnalysisRun)
        .filter(MeetingAnalysisRun.meeting_id == meeting_id)
        .count()
        == 1
    )


def test_failed_retry_skips_completed_identity(db_session, monkeypatch):
    """Matching completed cache hits before failed_retry; provider is not called again."""
    meeting_id = 7110
    analyzer = FakeBatchAnalyzer()
    _seed_completed_run(db_session, meeting_id=meeting_id, analyzer=analyzer)
    pipeline = _make_batch_pipeline(monkeypatch, analyzer)

    result = _run_batch_with_mode(
        pipeline, db_session, meeting_id, ANALYSIS_MODE_FAILED_RETRY
    )

    assert analyzer.calls == []
    assert result["analysis"]["analysisStatus"] == "COMPLETED"
    assert result["analysis"]["cacheHit"] is True
    assert result["analysis"]["summary"] == "Cached summary"
