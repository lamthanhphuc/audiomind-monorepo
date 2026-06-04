import asyncio
import importlib
import sys
import types
from datetime import datetime

import pytest
import app.main as main_module
from app.models import Analysis, Base, MeetingAnalysisRun
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker

audio_processor_stub = types.ModuleType("app.services.audio_processor")
audio_processor_stub.AudioProcessor = type("AudioProcessor", (), {})
sys.modules["app.services.audio_processor"] = audio_processor_stub

stt_adapter_stub = types.ModuleType("app.services.stt_adapter")
stt_adapter_stub.DeepgramSTTAdapter = type("DeepgramSTTAdapter", (), {})
stt_adapter_stub.normalize_deepgram_speaker_label = lambda label: label
sys.modules["app.services.stt_adapter"] = stt_adapter_stub


class FakeBatchAnalyzer:
    PROMPT_VERSION = "gemini-business-v1"
    SCHEMA_VERSION = "gemini-business-v1"

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
):
    ProcessingPipeline = importlib.import_module("app.pipeline").ProcessingPipeline
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
    db_session.add(
        MeetingAnalysisRun(
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
    )
    db_session.commit()
    monkeypatch.setattr(main_module, "get_job_status", lambda meeting_id: None)
    monkeypatch.setattr(main_module, "pipeline", FakePipeline(current))

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
