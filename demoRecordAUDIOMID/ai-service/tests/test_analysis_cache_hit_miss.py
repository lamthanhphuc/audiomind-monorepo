import asyncio
import importlib
import sys
import types
from datetime import datetime

import pytest
import app.main as main_module
from app.models import Analysis, Base, MeetingAnalysisRun, Transcript
from app.schemas import RealtimeTranscriptAnalysisRequest
from app.services.analysis_runs import persist_completed_analysis_run
from app.services.analysis_versioning import merge_domain_analysis_payload
from app.services.segment_identity import (
    assign_stable_segment_ids,
    format_aligned_transcript_for_analysis,
)
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


class FakeBatchAnalyzer:
    def __init__(
        self,
        *,
        provider: str = "gemini",
        model: str = "gemini-3.1-flash-lite",
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


class FakeRealtimeAnalyzer(FakeBatchAnalyzer):
    def _analyze_with_gemini(self, transcript, metadata=None):
        return self.analyze_meeting(transcript, metadata=metadata)


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


@pytest.fixture(autouse=True)
def reset_realtime_state(monkeypatch):
    main_module._realtime_analysis_in_progress.clear()
    main_module._realtime_analysis_completed_hash.clear()
    monkeypatch.setattr(main_module, "pipeline", None)
    monkeypatch.setattr(main_module.settings, "gemini_cost_guard_enabled", False)
    yield
    main_module._realtime_analysis_in_progress.clear()
    main_module._realtime_analysis_completed_hash.clear()


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


def _formatted_transcript(segments=None, meeting_id: int = 0):
    aligned = assign_stable_segment_ids(meeting_id, segments or _segments())
    return format_aligned_transcript_for_analysis(aligned)


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
        "promptVersion": "gemini-business-v2",
        "schemaVersion": "gemini-business-v2",
        "analysisFeatureSet": "grouped-action-plan-v1-it",
        "source": "test",
    }


def _seed_completed_run(
    db_session,
    *,
    meeting_id: int,
    analyzer=None,
    summary: str = "Cached summary",
    fallback_text: str | None = None,
    fallback_hash: str | None = None,
    recognition_mode: str | None = "deepgram",
    transcript_language: str | None = "vi",
):
    analyzer = analyzer or FakeBatchAnalyzer()
    normalized, domain_payload = merge_domain_analysis_payload(
        "it",
        _analysis_payload(summary),
    )
    run = persist_completed_analysis_run(
        db=db_session,
        meeting_id=meeting_id,
        analyzer=analyzer,
        analysis_payload=domain_payload,
        summary=summary,
        fallback_transcript_hash=fallback_hash,
        fallback_text=fallback_text or _formatted_transcript(meeting_id=meeting_id),
        recognition_mode=recognition_mode,
        transcript_language=transcript_language,
        normalized_domain_mode=normalized,
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


def test_batch_cache_hit_skips_provider_and_does_not_duplicate_run(
    db_session, monkeypatch
):
    meeting_id = 7001
    analyzer = FakeBatchAnalyzer()
    _seed_completed_run(
        db_session,
        meeting_id=meeting_id,
        analyzer=analyzer,
        fallback_text=_formatted_transcript(meeting_id=meeting_id),
    )
    pipeline = _make_batch_pipeline(monkeypatch, analyzer)

    result = _run_batch(pipeline, db_session, meeting_id)

    assert analyzer.calls == []
    assert result["analysis"]["summary"] == "Cached summary"
    assert result["analysis"]["keywords"] == ["api"]
    assert result["analysis"]["analysisStatus"] == "COMPLETED"
    assert result["analysis"]["cacheHit"] is True
    assert result["analysis"]["provider"] == "gemini"
    assert result["analysis"]["model"] == "gemini-3.1-flash-lite"
    assert result["analysis"]["promptVersion"] == "gemini-business-v2"
    assert result["analysis"]["schemaVersion"] == "gemini-business-v2"
    assert result["analysis"]["canonicalTranscriptHash"] is not None
    assert result["analysis"]["analysisInputMode"] == "readable_fallback"
    assert (
        db_session.query(MeetingAnalysisRun)
        .filter(MeetingAnalysisRun.meeting_id == meeting_id)
        .count()
        == 1
    )
    current = db_session.query(Analysis).filter(Analysis.meeting_id == meeting_id).one()
    assert current.summary == "Cached summary"


def test_batch_cache_miss_calls_provider_and_writes_run(db_session, monkeypatch):
    meeting_id = 7002
    analyzer = FakeBatchAnalyzer()
    pipeline = _make_batch_pipeline(monkeypatch, analyzer)

    result = _run_batch(pipeline, db_session, meeting_id)

    assert len(analyzer.calls) == 1
    assert result["analysis"]["summary"] == "Provider summary"
    assert result["analysis"]["cacheHit"] is False
    run = (
        db_session.query(MeetingAnalysisRun)
        .filter(MeetingAnalysisRun.meeting_id == meeting_id)
        .one()
    )
    assert run.status == "COMPLETED"
    assert run.analysis_payload_json["summary"] == "Provider summary"


def test_provider_model_prompt_schema_mismatch_is_cache_miss(db_session, monkeypatch):
    meeting_id = 7003
    stale_analyzer = FakeBatchAnalyzer(
        provider="gemini",
        model="old-model",
        prompt_version="old-prompt",
        schema_version="old-schema",
    )
    _seed_completed_run(
        db_session,
        meeting_id=meeting_id,
        analyzer=stale_analyzer,
        fallback_text=_formatted_transcript(meeting_id=meeting_id),
    )
    analyzer = FakeBatchAnalyzer()
    pipeline = _make_batch_pipeline(monkeypatch, analyzer)

    result = _run_batch(pipeline, db_session, meeting_id)

    assert len(analyzer.calls) == 1
    assert result["analysis"]["cacheHit"] is False
    assert (
        db_session.query(MeetingAnalysisRun)
        .filter(MeetingAnalysisRun.meeting_id == meeting_id)
        .count()
        == 2
    )


def test_canonical_hash_version_mismatch_is_cache_miss(db_session, monkeypatch):
    meeting_id = 7004
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
            canonical_transcript_hash="b" * 64,
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
            recognition_mode="deepgram",
            transcript_language="vi",
            analysis_payload_json=_analysis_payload("Stale canonical summary"),
            summary="Stale canonical summary",
            idempotency_key="stale-canonical-7004",
            created_at=now,
            updated_at=now,
            completed_at=now,
        )
    )
    db_session.commit()
    analyzer = FakeBatchAnalyzer()
    pipeline = _make_batch_pipeline(monkeypatch, analyzer)

    result = _run_batch(pipeline, db_session, meeting_id)

    assert len(analyzer.calls) == 1
    assert result["analysis"]["cacheHit"] is False
    assert result["analysis"]["canonicalTranscriptHash"] == "b" * 64
    assert result["analysis"]["canonicalTranscriptVersion"] == "canonical-v2"


def test_realtime_cache_hit_skips_provider_and_returns_metadata(
    db_session, monkeypatch
):
    meeting_id = 7005
    transcript = "Speaker 1: can cap nhat API gateway"
    transcript_hash = main_module._compute_transcript_hash(transcript, None)
    analyzer = FakeRealtimeAnalyzer()
    _seed_completed_run(
        db_session,
        meeting_id=meeting_id,
        analyzer=analyzer,
        summary="Realtime cached summary",
        fallback_text=transcript,
        fallback_hash=transcript_hash,
        recognition_mode=None,
        transcript_language=None,
    )
    job_updates = []
    monkeypatch.setattr(main_module, "_realtime_analysis_analyzer", analyzer)
    monkeypatch.setattr(
        main_module, "set_job_status", lambda **kwargs: job_updates.append(kwargs)
    )
    request = RealtimeTranscriptAnalysisRequest(
        meeting_id=meeting_id,
        transcript=transcript,
        source="realtime",
        transcript_hash=transcript_hash,
        prompt_version="gemini-business-v2",
        schema_version="gemini-business-v2",
    )

    response = asyncio.run(main_module.analyze_realtime_transcript(request, db_session))

    assert analyzer.calls == []
    assert response.status == "completed"
    assert response.analysisStatus == "COMPLETED"
    assert response.cacheHit is True
    assert response.provider == "gemini"
    assert response.model == "gemini-3.1-flash-lite"
    assert response.canonicalTranscriptHash == transcript_hash
    assert response.analysisInputMode == "readable_fallback"
    assert job_updates
    assert job_updates[-1]["result"]["analysis"]["cacheHit"] is True
    assert (
        db_session.query(MeetingAnalysisRun)
        .filter(MeetingAnalysisRun.meeting_id == meeting_id)
        .count()
        == 1
    )


def test_realtime_cache_only_hit_does_not_initialize_provider(db_session, monkeypatch):
    meeting_id = 7006
    transcript = "Speaker 1: can cap nhat API gateway"
    transcript_hash = main_module._compute_transcript_hash(transcript, None)
    analyzer = FakeRealtimeAnalyzer()
    _seed_completed_run(
        db_session,
        meeting_id=meeting_id,
        analyzer=analyzer,
        summary="Export cached summary",
        fallback_text=transcript,
        fallback_hash=transcript_hash,
        recognition_mode=None,
        transcript_language=None,
    )
    monkeypatch.setattr(
        main_module,
        "_get_realtime_analysis_analyzer",
        lambda: (_ for _ in ()).throw(AssertionError("provider initialized")),
    )
    monkeypatch.setattr(main_module, "set_job_status", lambda **kwargs: None)
    request = RealtimeTranscriptAnalysisRequest(
        meeting_id=meeting_id,
        transcript=transcript,
        source="export_report",
        transcript_hash=transcript_hash,
        prompt_version="gemini-business-v2",
        schema_version="gemini-business-v2",
        mode="cache_only",
    )

    response = asyncio.run(main_module.analyze_realtime_transcript(request, db_session))

    assert analyzer.calls == []
    assert response.status == "completed"
    assert response.analysis["summary"] == "Export cached summary"
    assert response.analysisStatus == "COMPLETED"
    assert response.cacheHit is True
