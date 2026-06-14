import asyncio
import json
import time

import pytest
import app.main as main_module
from app.models import Analysis, Base, MeetingAnalysisRun
from app.schemas import AnalysisRerunRequest, RealtimeTranscriptAnalysisRequest
from app.services.analysis_runs import persist_completed_analysis_run
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
            "businessActionItems": [
                {
                    "task": "Scale workers",
                    "owner": None,
                    "deadline": None,
                    "dueDate": None,
                    "priority": "high",
                    "status": "open",
                    "evidence": None,
                    "evidenceQuote": None,
                    "evidenceKeywords": ["workers", "scale"],
                }
            ],
            "domainMode": "it",
            "technical_terms": ["API"],
            "action_items": [
                {
                    "task": "Scale workers",
                    "owner": None,
                    "deadline": None,
                    "dueDate": None,
                    "priority": "high",
                    "status": "open",
                    "evidence": None,
                    "evidenceQuote": None,
                    "evidenceKeywords": ["workers", "scale"],
                }
            ],
        }

    def prepare_analysis_for_storage(self, transcript, data):
        return {
            "summary": str(data.get("summary") or ""),
            "keywords": list(data.get("keywords") or []),
            "technical_terms": list(data.get("technical_terms") or []),
            "action_items": list(data.get("action_items") or []),
            "businessActionItems": list(data.get("businessActionItems") or []),
            "actionItems": list(data.get("actionItems") or []),
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


class FakeRateLimitAnalyzer(FakeRealtimeAnalyzer):
    def _analyze_with_gemini(self, transcript, metadata=None):
        raise main_module.AnalysisRateLimitError(
            "Gemini rate limit reached",
            provider="gemini",
            error_code="GEMINI_RATE_LIMITED",
            retry_after_seconds=7,
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


def _default_cache_key(transcript_hash: str) -> str:
    return main_module._analysis_cache_key(
        transcript_hash,
        main_module.AIAnalyzer.PROMPT_VERSION,
        main_module.AIAnalyzer.SCHEMA_VERSION,
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


def test_rerun_analysis_uses_supplied_transcript_when_local_transcript_missing(
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(main_module, "_get_client", lambda: FakeRedisClient())
    monkeypatch.setattr(main_module, "set_job_status", lambda **kwargs: None)
    monkeypatch.setattr(
        main_module,
        "get_job_status",
        lambda meeting_id: {
            "status": "COMPLETED",
            "result": {
                "analysis": {
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
                    "source": "rerun",
                    "transcript_hash": "c" * 64,
                }
            },
        },
    )
    request = AnalysisRerunRequest(
        mode="force",
        reason="manual_reanalyze",
        transcript="SPEAKER_1: proxy supplied transcript",
        transcript_hash="c" * 64,
        prompt_version="prompt-v1",
        schema_version="schema-v1",
    )

    response = asyncio.run(main_module.rerun_analysis(906, request, db_session))

    assert response.meeting_id == 906
    assert response.analysisStatus == "COMPLETED"
    assert response.source == "rerun"
    assert response.transcript_hash == "c" * 64
    assert main_module._realtime_analysis_analyzer.calls[0][0] == (
        "SPEAKER_1: proxy supplied transcript"
    )

    run = (
        db_session.query(MeetingAnalysisRun)
        .filter(MeetingAnalysisRun.meeting_id == 906)
        .one()
    )
    assert run.rerun_reason == "manual_reanalyze"


def test_rerun_analysis_returns_clear_not_found_when_transcript_missing(db_session):
    request = AnalysisRerunRequest(mode="force", reason="manual_reanalyze")

    with pytest.raises(main_module.HTTPException) as exc_info:
        asyncio.run(main_module.rerun_analysis(907, request, db_session))

    assert exc_info.value.status_code == 404
    assert (
        exc_info.value.detail
        == "Cannot re-analyze because saved transcript was not found."
    )
    assert db_session.query(Analysis).filter(Analysis.meeting_id == 907).first() is None


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
    assert first.promptVersion == main_module.AIAnalyzer.PROMPT_VERSION
    assert first.schemaVersion == main_module.AIAnalyzer.SCHEMA_VERSION
    assert second.status == "completed"
    assert second.cacheHit is True
    assert second.analysisStatus == "COMPLETED"
    assert second.promptVersion == main_module.AIAnalyzer.PROMPT_VERSION
    assert second.schemaVersion == main_module.AIAnalyzer.SCHEMA_VERSION

    saved = db_session.query(Analysis).filter(Analysis.meeting_id == 902).first()
    assert saved is not None
    assert saved.summary == "Realtime summary"
    assert isinstance(saved.technical_terms, dict)
    assert saved.technical_terms.get("transcript_hash") == "a" * 64
    assert (
        saved.technical_terms.get("promptVersion")
        == main_module.AIAnalyzer.PROMPT_VERSION
    )
    assert (
        saved.technical_terms.get("schemaVersion")
        == main_module.AIAnalyzer.SCHEMA_VERSION
    )
    assert saved.action_items == [
        {
            "task": "Scale workers",
            "owner": None,
            "deadline": None,
            "dueDate": None,
            "priority": "high",
            "status": "open",
            "evidence": None,
            "evidenceQuote": None,
            "evidenceKeywords": ["workers", "scale"],
        }
    ]
    assert len(main_module._realtime_analysis_analyzer.calls) == 1

    run = (
        db_session.query(MeetingAnalysisRun)
        .filter(MeetingAnalysisRun.meeting_id == 902)
        .one()
    )
    assert run.status == "COMPLETED"
    assert run.provider == "gemini"
    assert run.model == "unknown"
    assert run.prompt_version == main_module.AIAnalyzer.PROMPT_VERSION
    assert run.schema_version == main_module.AIAnalyzer.SCHEMA_VERSION
    assert run.canonical_transcript_hash == "a" * 64
    assert run.canonical_transcript_version is None
    assert run.analysis_input_mode == "readable_fallback"
    assert run.analysis_payload_json["summary"] == "Realtime summary"
    assert run.analysis_payload_json["action_items"] == saved.action_items
    assert run.analysis_payload_json["businessActionItems"] == saved.action_items
    assert run.analysis_payload_json["actionItems"] == ["Scale workers"]


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


def test_realtime_analysis_rate_limit_preserves_metadata_and_cooldown(
    db_session, monkeypatch
):
    client = FakeRedisClient()
    monkeypatch.setattr(main_module, "_get_client", lambda: client)
    monkeypatch.setattr(
        main_module, "_realtime_analysis_analyzer", FakeRateLimitAnalyzer()
    )
    request = RealtimeTranscriptAnalysisRequest(
        meeting_id=914,
        transcript="Speaker 1: rate limited path",
        source="realtime",
    )

    with pytest.raises(main_module.HTTPException) as exc_info:
        asyncio.run(main_module.analyze_realtime_transcript(request, db_session))

    assert exc_info.value.status_code == 429
    assert exc_info.value.detail["error"] == "GEMINI_RATE_LIMITED"
    assert exc_info.value.detail["details"]["provider"] == "gemini"
    assert exc_info.value.detail["details"]["retryable"] is True
    assert exc_info.value.detail["details"]["retryAfterSeconds"] == 7
    state = client.hashes[main_module._analysis_state_key(914)]
    assert state["status"] == "FAILED"
    assert state["error_code"] == "GEMINI_RATE_LIMITED"
    assert state["retry_after_seconds"] == "7"


def test_http_exception_handler_maps_structured_gemini_429_to_canonical_body():
    request = main_module.Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/internal/realtime-analysis",
            "headers": [],
            "query_string": b"",
        }
    )
    exc = main_module.HTTPException(
        status_code=429,
        detail={
            "error": "GEMINI_RATE_LIMITED",
            "message": "Gemini rate limit reached",
            "details": {
                "provider": "gemini",
                "retryable": True,
                "retryAfterSeconds": 7,
                "errorCode": "GEMINI_RATE_LIMITED",
            },
        },
    )

    response = asyncio.run(main_module.http_exception_handler(request, exc))
    body = json.loads(response.body.decode("utf-8"))

    assert response.status_code == 429
    assert body["error"] == "GEMINI_RATE_LIMITED"
    assert body["status"] == 429
    assert body["details"]["provider"] == "gemini"
    assert body["details"]["retryable"] is True
    assert body["details"]["retryAfterSeconds"] == 7
    assert body["details"]["errorCode"] == "GEMINI_RATE_LIMITED"


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
        lambda meeting_id, analysis_cache_key, source, prompt_version, schema_version: (
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
        lambda meeting_id, analysis_cache_key, source, prompt_version, schema_version: (
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
    cache_key = _default_cache_key(transcript_hash)
    client = FakeRedisClient()
    now = time.time()
    client.hashes[main_module._analysis_state_key(meeting_id)] = {
        "meeting_id": str(meeting_id),
        "status": "RUNNING",
        "analysis_cache_key": cache_key,
        "transcript_hash": cache_key,
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
    cache_key = _default_cache_key(transcript_hash)
    client = FakeRedisClient()
    stale_started = time.time() - (main_module._REALTIME_ANALYSIS_STALE_SECONDS + 10)
    client.hashes[main_module._analysis_state_key(meeting_id)] = {
        "meeting_id": str(meeting_id),
        "status": "RUNNING",
        "analysis_cache_key": cache_key,
        "transcript_hash": cache_key,
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
    cache_key = _default_cache_key(transcript_hash)
    existing = Analysis(
        meeting_id=meeting_id,
        summary="cached summary",
        keywords=[],
        technical_terms={
            "transcript_hash": transcript_hash,
            "promptVersion": main_module.AIAnalyzer.PROMPT_VERSION,
            "schemaVersion": main_module.AIAnalyzer.SCHEMA_VERSION,
        },
        action_items=[],
    )
    db_session.add(existing)
    persist_completed_analysis_run(
        db=db_session,
        meeting_id=meeting_id,
        analyzer=main_module._realtime_analysis_analyzer,
        analysis_payload={
            "summary": "cached summary",
            "transcriptHash": transcript_hash,
            "promptVersion": main_module.AIAnalyzer.PROMPT_VERSION,
            "schemaVersion": main_module.AIAnalyzer.SCHEMA_VERSION,
        },
        summary="cached summary",
        fallback_transcript_hash=transcript_hash,
        fallback_text="Speaker 1: cached summary",
    )
    db_session.commit()

    client = FakeRedisClient()
    client.hashes[main_module._analysis_state_key(meeting_id)] = {
        "meeting_id": str(meeting_id),
        "status": "RUNNING",
        "analysis_cache_key": cache_key,
        "transcript_hash": cache_key,
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

    assert response.status == "completed"
    assert response.cacheHit is True
    assert response.analysisStatus == "COMPLETED"


def test_realtime_analysis_foreign_running_state_is_cleared_and_retried(
    db_session, monkeypatch
):
    meeting_id = 912
    transcript = "Speaker 1: foreign lock should be recovered"
    transcript_hash = main_module._compute_transcript_hash(transcript, None)
    cache_key = _default_cache_key(transcript_hash)
    client = FakeRedisClient()
    now_ms = int(time.time() * 1000)
    client.hashes[main_module._analysis_state_key(meeting_id)] = {
        "meetingId": str(meeting_id),
        "status": "RUNNING",
        "analysis_cache_key": cache_key,
        "transcriptHash": cache_key,
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
    cache_key = _default_cache_key(transcript_hash)
    client = FakeRedisClient()
    monkeypatch.setattr(main_module, "_get_client", lambda: client)
    now = time.time()
    main_module._realtime_analysis_in_progress[meeting_id] = (cache_key, now)

    allowed, skip_reason, _, retry_after, lock_token = (
        main_module._try_begin_realtime_analysis(meeting_id, cache_key, "realtime")
    )

    assert not allowed
    assert skip_reason == "in_progress"
    assert retry_after > 0
    assert lock_token is None
    assert main_module._analysis_lock_key(meeting_id) not in client.values
