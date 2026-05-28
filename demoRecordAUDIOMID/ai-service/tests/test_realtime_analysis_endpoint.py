import asyncio
import time

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


class FakeParseFailAnalyzer(FakeRealtimeAnalyzer):
    def _analyze_with_gemini(self, transcript, metadata=None):
        raise main_module.AnalysisParseError(
            "Invalid structured response",
            provider="gemini",
        )


class FakeRedisClient:
    def __init__(self):
        self.hashes: dict[str, dict[str, str]] = {}
        self.values: dict[str, str] = {}
        self.ttls: dict[str, int] = {}

    def hgetall(self, key: str):
        return dict(self.hashes.get(key, {}))

    def get(self, key: str):
        return self.values.get(key)

    def ttl(self, key: str):
        if key in self.values:
            return int(self.ttls.get(key, -1))
        return -2

    def set(self, key: str, value: str, nx: bool = False, ex: int | None = None):
        if nx and key in self.values:
            return False
        self.values[key] = str(value)
        if ex is not None:
            self.ttls[key] = int(ex)
        return True

    def hset(self, key: str, mapping: dict[str, str]):
        current = self.hashes.setdefault(key, {})
        for map_key, map_value in mapping.items():
            current[str(map_key)] = str(map_value)

    def expire(self, key: str, ttl: int):
        self.ttls[key] = int(ttl)

    def delete(self, key: str):
        self.values.pop(key, None)
        self.hashes.pop(key, None)
        self.ttls.pop(key, None)


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

    with pytest.raises(main_module.HTTPException) as exc_info:
        asyncio.run(main_module.analyze_realtime_transcript(request, db_session))

    assert exc_info.value.status_code == 422
    assert exc_info.value.detail == "Empty transcript"
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
    assert exc_info.value.detail == "Gemini service unavailable"
    assert db_session.query(Analysis).filter(Analysis.meeting_id == 903).first() is None


def test_realtime_analysis_returns_502_when_parse_fails(db_session, monkeypatch):
    monkeypatch.setattr(
        main_module, "_realtime_analysis_analyzer", FakeParseFailAnalyzer()
    )
    request = RealtimeTranscriptAnalysisRequest(
        meeting_id=904,
        transcript="Speaker 1: parse fail path",
        source="realtime",
    )

    with pytest.raises(main_module.HTTPException) as exc_info:
        asyncio.run(main_module.analyze_realtime_transcript(request, db_session))

    assert exc_info.value.status_code == 502
    assert exc_info.value.detail == "Gemini analysis failed"
    assert db_session.query(Analysis).filter(Analysis.meeting_id == 904).first() is None


def test_realtime_analysis_cooldown_active_returns_failed_without_new_call(
    db_session, monkeypatch
):
    request = RealtimeTranscriptAnalysisRequest(
        meeting_id=905,
        transcript="Speaker 1: cooldown guard",
        source="realtime",
    )

    monkeypatch.setattr(
        main_module,
        "_try_begin_realtime_analysis",
        lambda meeting_id, transcript_hash, source: (
            False,
            "cooldown_active",
            "GEMINI_UNAVAILABLE",
            37,
            None,
        ),
    )

    response = asyncio.run(main_module.analyze_realtime_transcript(request, db_session))

    assert response.status == "failed"
    assert response.reason == "cooldown_active"
    assert response.retryAfterSeconds == 37
    assert response.errorCode == "GEMINI_UNAVAILABLE"
    assert len(main_module._realtime_analysis_analyzer.calls) == 0


def test_realtime_analysis_in_progress_returns_skipped_shape(db_session, monkeypatch):
    request = RealtimeTranscriptAnalysisRequest(
        meeting_id=906,
        transcript="Speaker 1: in progress guard",
        source="realtime",
    )

    monkeypatch.setattr(
        main_module,
        "_try_begin_realtime_analysis",
        lambda meeting_id, transcript_hash, source: (
            False,
            "in_progress",
            None,
            18,
            None,
        ),
    )

    response = asyncio.run(main_module.analyze_realtime_transcript(request, db_session))

    assert response.status == "skipped"
    assert response.reason == "in_progress"
    assert response.retryAfterSeconds == 18
    assert response.errorCode is None
    assert len(main_module._realtime_analysis_analyzer.calls) == 0


def test_realtime_analysis_in_progress_fresh_state_returns_skipped_with_retry(
    db_session, monkeypatch
):
    meeting_id = 907
    transcript = "Speaker 1: fresh in-progress"
    transcript_hash = main_module._compute_transcript_hash(transcript, None)
    client = FakeRedisClient()
    now = time.time()
    client.hashes[main_module._analysis_state_key(meeting_id)] = {
        "meeting_id": str(meeting_id),
        "status": "RUNNING",
        "transcript_hash": transcript_hash,
        "started_at": str(now),
        "updated_at": str(now),
    }
    client.values[main_module._analysis_lock_key(meeting_id)] = "lock-token-907"
    client.ttls[main_module._analysis_lock_key(meeting_id)] = 42
    monkeypatch.setattr(main_module, "_get_client", lambda: client)

    request = RealtimeTranscriptAnalysisRequest(
        meeting_id=meeting_id,
        transcript=transcript,
        source="realtime",
        transcript_hash=transcript_hash,
    )

    response = asyncio.run(main_module.analyze_realtime_transcript(request, db_session))

    assert response.status == "skipped"
    assert response.reason == "in_progress"
    assert response.retryAfterSeconds == 42
    assert (
        db_session.query(Analysis).filter(Analysis.meeting_id == meeting_id).first()
        is None
    )


def test_realtime_analysis_in_progress_stale_state_allows_retry_and_completes(
    db_session, monkeypatch
):
    meeting_id = 908
    transcript = "Speaker 1: stale guard should recover"
    transcript_hash = main_module._compute_transcript_hash(transcript, None)
    client = FakeRedisClient()
    stale_started = time.time() - (main_module._REALTIME_ANALYSIS_STALE_SECONDS + 10)
    client.hashes[main_module._analysis_state_key(meeting_id)] = {
        "meeting_id": str(meeting_id),
        "status": "RUNNING",
        "transcript_hash": transcript_hash,
        "started_at": str(stale_started),
        "updated_at": str(stale_started),
    }
    monkeypatch.setattr(main_module, "_get_client", lambda: client)

    request = RealtimeTranscriptAnalysisRequest(
        meeting_id=meeting_id,
        transcript=transcript,
        source="realtime",
        transcript_hash=transcript_hash,
    )

    response = asyncio.run(main_module.analyze_realtime_transcript(request, db_session))

    assert response.status == "completed"
    saved = db_session.query(Analysis).filter(Analysis.meeting_id == meeting_id).first()
    assert saved is not None
    assert meeting_id not in main_module._realtime_analysis_in_progress


def test_realtime_analysis_exception_clears_in_progress_guard(db_session, monkeypatch):
    monkeypatch.setattr(
        main_module, "_realtime_analysis_analyzer", FakeParseFailAnalyzer()
    )
    client = FakeRedisClient()
    monkeypatch.setattr(main_module, "_get_client", lambda: client)
    request = RealtimeTranscriptAnalysisRequest(
        meeting_id=909,
        transcript="Speaker 1: parse fail should cleanup guard",
        source="realtime",
    )

    with pytest.raises(main_module.HTTPException) as exc_info:
        asyncio.run(main_module.analyze_realtime_transcript(request, db_session))

    assert exc_info.value.status_code == 502
    assert 909 not in main_module._realtime_analysis_in_progress


def test_realtime_analysis_existing_result_returns_already_exists_even_when_running_state_present(
    db_session, monkeypatch
):
    meeting_id = 910
    transcript_hash = "f" * 64
    existing = Analysis(
        meeting_id=meeting_id,
        summary="cached summary",
        keywords=[],
        technical_terms={"transcript_hash": transcript_hash},
        action_items=[],
    )
    db_session.add(existing)
    db_session.commit()

    client = FakeRedisClient()
    client.hashes[main_module._analysis_state_key(meeting_id)] = {
        "meeting_id": str(meeting_id),
        "status": "RUNNING",
        "transcript_hash": transcript_hash,
        "started_at": str(time.time()),
        "updated_at": str(time.time()),
    }
    client.values[main_module._analysis_lock_key(meeting_id)] = "lock-token-910"
    client.ttls[main_module._analysis_lock_key(meeting_id)] = 180
    monkeypatch.setattr(main_module, "_get_client", lambda: client)

    request = RealtimeTranscriptAnalysisRequest(
        meeting_id=meeting_id,
        transcript="Speaker 1: cached summary",
        source="realtime",
        transcript_hash=transcript_hash,
    )

    response = asyncio.run(main_module.analyze_realtime_transcript(request, db_session))

    assert response.status == "skipped"
    assert response.reason == "already_exists"


def test_realtime_analysis_foreign_running_state_is_cleared_and_retried(
    db_session, monkeypatch
):
    meeting_id = 912
    transcript = "Speaker 1: foreign lock should be recovered"
    transcript_hash = main_module._compute_transcript_hash(transcript, None)
    client = FakeRedisClient()
    now_ms = int(time.time() * 1000)
    client.hashes[main_module._analysis_state_key(meeting_id)] = {
        "meetingId": str(meeting_id),
        "status": "RUNNING",
        "transcriptHash": transcript_hash,
        "startedAtMs": str(now_ms - 60_000),
        "updatedAtMs": str(now_ms - 30_000),
    }
    client.values[main_module._analysis_lock_key(meeting_id)] = "processing-lock-token"
    client.ttls[main_module._analysis_lock_key(meeting_id)] = 180
    monkeypatch.setattr(main_module, "_get_client", lambda: client)

    request = RealtimeTranscriptAnalysisRequest(
        meeting_id=meeting_id,
        transcript=transcript,
        source="realtime",
        transcript_hash=transcript_hash,
    )

    response = asyncio.run(main_module.analyze_realtime_transcript(request, db_session))

    assert response.status == "completed"
    saved = db_session.query(Analysis).filter(Analysis.meeting_id == meeting_id).first()
    assert saved is not None
    state = client.hashes.get(main_module._analysis_state_key(meeting_id), {})
    assert state.get("status") == "COMPLETED"
    assert state.get("owner") == "ai-api"


def test_realtime_analysis_orphan_foreign_lock_is_recovered_and_retried(
    db_session, monkeypatch
):
    meeting_id = 913
    transcript = "Speaker 1: orphan lock should not block forever"
    transcript_hash = main_module._compute_transcript_hash(transcript, None)
    client = FakeRedisClient()
    client.values[main_module._analysis_lock_key(meeting_id)] = "foreign-orphan-lock"
    client.ttls[main_module._analysis_lock_key(meeting_id)] = 180
    monkeypatch.setattr(main_module, "_get_client", lambda: client)

    request = RealtimeTranscriptAnalysisRequest(
        meeting_id=meeting_id,
        transcript=transcript,
        source="realtime",
        transcript_hash=transcript_hash,
    )

    response = asyncio.run(main_module.analyze_realtime_transcript(request, db_session))

    assert response.status == "completed"
    saved = db_session.query(Analysis).filter(Analysis.meeting_id == meeting_id).first()
    assert saved is not None
    assert main_module._analysis_lock_key(meeting_id) not in client.values


def test_try_begin_does_not_refresh_redis_lock_when_local_in_progress_is_fresh(
    monkeypatch,
):
    meeting_id = 911
    transcript_hash = "1" * 64
    client = FakeRedisClient()
    monkeypatch.setattr(main_module, "_get_client", lambda: client)
    now = time.time()
    main_module._realtime_analysis_in_progress[meeting_id] = (transcript_hash, now)

    allowed, skip_reason, _, retry_after, lock_token = (
        main_module._try_begin_realtime_analysis(
            meeting_id, transcript_hash, "realtime"
        )
    )

    assert not allowed
    assert skip_reason == "in_progress"
    assert retry_after > 0
    assert lock_token is None
    assert main_module._analysis_lock_key(meeting_id) not in client.values
