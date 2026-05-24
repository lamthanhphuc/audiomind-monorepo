import asyncio

import app.main as main_module
import pytest
from app.models import Analysis, Base
from app.schemas import RealtimeTranscriptAnalysisRequest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


class FakeRealtimeAnalyzer:
    def __init__(self, *, fail_with_config_error: bool = False):
        self.calls = []
        self.analysis_domain_mode = "it"
        self.provider = "gemini"
        self.fail_with_config_error = fail_with_config_error

    def _analyze_with_gemini(self, transcript, metadata=None):
        if self.fail_with_config_error:
            raise main_module.AnalysisConfigError(
                "GEMINI_API_KEY is required when analysis_provider=gemini",
                provider="gemini",
            )

        self.calls.append((transcript, metadata or {}))
        return {
            "summary": "Realtime summary",
            "keywords": ["api"],
            "technicalTerms": [
                {
                    "term": "API",
                    "meaning": "Application Programming Interface",
                    "category": "protocol",
                }
            ],
            "painPoints": [
                {"title": "Delay", "evidence": "queue lag", "severity": "high"}
            ],
            "actionItems": ["Scale workers"],
            "domainMode": "it",
            "technical_terms": ["API"],
            "action_items": [
                {"task": "Scale workers", "owner": None, "deadline": None}
            ],
        }

    def prepare_analysis_for_storage(self, transcript, data):
        return {
            "summary": str(data.get("summary") or ""),
            "keywords": list(data.get("keywords") or []),
            "technical_terms": list(data.get("technical_terms") or []),
            "action_items": list(data.get("action_items") or []),
        }

    def sanitize_technical_terms(self, transcript, technical_terms, keywords):
        return list(technical_terms or [])


class FakeUnavailableAnalyzer(FakeRealtimeAnalyzer):
    def __init__(self):
        super().__init__(fail_with_config_error=True)


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
def reset_realtime_analysis_guard(monkeypatch):
    main_module._realtime_analysis_in_progress.clear()
    main_module._realtime_analysis_completed_hash.clear()
    monkeypatch.setattr(main_module, "pipeline", None)
    monkeypatch.setattr(
        main_module, "_realtime_analysis_analyzer", FakeRealtimeAnalyzer()
    )
    yield main_module._realtime_analysis_analyzer


def test_realtime_analysis_skips_empty_transcript(db_session):
    request = RealtimeTranscriptAnalysisRequest(
        meeting_id=901,
        transcript="   ",
        source="realtime",
    )

    response = asyncio.run(main_module.analyze_realtime_transcript(request, db_session))

    assert response.status == "skipped"
    assert response.reason == "empty_transcript"
    assert db_session.query(Analysis).filter(Analysis.meeting_id == 901).first() is None


def test_realtime_analysis_persists_and_is_idempotent_for_same_hash(db_session):
    request = RealtimeTranscriptAnalysisRequest(
        meeting_id=902,
        transcript="Speaker 1: cần cập nhật API gateway",
        source="realtime",
        transcript_hash="a" * 64,
    )

    first = asyncio.run(main_module.analyze_realtime_transcript(request, db_session))
    second = asyncio.run(main_module.analyze_realtime_transcript(request, db_session))

    assert first.status == "completed"
    assert second.status == "skipped"
    assert second.reason == "already_exists"

    saved = db_session.query(Analysis).filter(Analysis.meeting_id == 902).first()
    assert saved is not None
    assert saved.summary == "Realtime summary"
    assert isinstance(saved.technical_terms, dict)
    assert saved.technical_terms.get("transcript_hash") == "a" * 64
    assert len(main_module._realtime_analysis_analyzer.calls) == 1


def test_realtime_analysis_returns_503_when_analyzer_unavailable(
    db_session, monkeypatch
):
    monkeypatch.setattr(
        main_module, "_realtime_analysis_analyzer", FakeUnavailableAnalyzer()
    )
    request = RealtimeTranscriptAnalysisRequest(
        meeting_id=903,
        transcript="Speaker 1: test unavailable path",
        source="realtime",
    )

    with pytest.raises(main_module.HTTPException) as exc_info:
        asyncio.run(main_module.analyze_realtime_transcript(request, db_session))

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail == "Analysis service unavailable"
    assert db_session.query(Analysis).filter(Analysis.meeting_id == 903).first() is None
