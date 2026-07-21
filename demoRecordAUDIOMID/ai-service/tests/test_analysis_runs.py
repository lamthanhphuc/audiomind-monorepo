import asyncio
import importlib
import sys
import types
from datetime import datetime

import pytest
import app.main as main_module
from app.models import Analysis, Base, MeetingAnalysisRun, TranscriptFragment
from app.services.analysis_runs import analysis_run_response_metadata
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker


class FakeBatchAnalyzer:
    PROMPT_VERSION = "gemini-business-v2"
    SCHEMA_VERSION = "gemini-business-v2"
    analysis_domain_mode = "it"

    def __init__(self):
        self.provider = "gemini"
        self.model = "gemini-2.5-flash"

    def prepare_analysis_for_storage(self, transcript, data):
        return dict(data)

    def sanitize_technical_terms(self, transcript, technical_terms, keywords):
        return list(technical_terms or [])


class FakePipeline:
    def __init__(self, analysis):
        self.analysis = analysis

    def get_analysis(self, meeting_id, db):
        return self.analysis


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
        return existing_pipeline_module.ProcessingPipeline

    audio_processor_stub = types.ModuleType("app.services.audio_processor")
    audio_processor_stub.AudioProcessor = type("AudioProcessor", (), {})
    monkeypatch.setitem(
        sys.modules, "app.services.audio_processor", audio_processor_stub
    )

    pipeline_module = importlib.import_module("app.pipeline")
    sys.modules.pop("app.pipeline", None)
    return pipeline_module.ProcessingPipeline


def test_meeting_analysis_runs_model_creates_table(db_session):
    inspector = inspect(db_session.bind)

    assert "meeting_analysis_runs" in inspector.get_table_names()
    columns = {
        column["name"] for column in inspector.get_columns("meeting_analysis_runs")
    }
    assert {
        "meeting_id",
        "status",
        "provider",
        "model",
        "prompt_version",
        "schema_version",
        "canonical_transcript_hash",
        "canonical_transcript_version",
        "analysis_input_mode",
        "analysis_payload_json",
        "idempotency_key",
    }.issubset(columns)


def test_batch_save_results_writes_analysis_run_and_keeps_current_projection(
    db_session,
    monkeypatch,
):
    ProcessingPipeline = _load_processing_pipeline(monkeypatch)
    pipeline = object.__new__(ProcessingPipeline)
    pipeline.ai_analyzer = FakeBatchAnalyzer()
    segments = [
        {
            "seq": 1,
            "speaker": "SPEAKER_1",
            "start": 0.0,
            "end": 2.5,
            "text": "Can cap nhat API gateway",
            "is_final": True,
        }
    ]
    analysis_result = {
        "summary": "Batch summary",
        "meetingSummary": "Batch summary",
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
        "promptVersion": "gemini-business-v1",
        "schemaVersion": "gemini-business-v1",
    }

    pipeline._save_results(
        1201,
        segments,
        analysis_result,
        db_session,
        language="vi",
    )

    current = db_session.query(Analysis).filter(Analysis.meeting_id == 1201).one()
    assert current.summary == "Batch summary"
    assert current.keywords == ["api"]
    assert isinstance(current.technical_terms, dict)
    assert current.technical_terms["promptVersion"] == "gemini-business-v1"

    run = (
        db_session.query(MeetingAnalysisRun)
        .filter(MeetingAnalysisRun.meeting_id == 1201)
        .one()
    )
    assert run.status == "COMPLETED"
    assert run.provider == "gemini"
    assert run.model == "gemini-2.5-flash"
    assert run.prompt_version == "gemini-business-v1"
    assert run.schema_version == "gemini-business-v1"
    assert run.analysis_input_mode == "readable_fallback"
    assert run.canonical_transcript_version is None
    assert run.canonical_transcript_hash == current.technical_terms["transcript_hash"]
    assert run.recognition_mode == "deepgram"
    assert run.transcript_language == "vi"
    assert run.summary == "Batch summary"
    assert run.analysis_payload_json["summary"] == "Batch summary"


def test_batch_persists_transcript_segments_before_analysis(
    db_session,
    monkeypatch,
):
    ProcessingPipeline = _load_processing_pipeline(monkeypatch)
    pipeline = object.__new__(ProcessingPipeline)
    segments = [
        {
            "seq": 1,
            "speaker": "SPEAKER_1",
            "start": 0.0,
            "end": 2.5,
            "text": "Transcript before analysis",
            "segment_id": "meeting-2101-start-0.000-speaker_1",
            "is_final": True,
        }
    ]

    pipeline._persist_aligned_transcript_segments(2101, segments, db_session)
    db_session.commit()

    fragments = (
        db_session.query(TranscriptFragment)
        .filter(TranscriptFragment.meeting_id == 2101)
        .all()
    )
    assert len(fragments) == 1
    assert fragments[0].text == "Transcript before analysis"
    assert fragments[0].is_final is True

    # Second persist (as _save_results would do) must not duplicate.
    pipeline._persist_aligned_transcript_segments(2101, segments, db_session)
    db_session.commit()
    fragments_after = (
        db_session.query(TranscriptFragment)
        .filter(TranscriptFragment.meeting_id == 2101)
        .all()
    )
    assert len(fragments_after) == 1


def test_get_analysis_returns_run_metadata_with_legacy_payload(db_session, monkeypatch):
    current = Analysis(
        meeting_id=1301,
        summary="Saved summary",
        keywords=["api"],
        technical_terms={
            "technical_terms": ["API"],
            "technicalTerms": [
                {
                    "term": "API",
                    "meaning": "Application Programming Interface",
                    "category": "protocol",
                }
            ],
            "promptVersion": "gemini-business-v1",
            "schemaVersion": "gemini-business-v1",
            "transcript_hash": "c" * 64,
            "source": "database",
        },
        action_items=[{"task": "Review API", "owner": None, "deadline": None}],
    )
    db_session.add(current)
    completed_at = datetime.utcnow()
    analysis_run = MeetingAnalysisRun(
        meeting_id=1301,
        status="COMPLETED",
        provider="gemini",
        model="gemini-2.5-flash",
        prompt_version="gemini-business-v1",
        schema_version="gemini-business-v1",
        canonical_transcript_hash="c" * 64,
        canonical_transcript_version=None,
        analysis_input_mode="readable_fallback",
        analysis_payload_json={"summary": "Saved summary"},
        summary="Saved summary",
        idempotency_key="analysis-run-test-1301",
        created_at=completed_at,
        updated_at=completed_at,
        completed_at=completed_at,
    )
    db_session.add(analysis_run)
    db_session.commit()
    monkeypatch.setattr(main_module, "get_job_status", lambda meeting_id: None)
    monkeypatch.setattr(main_module, "pipeline", FakePipeline(current))

    metadata = analysis_run_response_metadata(analysis_run, cache_hit=True)
    assert metadata["lastAnalyzedAt"] == completed_at.isoformat()

    response = asyncio.run(main_module.get_analysis(1301, db_session))

    assert response.summary == "Saved summary"
    assert response.analysisStatus == "COMPLETED"
    assert response.provider == "gemini"
    assert response.model == "gemini-2.5-flash"
    assert response.promptVersion == "gemini-business-v1"
    assert response.schemaVersion == "gemini-business-v1"
    assert response.canonicalTranscriptHash == "c" * 64
    assert response.canonicalTranscriptVersion is None
    assert response.analysisInputMode == "readable_fallback"
    assert response.lastAnalyzedAt == completed_at
