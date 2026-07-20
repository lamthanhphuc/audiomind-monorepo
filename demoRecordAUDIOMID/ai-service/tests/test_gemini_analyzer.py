import importlib
import importlib.util
import json
from pathlib import Path

import pytest

from app.services.analysis_errors import (
    AnalysisConfigError,
    AnalysisParseError,
    AnalysisRateLimitError,
    AnalysisUnavailableError,
)

MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "app" / "services" / "gemini_analyzer.py"
)
SPEC = importlib.util.spec_from_file_location("gemini_analyzer", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
GeminiAnalyzer = MODULE.GeminiAnalyzer
AI_MODULE = importlib.import_module("app.services.ai_analyzer")
GEMINI_CLIENT_MODULE = importlib.import_module("app.services.gemini_client")
KEY_MANAGER_MODULE = importlib.import_module("app.services.gemini_key_manager")


class _FakeResponse:
    def __init__(
        self,
        status_code: int,
        body: dict | None = None,
        text: str = "",
        headers: dict | None = None,
    ):
        self.status_code = status_code
        self._body = body or {}
        self._text = text
        self.headers = headers or {}

    def json(self):
        if self._body:
            return self._body
        return json.loads(self._text)

    @property
    def text(self):
        if self._text:
            return self._text
        return json.dumps(self._body)


class _FakeClient:
    def __init__(self, responses: list[_FakeResponse]):
        if isinstance(responses, _FakeResponse):
            responses = [responses]
        self.responses = list(responses)
        self.calls = []
        self.index = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def post(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.index < len(self.responses):
            response = self.responses[self.index]
            self.index += 1
            return response
        return self.responses[-1]


def test_gemini_prepare_storage_does_not_fabricate_action_items_when_missing():
    analyzer = GeminiAnalyzer(api_key="test-gemini-key")

    prepared = analyzer.prepare_analysis_for_storage(
        transcript="Speaker 1: cần cập nhật API gateway trong tuần này",
        data={
            "summary": "Summary only",
            "keywords": ["API"],
            "technicalTerms": [],
            "painPoints": [],
            "action_items": [],
            "businessActionItems": [],
            "actionItems": [],
            "promptVersion": "gemini-business-v2",
            "schemaVersion": "gemini-business-v2",
        },
    )

    assert prepared["action_items"] == []
    assert prepared["businessActionItems"] == []
    assert prepared["actionItems"] == []


def _success_response(summary: str = "Safe") -> _FakeResponse:
    return _FakeResponse(
        200,
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "text": json.dumps(
                                    {
                                        "summary": summary,
                                        "keywords": ["api"],
                                        "technicalTerms": [
                                            {
                                                "term": "API",
                                                "meaning": "Application Programming Interface",
                                                "category": "protocol",
                                            }
                                        ],
                                        "painPoints": [
                                            {
                                                "title": "Do tre",
                                                "evidence": "API cham",
                                                "severity": "high",
                                            }
                                        ],
                                        "actionItems": ["Cap nhat env"],
                                        "domainMode": "it",
                                    }
                                )
                            }
                        ]
                    }
                }
            ]
        },
    )


def _analyzer_with_multi_key(**overrides):
    defaults = {
        "api_key": "key-a",
        "gemini_api_keys": "primary:key-a,backup1:key-b,backup2:key-c",
        "gemini_multi_key_enabled": True,
        "gemini_max_attempts": 3,
        "gemini_key_cooldown_seconds": 30,
        "gemini_key_hard_cooldown_seconds": 300,
        "gemini_backoff_base_ms": 0,
        "gemini_backoff_max_ms": 0,
        "gemini_backoff_jitter": False,
        "gemini_fail_fast_seconds": 30,
    }
    defaults.update(overrides)
    return GeminiAnalyzer(**defaults)


def _request_keys(fake_client: _FakeClient) -> list[str]:
    return [kwargs["headers"]["x-goog-api-key"] for _, kwargs in fake_client.calls]


class _CaptureLogger:
    def __init__(self):
        self.messages = []

    def info(self, message, *args, **kwargs):
        self._capture(message, *args)

    def warning(self, message, *args, **kwargs):
        self._capture(message, *args)

    def error(self, message, *args, **kwargs):
        self._capture(message, *args)

    def _capture(self, message, *args):
        rendered = str(message)
        if args:
            try:
                rendered = rendered.format(*args)
            except Exception:
                rendered = f"{rendered} {' '.join(str(arg) for arg in args)}"
        self.messages.append(rendered)


def test_gemini_multi_key_rotates_after_429_and_succeeds(monkeypatch):
    fake_client = _FakeClient(
        [
            _FakeResponse(
                429,
                text='{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota"}}',
                headers={"Retry-After": "7"},
            ),
            _success_response("Recovered"),
        ]
    )
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = _analyzer_with_multi_key()
    result = analyzer._analyze_with_gemini("Speaker 1: safe transcript")

    assert result["summary"] == "Recovered"
    assert _request_keys(fake_client) == ["key-a", "key-b"]


def test_gemini_multi_key_all_429_raises_rate_limit_with_retry_after(monkeypatch):
    fake_client = _FakeClient(
        [
            _FakeResponse(
                429,
                text='{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota"}}',
                headers={"Retry-After": "9"},
            ),
            _FakeResponse(
                429,
                text='{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota"}}',
                headers={"Retry-After": "5"},
            ),
        ]
    )
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = _analyzer_with_multi_key(
        gemini_api_keys="primary:key-a,backup1:key-b",
        gemini_max_attempts=4,
    )

    with pytest.raises(AnalysisRateLimitError) as exc_info:
        analyzer._analyze_with_gemini("Speaker 1: safe transcript")

    assert exc_info.value.error_code == "GEMINI_RATE_LIMITED"
    assert exc_info.value.retry_after_seconds == 5
    assert _request_keys(fake_client) == ["key-a", "key-b"]


def test_gemini_multi_key_invalid_key_then_valid_key_succeeds(monkeypatch):
    fake_client = _FakeClient(
        [
            _FakeResponse(401, text='{"error":{"status":"UNAUTHENTICATED"}}'),
            _success_response("Backup"),
        ]
    )
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = _analyzer_with_multi_key()
    result = analyzer._analyze_with_gemini("Speaker 1: safe transcript")

    assert result["summary"] == "Backup"
    assert _request_keys(fake_client) == ["key-a", "key-b"]


def test_gemini_multi_key_attempt_budget_covers_all_configured_keys(monkeypatch):
    """max_attempts may be smaller than pool size; still try every key once."""
    fake_client = _FakeClient(
        [
            _FakeResponse(503, text='{"error":{"status":"UNAVAILABLE"}}'),
            _FakeResponse(503, text='{"error":{"status":"UNAVAILABLE"}}'),
            _success_response("Reached via pool-sized attempts"),
        ]
    )
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = _analyzer_with_multi_key(gemini_max_attempts=2)

    result = analyzer._analyze_with_gemini("Speaker 1: safe transcript")

    assert result["summary"] == "Reached via pool-sized attempts"
    assert _request_keys(fake_client) == ["key-a", "key-b", "key-c"]


def test_gemini_client_caps_http_timeout_to_fail_fast_remaining_budget():
    fake_client = _FakeClient([_success_response("Deadline capped")])
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a",
        multi_key_enabled=True,
        clock=lambda: 100.0,
    )
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=2,
        backoff_base_ms=0,
        fail_fast_seconds=7,
        http_client_factory=lambda timeout: fake_client,
        clock=lambda: 100.0,
        sleep=lambda seconds: None,
        random_float=lambda low, high: high,
    )

    response = client.post_json(
        url="https://example.test/gemini",
        payload={"contents": []},
        timeout_seconds=300,
    )

    assert response.response.status_code == 200
    assert response.key_alias == "primary"
    assert fake_client.calls[0][1]["timeout"] == pytest.approx(7.0)


def test_gemini_client_fail_fast_grace_still_tries_eligible_backup():
    """After fail-fast budget is spent, still try one remaining eligible key."""
    fake_client = _FakeClient(
        [
            _FakeResponse(503, text='{"error":{"status":"UNAVAILABLE"}}'),
            _success_response("Backup after fail-fast grace"),
        ]
    )
    now = {"value": 0.0}
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup:key-b",
        multi_key_enabled=True,
        clock=lambda: now["value"],
    )
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=4,
        backoff_base_ms=2000,
        backoff_max_ms=2000,
        backoff_jitter=False,
        fail_fast_seconds=1,
        http_client_factory=lambda timeout: fake_client,
        clock=lambda: now["value"],
        sleep=lambda seconds: now.__setitem__("value", now["value"] + seconds),
        random_float=lambda low, high: high,
    )

    result = client.post_json(
        url="https://example.test/gemini",
        payload={"contents": []},
        timeout_seconds=300,
    )

    assert result.key_alias == "backup"
    assert result.response.status_code == 200
    assert _request_keys(fake_client) == ["key-a", "key-b"]


def test_gemini_multi_key_timeout_then_success(monkeypatch):
    class _TimeoutThenSuccessClient(_FakeClient):
        def post(self, *args, **kwargs):
            self.calls.append((args, kwargs))
            if len(self.calls) == 1:
                raise AI_MODULE.httpx.TimeoutException("timed out")
            return _success_response("After timeout")

    fake_client = _TimeoutThenSuccessClient([])
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = _analyzer_with_multi_key()
    result = analyzer._analyze_with_gemini("Speaker 1: safe transcript")

    assert result["summary"] == "After timeout"
    assert _request_keys(fake_client) == ["key-a", "key-b"]


def test_gemini_analyzer_parses_valid_json(monkeypatch):
    response = _FakeResponse(
        200,
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "text": json.dumps(
                                    {
                                        "summary": "Tong hop cuoc hop",
                                        "keywords": ["API", "deployment"],
                                        "technicalTerms": [
                                            {
                                                "term": "API",
                                                "meaning": "Giao dien lap trinh ung dung",
                                                "category": "protocol",
                                            }
                                        ],
                                        "painPoints": [
                                            {
                                                "title": "Thieu API key",
                                                "evidence": "khong goi duoc Gemini",
                                                "severity": "high",
                                            }
                                        ],
                                        "action_items": [
                                            {
                                                "task": "Cap nhat env",
                                                "owner": "Team DevOps",
                                                "deadline": "2026-06-20",
                                                "priority": "high",
                                                "status": "in_progress",
                                                "evidenceKeywords": [
                                                    "Gemini",
                                                    "API key",
                                                ],
                                            }
                                        ],
                                        "domainMode": "it",
                                    }
                                )
                            }
                        ]
                    }
                }
            ]
        },
    )
    fake_client = _FakeClient([response])
    monkeypatch.setattr(MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = GeminiAnalyzer(
        api_key="test-gemini-key",
        gemini_backoff_base_ms=2000,
        gemini_backoff_max_ms=4000,
        gemini_backoff_jitter=False,
    )
    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] == "Tong hop cuoc hop"
    assert result["keywords"] == ["deployment"]
    assert result["technicalTerms"][0]["term"] == "API"
    assert result["painPoints"][0]["severity"] == "high"
    assert result["actionItems"] == ["Cap nhat env"]
    assert result["action_items"] == result["businessActionItems"]
    assert result["businessActionItems"][0] == {
        "task": "Cap nhat env",
        "owner": "Team DevOps",
        "dueDate": "2026-06-20",
        "deadline": "2026-06-20",
        "priority": "high",
        "status": "in_progress",
        "evidence": None,
        "evidenceQuote": None,
        "evidenceKeywords": ["Gemini", "API key"],
    }
    assert result["domainMode"] == "it"
    assert result["key_points"] == ["deployment"]
    assert result["risks_blockers"] == ["Thieu API key"]
    assert result["promptVersion"] == AI_MODULE.AIAnalyzer.PROMPT_VERSION
    assert result["schemaVersion"] == AI_MODULE.AIAnalyzer.SCHEMA_VERSION
    assert result["promptVersion"] == "gemini-business-v2"
    assert result["schemaVersion"] == "gemini-business-v2"


def test_gemini_analyzer_uses_api_key_header(monkeypatch):
    fake_client = _FakeClient([_success_response()])
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = GeminiAnalyzer(
        api_key="test-gemini-key",
        gemini_backoff_base_ms=2000,
        gemini_backoff_max_ms=4000,
        gemini_backoff_jitter=False,
    )
    analyzer.analyze_meeting("hello world")

    assert len(fake_client.calls) == 1
    for args, kwargs in fake_client.calls:
        assert args[0].endswith(":generateContent")
        assert "?key=" not in args[0]
        assert kwargs["headers"]["x-goog-api-key"] == "test-gemini-key"
        assert "params" not in kwargs


def test_gemini_analyzer_retries_503_then_succeeds(monkeypatch):
    fake_client = _FakeClient(
        [
            _FakeResponse(503, text='{"error":{"message":"unavailable"}}'),
            _success_response(summary="Recovered after retry"),
        ]
    )
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    sleep_calls = []
    monkeypatch.setattr(
        AI_MODULE.time, "sleep", lambda seconds: sleep_calls.append(seconds)
    )

    analyzer = GeminiAnalyzer(
        api_key="test-gemini-key",
        gemini_backoff_base_ms=2000,
        gemini_backoff_max_ms=4000,
        gemini_backoff_jitter=False,
    )
    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] == "Recovered after retry"
    assert len(fake_client.calls) == 2
    assert sleep_calls == [2]


def test_gemini_analyzer_retries_503_three_times_then_fails(monkeypatch):
    fake_client = _FakeClient(
        [
            _FakeResponse(503, text='{"error":{"message":"unavailable"}}'),
            _FakeResponse(503, text='{"error":{"message":"unavailable"}}'),
            _FakeResponse(503, text='{"error":{"message":"unavailable"}}'),
        ]
    )
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    sleep_calls = []
    monkeypatch.setattr(
        AI_MODULE.time, "sleep", lambda seconds: sleep_calls.append(seconds)
    )

    analyzer = GeminiAnalyzer(
        api_key="test-gemini-key",
        gemini_backoff_base_ms=2000,
        gemini_backoff_max_ms=4000,
        gemini_backoff_jitter=False,
    )

    with pytest.raises(AnalysisUnavailableError):
        analyzer.analyze_meeting("hello world")

    assert len(fake_client.calls) == 3
    assert sleep_calls == [2, 4]


def test_gemini_analyzer_retries_429_with_retry_after_then_succeeds(monkeypatch):
    fake_client = _FakeClient(
        [
            _FakeResponse(
                429,
                body={"error": {"message": "rate limited"}},
                text="",
                headers={"Retry-After": "30"},
            ),
            _success_response(summary="Recovered from rate limit"),
        ]
    )
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    sleep_calls = []
    monkeypatch.setattr(
        AI_MODULE.time, "sleep", lambda seconds: sleep_calls.append(seconds)
    )

    analyzer = GeminiAnalyzer(
        api_key="key-a",
        gemini_api_keys="primary:key-a,backup1:key-b",
        gemini_multi_key_enabled=True,
        gemini_backoff_base_ms=0,
        gemini_backoff_jitter=False,
    )
    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] == "Recovered from rate limit"
    assert len(fake_client.calls) == 2
    assert sleep_calls == []
    assert _request_keys(fake_client) == ["key-a", "key-b"]


def test_gemini_analyzer_retries_429_without_retry_after_then_succeeds(monkeypatch):
    fake_client = _FakeClient(
        [
            _FakeResponse(429, text='{"error":{"message":"rate limited"}}'),
            _FakeResponse(429, text='{"error":{"message":"rate limited"}}'),
            _FakeResponse(429, text='{"error":{"message":"rate limited"}}'),
            _success_response(summary="Recovered after longer backoff"),
        ]
    )
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    sleep_calls = []
    monkeypatch.setattr(
        AI_MODULE.time, "sleep", lambda seconds: sleep_calls.append(seconds)
    )

    analyzer = GeminiAnalyzer(
        api_key="key-a",
        gemini_api_keys="primary:key-a,backup1:key-b,backup2:key-c,backup3:key-d",
        gemini_multi_key_enabled=True,
        gemini_max_attempts=4,
        gemini_backoff_base_ms=0,
        gemini_backoff_jitter=False,
    )
    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] == "Recovered after longer backoff"
    assert len(fake_client.calls) == 4
    assert sleep_calls == []
    assert _request_keys(fake_client) == ["key-a", "key-b", "key-c", "key-d"]


def test_gemini_analyzer_quota_429_fails_fast_by_default(monkeypatch):
    fake_client = _FakeClient(
        [
            _FakeResponse(
                429,
                text='{"error":{"message":"Quota exceeded","status":"RESOURCE_EXHAUSTED"}}',
            ),
            _success_response(summary="Should not be called"),
        ]
    )
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    sleep_calls = []
    monkeypatch.setattr(
        AI_MODULE.time, "sleep", lambda seconds: sleep_calls.append(seconds)
    )

    analyzer = GeminiAnalyzer(
        api_key="test-gemini-key",
        gemini_backoff_base_ms=0,
        gemini_backoff_jitter=False,
    )
    with pytest.raises(AnalysisRateLimitError):
        analyzer.analyze_meeting("hello world")

    assert len(fake_client.calls) == 1
    assert sleep_calls == []


def test_gemini_analyzer_fills_missing_fields(monkeypatch):
    response = _FakeResponse(
        200,
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "text": json.dumps(
                                    {
                                        "summary": "Summary only",
                                        "keywords": ["A", "A"],
                                    }
                                )
                            }
                        ]
                    }
                }
            ]
        },
    )
    monkeypatch.setattr(
        AI_MODULE.httpx, "Client", lambda timeout: _FakeClient(response)
    )

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] == "Summary only"
    assert result["keywords"] == ["A"]
    assert result["technicalTerms"] == []
    assert result["painPoints"] == []
    assert result["actionItems"] == []
    assert result["domainMode"] == "it"
    assert result["promptVersion"] == AI_MODULE.AIAnalyzer.PROMPT_VERSION
    assert result["schemaVersion"] == AI_MODULE.AIAnalyzer.SCHEMA_VERSION


def test_gemini_analyzer_normalizes_legacy_action_item_strings(monkeypatch):
    response = _FakeResponse(
        200,
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "text": json.dumps(
                                    {
                                        "summary": "Legacy action item shape",
                                        "keywords": [],
                                        "technicalTerms": [],
                                        "painPoints": [],
                                        "actionItems": ["Cap nhat backlog"],
                                        "domainMode": "business",
                                    }
                                )
                            }
                        ]
                    }
                }
            ]
        },
    )
    monkeypatch.setattr(
        AI_MODULE.httpx, "Client", lambda timeout: _FakeClient(response)
    )

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    result = analyzer.analyze_meeting("Speaker 1: cap nhat backlog")

    assert result["actionItems"] == ["Cap nhat backlog"]
    assert result["action_items"] == result["businessActionItems"]
    assert result["action_items"][0] == {
        "task": "Cap nhat backlog",
        "owner": None,
        "dueDate": None,
        "deadline": None,
        "priority": None,
        "status": "open",
        "evidence": None,
        "evidenceQuote": None,
        "evidenceKeywords": [],
    }


def test_gemini_analyzer_normalizes_action_item_status_priority_and_legacy_evidence(
    monkeypatch,
):
    response = _FakeResponse(
        200,
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "text": json.dumps(
                                    {
                                        "summary": "Status mapping",
                                        "keywords": [],
                                        "technicalTerms": [],
                                        "painPoints": [],
                                        "action_items": [
                                            {
                                                "task": "Pending task",
                                                "status": "pending",
                                            },
                                            {
                                                "task": "Completed task",
                                                "status": "completed",
                                                "priority": "urgent",
                                            },
                                            {
                                                "task": "Cancelled task",
                                                "status": "cancelled",
                                                "evidenceQuote": "legacy quote",
                                                "evidence": "legacy note",
                                            },
                                            {
                                                "task": "Unknown task",
                                                "status": "mystery",
                                            },
                                        ],
                                        "domainMode": "business",
                                    }
                                )
                            }
                        ]
                    }
                }
            ]
        },
    )
    monkeypatch.setattr(
        AI_MODULE.httpx, "Client", lambda timeout: _FakeClient(response)
    )

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    result = analyzer.analyze_meeting("Speaker 1: status mapping")

    assert [item["status"] for item in result["action_items"]] == [
        "open",
        "done",
        "blocked",
        "open",
    ]
    assert result["action_items"][1]["priority"] is None
    assert result["action_items"][2]["evidenceQuote"] == "legacy quote"
    assert result["action_items"][2]["evidence"] == "legacy note"


def test_gemini_analyzer_does_not_log_action_item_payload_values(monkeypatch):
    response = _FakeResponse(
        200,
        {
            "candidates": [
                {
                    "finishReason": "STOP",
                    "content": {
                        "parts": [
                            {
                                "text": json.dumps(
                                    {
                                        "summary": "Safe summary",
                                        "keywords": [],
                                        "technicalTerms": [],
                                        "painPoints": [],
                                        "action_items": [
                                            {
                                                "task": "FULL TASK TEXT SECRET",
                                                "owner": "OWNER SECRET",
                                                "deadline": "DEADLINE SECRET",
                                                "priority": "high",
                                                "status": "open",
                                                "evidence": "EVIDENCE SECRET",
                                                "evidenceQuote": "QUOTE SECRET",
                                                "evidenceKeywords": ["KEYWORD SECRET"],
                                            }
                                        ],
                                        "domainMode": "business",
                                    }
                                )
                            }
                        ]
                    },
                }
            ]
        },
    )
    monkeypatch.setattr(
        AI_MODULE.httpx, "Client", lambda timeout: _FakeClient(response)
    )
    capture_logger = _CaptureLogger()
    monkeypatch.setattr(AI_MODULE, "logger", capture_logger)

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    result = analyzer.analyze_meeting("Speaker 1: sanitized logging")

    assert result["actionItems"] == ["FULL TASK TEXT SECRET"]
    joined_logs = "\n".join(capture_logger.messages)
    assert "action_items_count=1" in joined_logs
    for unsafe_value in [
        "FULL TASK TEXT SECRET",
        "OWNER SECRET",
        "DEADLINE SECRET",
        "EVIDENCE SECRET",
        "QUOTE SECRET",
        "KEYWORD SECRET",
    ]:
        assert unsafe_value not in joined_logs


def test_gemini_analyzer_invalid_json_does_not_log_raw_response(monkeypatch):
    raw_response = '{"summary": "RAW RESPONSE SECRET", bad}'
    response = _FakeResponse(
        200,
        {"candidates": [{"content": {"parts": [{"text": raw_response}]}}]},
    )
    monkeypatch.setattr(
        AI_MODULE.httpx, "Client", lambda timeout: _FakeClient(response)
    )
    capture_logger = _CaptureLogger()
    monkeypatch.setattr(AI_MODULE, "logger", capture_logger)

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    with pytest.raises(AnalysisParseError):
        analyzer.analyze_meeting("hello world")

    joined_logs = "\n".join(capture_logger.messages)
    assert "GEMINI_ANALYSIS_PARSE_FAILED" in joined_logs
    assert "RAW RESPONSE SECRET" not in joined_logs
    assert raw_response not in joined_logs


def test_gemini_analyzer_retries_without_schema_after_invalid_json(monkeypatch):
    valid_payload = {
        "summary": "Tong hop hop",
        "keywords": ["it"],
        "technicalTerms": [],
        "painPoints": [],
        "actionItems": [{"task": "Follow up"}],
        "domainMode": "it",
    }
    invalid_response = _FakeResponse(
        200,
        {
            "candidates": [
                {"content": {"parts": [{"text": '{"summary": "broken", bad}'}]}}
            ]
        },
    )
    valid_response = _FakeResponse(
        200,
        {"candidates": [{"content": {"parts": [{"text": json.dumps(valid_payload)}]}}]},
    )
    fake_client = _FakeClient([invalid_response, valid_response])
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = GeminiAnalyzer(api_key="test-gemini-key", analysis_domain_mode="it")
    result = analyzer.analyze_meeting("Speaker 1: hello")

    assert result["summary"] == "Tong hop hop"


def test_gemini_analyzer_repairs_json_via_llm_after_double_parse_failure(monkeypatch):
    valid_payload = {
        "summary": "Tong hop hop",
        "keywords": ["it"],
        "technicalTerms": [],
        "painPoints": [],
        "actionItems": [{"task": "Follow up"}],
        "domainMode": "it",
    }
    responses = [
        '{"summary": "broken", bad}',
        '{"summary": "still broken", bad}',
        json.dumps(valid_payload),
    ]

    def fake_call(self, **kwargs):
        if not responses:
            raise AssertionError("unexpected extra Gemini call")
        return responses.pop(0)

    monkeypatch.setattr(GeminiAnalyzer, "_call_gemini_text", fake_call)

    analyzer = GeminiAnalyzer(api_key="test-gemini-key", analysis_domain_mode="it")
    result = analyzer.analyze_meeting("Speaker 1: hello")

    assert result["summary"] == "Tong hop hop"
    assert responses == []


def test_gemini_analyzer_does_not_invent_owner_or_due_date(monkeypatch):
    response = _FakeResponse(
        200,
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "text": json.dumps(
                                    {
                                        "summary": "Tong hop cuoc hop",
                                        "keywords": ["planning"],
                                        "technicalTerms": [],
                                        "painPoints": [],
                                        "actionItems": [{"task": "Cap nhat backlog"}],
                                        "domainMode": "business",
                                    }
                                )
                            }
                        ]
                    }
                }
            ]
        },
    )
    monkeypatch.setattr(
        AI_MODULE.httpx, "Client", lambda timeout: _FakeClient(response)
    )

    analyzer = GeminiAnalyzer(
        api_key="test-gemini-key", analysis_domain_mode="business"
    )
    result = analyzer.analyze_meeting("Speaker 1: cap nhat backlog")

    assert result["actionItems"] == ["Cap nhat backlog"]
    assert result["businessActionItems"][0]["owner"] is None
    assert result["businessActionItems"][0]["dueDate"] is None


def test_gemini_analyzer_rejects_invalid_json(monkeypatch):
    response = _FakeResponse(
        200,
        {
            "candidates": [
                {"content": {"parts": [{"text": "```json\n{bad json}\n```"}]}}
            ]
        },
    )
    monkeypatch.setattr(
        AI_MODULE.httpx, "Client", lambda timeout: _FakeClient(response)
    )

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    with pytest.raises(AnalysisParseError):
        analyzer.analyze_meeting("hello world")


def test_gemini_analyzer_requires_api_key():
    analyzer = GeminiAnalyzer(api_key="")

    with pytest.raises(AnalysisConfigError):
        analyzer.analyze_meeting("hello world")


def test_gemini_analyzer_parses_markdown_fenced_json(monkeypatch):
    response = _FakeResponse(
        200,
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "text": "```json\n"
                                + json.dumps(
                                    {
                                        "summary": "Tong hop cuoc hop",
                                        "keywords": ["API"],
                                        "technicalTerms": [],
                                        "painPoints": [],
                                        "actionItems": [],
                                        "domainMode": "it",
                                    }
                                )
                                + "\n```",
                            }
                        ]
                    }
                }
            ]
        },
    )
    monkeypatch.setattr(
        AI_MODULE.httpx, "Client", lambda timeout: _FakeClient(response)
    )

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] == "Tong hop cuoc hop"
    assert result["keywords"] == ["API"]
    assert result["domainMode"] == "it"


def test_gemini_analyzer_parses_json_with_surrounding_text(monkeypatch):
    response = _FakeResponse(
        200,
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "text": "Ket qua: "
                                + json.dumps(
                                    {
                                        "summary": "Tong hop cuoc hop",
                                        "keywords": ["cache"],
                                        "technicalTerms": [],
                                        "painPoints": [],
                                        "actionItems": [],
                                        "domainMode": "it",
                                    }
                                )
                                + " -- xong",
                            }
                        ]
                    }
                }
            ]
        },
    )
    monkeypatch.setattr(
        AI_MODULE.httpx, "Client", lambda timeout: _FakeClient(response)
    )

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] == "Tong hop cuoc hop"
    assert result["keywords"] == ["cache"]
    assert result["domainMode"] == "it"


def test_gemini_analyzer_does_not_log_api_key(monkeypatch):
    response = _FakeResponse(
        200,
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "text": json.dumps(
                                    {
                                        "summary": "Safe",
                                        "key_points": [],
                                        "decisions": [],
                                        "action_items": [],
                                        "risks_blockers": [],
                                        "topics": [],
                                    }
                                )
                            }
                        ]
                    }
                }
            ]
        },
    )
    monkeypatch.setattr(
        AI_MODULE.httpx, "Client", lambda timeout: _FakeClient(response)
    )

    captured_messages = []

    class _CaptureLogger:
        def info(self, message, *args, **kwargs):
            rendered = str(message)
            if args:
                try:
                    rendered = rendered.format(*args)
                except Exception:
                    rendered = f"{rendered} {' '.join(str(arg) for arg in args)}"
            captured_messages.append(rendered)

        def warning(self, message, *args, **kwargs):
            rendered = str(message)
            if args:
                try:
                    rendered = rendered.format(*args)
                except Exception:
                    rendered = f"{rendered} {' '.join(str(arg) for arg in args)}"
            captured_messages.append(rendered)

        def error(self, message, *args, **kwargs):
            rendered = str(message)
            if args:
                try:
                    rendered = rendered.format(*args)
                except Exception:
                    rendered = f"{rendered} {' '.join(str(arg) for arg in args)}"
            captured_messages.append(rendered)

    monkeypatch.setattr(AI_MODULE, "logger", _CaptureLogger())

    analyzer = GeminiAnalyzer(api_key="super-secret-key")
    analyzer.analyze_meeting("hello world")

    assert all("super-secret-key" not in message for message in captured_messages)


def test_gemini_analyzer_passes_schema_and_output_budget(monkeypatch):
    fake_client = _FakeClient([_success_response()])
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = GeminiAnalyzer(
        api_key="test-gemini-key", analysis_max_output_tokens=1536
    )
    analyzer.analyze_meeting("hello world")

    assert len(fake_client.calls) == 1
    payload = fake_client.calls[0][1]["json"]
    generation_config = payload["generationConfig"]
    assert generation_config["maxOutputTokens"] == 1536
    assert generation_config["responseMimeType"] == "application/json"
    assert generation_config["thinkingConfig"]["thinkingBudget"] == 0
    assert "responseSchema" in generation_config
    schema_json = json.dumps(generation_config["responseSchema"])
    assert '"action_items"' in schema_json
    assert '"evidenceKeywords"' in schema_json
    assert '"evidenceQuote"' not in schema_json
    assert '"pending"' not in schema_json
    assert '"cancelled"' not in schema_json
    assert '"oneOf"' not in schema_json
    assert '"anyOf"' not in schema_json
    assert '"nullable"' not in schema_json
    assert '"additionalProperties"' not in schema_json
    assert '"minItems"' not in schema_json
    assert '"maxItems"' not in schema_json
    assert generation_config["responseSchema"]["type"] == "OBJECT"


def test_gemini_realtime_prompt_uses_compact_output_limits(monkeypatch):
    fake_client = _FakeClient([_success_response(summary="Realtime compact")])
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    result = analyzer._analyze_with_gemini(
        "Speaker 1: Can you summarize the deployment blockers?",
        metadata={"source": "realtime", "meetingId": 42},
    )

    assert result["summary"] == "Realtime compact"
    payload = fake_client.calls[0][1]["json"]
    prompt = payload["contents"][0]["parts"][0]["text"]
    assert "REALTIME_MODE" in prompt
    assert "keywords and technicalTerms max 5 each" in prompt
    assert "painPoints and action_items max 3 each" in prompt
    assert "evidenceKeywords" in prompt
    assert "evidenceQuote" in prompt
    assert "không tạo evidenceQuote" in prompt


def test_gemini_realtime_result_is_compacted(monkeypatch):
    long_text = "x" * 240
    response = _FakeResponse(
        200,
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "text": json.dumps(
                                    {
                                        "summary": long_text,
                                        "keywords": [
                                            "one",
                                            "two",
                                            "three",
                                            "four",
                                            "five",
                                            "six",
                                        ],
                                        "technicalTerms": [],
                                        "painPoints": [],
                                        "actionItems": [
                                            {"task": long_text, "evidence": long_text},
                                            {"task": "two"},
                                            {"task": "three"},
                                            {"task": "four"},
                                        ],
                                        "domainMode": "it",
                                    }
                                )
                            }
                        ]
                    }
                }
            ]
        },
    )
    monkeypatch.setattr(
        AI_MODULE.httpx, "Client", lambda timeout: _FakeClient(response)
    )

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    result = analyzer._analyze_with_gemini(
        "Speaker 1: deployment notes",
        metadata={"source": "realtime"},
    )

    assert result["keywords"] == ["one", "two", "three", "four", "five"]
    assert len(result["businessActionItems"]) == 3
    assert len(result["businessActionItems"][0]["task"]) <= 120
    assert len(result["businessActionItems"][0]["evidence"]) <= 100


def test_gemini_analyzer_schema_400_retries_once_without_schema(monkeypatch):
    fake_client = _FakeClient(
        [
            _FakeResponse(400, text='{"error":{"message":"invalid schema"}}'),
            _success_response(summary="Recovered without schema"),
        ]
    )
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] == "Recovered without schema"
    assert len(fake_client.calls) == 2
    first_payload = fake_client.calls[0][1]["json"]
    second_payload = fake_client.calls[1][1]["json"]
    assert "responseSchema" in first_payload["generationConfig"]
    assert "responseSchema" not in second_payload["generationConfig"]


def test_gemini_analyzer_max_tokens_retries_once_with_larger_budget_without_schema(
    monkeypatch,
):
    fake_client = _FakeClient(
        [
            _FakeResponse(
                200,
                {
                    "candidates": [
                        {
                            "finishReason": "MAX_TOKENS",
                            "content": {
                                "parts": [
                                    {
                                        "text": '{"summary":"rat ngan"}',
                                    }
                                ]
                            },
                        }
                    ]
                },
            ),
            _success_response(summary="Recovered after max tokens"),
        ]
    )
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = GeminiAnalyzer(
        api_key="test-gemini-key",
        analysis_max_output_tokens=1024,
    )
    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] == "Recovered after max tokens"
    assert len(fake_client.calls) == 2
    first_payload = fake_client.calls[0][1]["json"]
    second_payload = fake_client.calls[1][1]["json"]
    assert first_payload["generationConfig"]["maxOutputTokens"] == 1024
    assert "responseSchema" in first_payload["generationConfig"]
    assert second_payload["generationConfig"]["maxOutputTokens"] == 2048
    assert "responseSchema" not in second_payload["generationConfig"]


def test_gemini_analyzer_max_tokens_retries_with_8192_when_primary_budget_is_4096(
    monkeypatch,
):
    fake_client = _FakeClient(
        [
            _FakeResponse(
                200,
                {
                    "candidates": [
                        {
                            "finishReason": "MAX_TOKENS",
                            "content": {"parts": [{"text": '{"summary":"truncated"}'}]},
                        }
                    ],
                    "usageMetadata": {"candidatesTokenCount": 4084},
                },
            ),
            _success_response(summary="Recovered with larger budget"),
        ]
    )
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = GeminiAnalyzer(
        api_key="test-gemini-key",
        analysis_max_output_tokens=4096,
    )
    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] == "Recovered with larger budget"
    assert len(fake_client.calls) == 2
    second_payload = fake_client.calls[1][1]["json"]
    assert second_payload["generationConfig"]["maxOutputTokens"] == 8192
    assert "responseSchema" not in second_payload["generationConfig"]


def test_gemini_analyzer_max_tokens_retry_can_be_disabled(monkeypatch):
    fake_client = _FakeClient(
        [
            _FakeResponse(
                200,
                {
                    "candidates": [
                        {
                            "finishReason": "MAX_TOKENS",
                            "content": {"parts": [{"text": '{"summary":"too short"}'}]},
                        }
                    ],
                    "usageMetadata": {
                        "promptTokenCount": 10,
                        "candidatesTokenCount": 512,
                        "totalTokenCount": 522,
                    },
                },
            ),
            _success_response(summary="Should not be called"),
        ]
    )
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = GeminiAnalyzer(
        api_key="test-gemini-key",
        analysis_max_output_tokens=512,
        gemini_max_tokens_retry_enabled=False,
    )
    with pytest.raises(AnalysisUnavailableError):
        analyzer.analyze_meeting("hello world")

    assert len(fake_client.calls) == 1


def test_gemini_analyzer_schema_400_then_json_400_falls_back_safely(monkeypatch):
    fake_client = _FakeClient(
        [
            _FakeResponse(400, text='{"error":{"message":"invalid schema"}}'),
            _FakeResponse(400, text='{"error":{"message":"invalid request"}}'),
        ]
    )
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    transcript = "Speaker 1: Bàn về API gateway. Speaker 2: Cần cập nhật cấu hình."
    with pytest.raises(AnalysisUnavailableError):
        analyzer.analyze_meeting(transcript)

    assert len(fake_client.calls) == 2


def test_gemini_analyzer_logs_safe_http_error_preview(monkeypatch):
    transcript = ("token " * 200).strip()
    response_text = '{"error":{"message":"' + ("x" * 500) + '"}}'
    fake_client = _FakeClient([_FakeResponse(400, text=response_text)])
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    captured_messages = []

    class _CaptureLogger:
        def info(self, message, *args, **kwargs):
            rendered = str(message)
            if args:
                try:
                    rendered = rendered.format(*args)
                except Exception:
                    rendered = f"{rendered} {' '.join(str(arg) for arg in args)}"
            captured_messages.append(rendered)

        def warning(self, message, *args, **kwargs):
            rendered = str(message)
            if args:
                try:
                    rendered = rendered.format(*args)
                except Exception:
                    rendered = f"{rendered} {' '.join(str(arg) for arg in args)}"
            captured_messages.append(rendered)

        def error(self, message, *args, **kwargs):
            rendered = str(message)
            if args:
                try:
                    rendered = rendered.format(*args)
                except Exception:
                    rendered = f"{rendered} {' '.join(str(arg) for arg in args)}"
            captured_messages.append(rendered)

    capture_logger = _CaptureLogger()
    monkeypatch.setattr(AI_MODULE, "logger", capture_logger)
    monkeypatch.setattr(GEMINI_CLIENT_MODULE, "logger", capture_logger)

    analyzer = GeminiAnalyzer(api_key="super-secret-key")
    with pytest.raises(AnalysisUnavailableError):
        analyzer.analyze_meeting(transcript)

    http_error_logs = [
        message for message in captured_messages if "GEMINI_CALL_FAILED" in message
    ]
    assert http_error_logs
    assert "super-secret-key" not in "".join(captured_messages)
    assert transcript not in "".join(captured_messages)
    assert len(http_error_logs[0]) < 500


def test_gemini_analyzer_logs_response_meta(monkeypatch):
    response = _FakeResponse(
        200,
        {
            "candidates": [
                {
                    "finishReason": "STOP",
                    "content": {
                        "parts": [
                            {
                                "text": json.dumps(
                                    {
                                        "summary": "Safe",
                                        "keywords": [],
                                        "technicalTerms": [],
                                        "painPoints": [],
                                        "actionItems": [],
                                        "domainMode": "it",
                                    }
                                )
                            }
                        ]
                    },
                }
            ]
        },
    )
    monkeypatch.setattr(
        AI_MODULE.httpx, "Client", lambda timeout: _FakeClient(response)
    )

    captured_messages = []

    class _CaptureLogger:
        def info(self, message, *args, **kwargs):
            rendered = str(message)
            if args:
                try:
                    rendered = rendered.format(*args)
                except Exception:
                    rendered = f"{rendered} {' '.join(str(arg) for arg in args)}"
            captured_messages.append(rendered)

        def warning(self, message, *args, **kwargs):
            rendered = str(message)
            if args:
                try:
                    rendered = rendered.format(*args)
                except Exception:
                    rendered = f"{rendered} {' '.join(str(arg) for arg in args)}"
            captured_messages.append(rendered)

        def error(self, message, *args, **kwargs):
            rendered = str(message)
            if args:
                try:
                    rendered = rendered.format(*args)
                except Exception:
                    rendered = f"{rendered} {' '.join(str(arg) for arg in args)}"
            captured_messages.append(rendered)

    monkeypatch.setattr(AI_MODULE, "logger", _CaptureLogger())

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    analyzer.analyze_meeting("hello world")

    assert any(
        "GEMINI_ANALYSIS_RESPONSE_META" in message for message in captured_messages
    )
    assert any("finish_reason=STOP" in message for message in captured_messages)
    assert any("thinking_budget=0" in message for message in captured_messages)


def test_gemini_analyzer_missing_summary_does_not_log_response_parsed(monkeypatch):
    response = _FakeResponse(
        200,
        {
            "candidates": [
                {
                    "finishReason": "STOP",
                    "content": {
                        "parts": [
                            {
                                "text": json.dumps(
                                    {
                                        "keywords": ["api"],
                                        "technicalTerms": [],
                                        "painPoints": [],
                                        "actionItems": [],
                                        "domainMode": "it",
                                    }
                                )
                            }
                        ]
                    },
                }
            ]
        },
    )
    monkeypatch.setattr(
        AI_MODULE.httpx, "Client", lambda timeout: _FakeClient(response)
    )

    captured_messages = []

    class _CaptureLogger:
        def info(self, message, *args, **kwargs):
            rendered = str(message)
            if args:
                try:
                    rendered = rendered.format(*args)
                except Exception:
                    rendered = f"{rendered} {' '.join(str(arg) for arg in args)}"
            captured_messages.append(rendered)

        def warning(self, message, *args, **kwargs):
            rendered = str(message)
            if args:
                try:
                    rendered = rendered.format(*args)
                except Exception:
                    rendered = f"{rendered} {' '.join(str(arg) for arg in args)}"
            captured_messages.append(rendered)

        def error(self, message, *args, **kwargs):
            rendered = str(message)
            if args:
                try:
                    rendered = rendered.format(*args)
                except Exception:
                    rendered = f"{rendered} {' '.join(str(arg) for arg in args)}"
            captured_messages.append(rendered)

    monkeypatch.setattr(AI_MODULE, "logger", _CaptureLogger())

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")

    with pytest.raises(AI_MODULE.AnalysisParseError):
        analyzer.analyze_meeting("hello world")


def test_gemini_analyzer_max_tokens_does_not_log_response_parsed(monkeypatch):
    response = _FakeResponse(
        200,
        {
            "candidates": [
                {
                    "finishReason": "MAX_TOKENS",
                    "content": {
                        "parts": [
                            {
                                "text": '{"summary":"ngan"}',
                            }
                        ]
                    },
                }
            ]
        },
    )
    monkeypatch.setattr(
        AI_MODULE.httpx, "Client", lambda timeout: _FakeClient(response)
    )

    captured_messages = []

    class _CaptureLogger:
        def info(self, message, *args, **kwargs):
            rendered = str(message)
            if args:
                try:
                    rendered = rendered.format(*args)
                except Exception:
                    rendered = f"{rendered} {' '.join(str(arg) for arg in args)}"
            captured_messages.append(rendered)

        def warning(self, message, *args, **kwargs):
            rendered = str(message)
            if args:
                try:
                    rendered = rendered.format(*args)
                except Exception:
                    rendered = f"{rendered} {' '.join(str(arg) for arg in args)}"
            captured_messages.append(rendered)

        def error(self, message, *args, **kwargs):
            rendered = str(message)
            if args:
                try:
                    rendered = rendered.format(*args)
                except Exception:
                    rendered = f"{rendered} {' '.join(str(arg) for arg in args)}"
            captured_messages.append(rendered)

    monkeypatch.setattr(AI_MODULE, "logger", _CaptureLogger())

    analyzer = GeminiAnalyzer(
        api_key="test-gemini-key",
        analysis_max_output_tokens=4096,
    )
    with pytest.raises(AnalysisUnavailableError):
        analyzer.analyze_meeting("hello world")

    assert any(
        "GEMINI_ANALYSIS_INCOMPLETE reason=max_tokens" in m for m in captured_messages
    )
    assert not any("GEMINI_ANALYSIS_RESPONSE_PARSED" in m for m in captured_messages)


def test_gemini_analyzer_uses_single_request_below_threshold(monkeypatch):
    analyzer = GeminiAnalyzer(api_key="test-gemini-key")

    call_count = {"value": 0}

    def _fake_analyze(prompt, metadata=None):
        call_count["value"] += 1
        return {
            "summary": "short",
            "keywords": [],
            "technicalTerms": [],
            "painPoints": [],
            "actionItems": [],
            "domainMode": "it",
            "key_points": [],
            "decisions": [],
            "risks_blockers": [],
            "topics": [],
        }

    monkeypatch.setattr(analyzer, "_analyze_with_gemini", _fake_analyze)
    monkeypatch.setattr(analyzer, "_summarize_chunk_with_gemini", pytest.fail)

    transcript = (
        "token1 token2 token3 token4 token5 token6 token7 token8 token9 token10"
    )
    result = analyzer.analyze_meeting(transcript)

    assert result["summary"] == "short"
    assert call_count["value"] == 1


def test_gemini_analyzer_truncates_long_transcripts_before_single_analysis(monkeypatch):
    analyzer = GeminiAnalyzer(
        api_key="test-gemini-key",
        analysis_max_input_tokens=5,
    )

    prompts: list[str] = []

    def _fake_analyze(prompt, metadata=None):
        prompts.append(prompt)
        return {
            "summary": "long",
            "keywords": [],
            "technicalTerms": [],
            "painPoints": [],
            "actionItems": [],
            "domainMode": "it",
            "key_points": [],
            "decisions": [],
            "risks_blockers": [],
            "topics": [],
        }

    monkeypatch.setattr(analyzer, "_analyze_with_gemini", _fake_analyze)

    transcript = "token1 token2 token3 token4 token5 token6 token7 token8"
    result = analyzer.analyze_meeting(transcript)

    assert result["summary"] == "long"
    assert len(prompts) == 1
    assert "token1" in prompts[0]
    assert "token6" not in prompts[0]


def test_gemini_client_maps_region_block_to_clear_error():
    fake_client = _FakeClient(
        [
            _FakeResponse(
                400,
                text='{"error":{"status":"FAILED_PRECONDITION","message":"User location is not supported for the API use."}}',
            )
        ]
    )
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="primary-key",
        gemini_api_keys="",
        multi_key_enabled=False,
    )
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=1,
        http_client_factory=lambda timeout: fake_client,
        sleep=lambda seconds: None,
    )

    with pytest.raises(AnalysisUnavailableError) as exc_info:
        client.post_json(
            url="https://example.test/gemini",
            payload={"contents": []},
            timeout_seconds=30,
        )

    assert exc_info.value.error_code == "GEMINI_REGION_BLOCKED"
    assert "GEMINI_HTTP_PROXY" in str(exc_info.value)


def test_resolve_http_client_factory_wraps_proxy():
    captured: dict[str, object] = {}

    def base_factory(**kwargs):
        captured.update(kwargs)
        return object()

    factory, proxy = GEMINI_CLIENT_MODULE.resolve_http_client_factory(
        proxy="http://proxy.test:7890",
        base_factory=base_factory,
    )
    factory(timeout=12)

    assert proxy == "http://proxy.test:7890"
    assert captured["proxies"] == "http://proxy.test:7890"
    assert captured["timeout"] == 12


def test_normalize_gemini_proxy_url_resolves_host_docker_internal(monkeypatch):
    monkeypatch.setattr(
        GEMINI_CLIENT_MODULE.socket,
        "gethostbyname",
        lambda host: "192.168.65.254",
    )

    normalized = GEMINI_CLIENT_MODULE._normalize_gemini_proxy_url(
        "http://host.docker.internal:7890"
    )

    assert normalized == "http://192.168.65.254:7890"


def test_max_tokens_retry_sticks_to_key_that_returned_http_200(monkeypatch):
    """Regression: MAX_TOKENS must not round-robin away from the successful key."""
    fake_client = _FakeClient(
        [
            # primary depleted
            _FakeResponse(
                429,
                text='{"error":{"status":"RESOURCE_EXHAUSTED","message":"prepaid credits are depleted"}}',
                headers={"Retry-After": "1"},
            ),
            # backup1 succeeds HTTP but MAX_TOKENS
            _FakeResponse(
                200,
                {
                    "candidates": [
                        {
                            "finishReason": "MAX_TOKENS",
                            "content": {"parts": [{"text": '{"summary":"truncated"}'}]},
                        }
                    ],
                    "usageMetadata": {
                        "promptTokenCount": 5832,
                        "candidatesTokenCount": 4084,
                        "totalTokenCount": 9916,
                    },
                },
            ),
            # sticky retry on backup1 must succeed (not backup2 404)
            _success_response(summary="Recovered on sticky backup1"),
            # Would be wrong if round-robin advanced to backup2
            _FakeResponse(
                404,
                text=(
                    '{"error":{"status":"NOT_FOUND","message":'
                    '"This model models/gemini-2.5-flash is no longer available to new users"}}'
                ),
            ),
        ]
    )
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = _analyzer_with_multi_key(
        analysis_max_output_tokens=4096,
        gemini_max_attempts=3,
        gemini_key_cooldown_seconds=30,
        gemini_backoff_base_ms=0,
    )
    result = analyzer.analyze_meeting("Speaker 1: sticky key transcript")

    assert result["summary"] == "Recovered on sticky backup1"
    keys = _request_keys(fake_client)
    assert keys[0] == "key-a"
    assert keys[1] == "key-b"
    assert keys[2] == "key-b"
    assert "key-c" not in keys


def test_gemini_client_model_404_fails_over_to_next_key():
    fake_client = _FakeClient(
        [
            _FakeResponse(
                404,
                text=(
                    '{"error":{"status":"NOT_FOUND","message":'
                    '"This model models/gemini-2.5-flash is no longer available to new users"}}'
                ),
            ),
            _success_response("From backup key"),
        ]
    )
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
    )
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=3,
        key_cooldown_seconds=30,
        backoff_base_ms=0,
        http_client_factory=lambda timeout: fake_client,
        sleep=lambda seconds: None,
    )

    result = client.post_json(
        url="https://example.test/gemini",
        payload={"contents": []},
        timeout_seconds=30,
    )

    assert result.key_alias == "backup1"
    assert result.response.status_code == 200
    assert _request_keys(fake_client) == ["key-a", "key-b"]


def test_gemini_client_all_keys_model_404_raises_model_unavailable():
    unavailable = _FakeResponse(
        404,
        text=(
            '{"error":{"status":"NOT_FOUND","message":'
            '"This model models/gemini-2.5-flash is no longer available to new users"}}'
        ),
    )
    fake_client = _FakeClient([unavailable, unavailable, unavailable])
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b,backup2:key-c",
        multi_key_enabled=True,
    )
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=3,
        key_cooldown_seconds=30,
        backoff_base_ms=0,
        http_client_factory=lambda timeout: fake_client,
        sleep=lambda seconds: None,
    )

    with pytest.raises(AnalysisUnavailableError) as exc_info:
        client.post_json(
            url="https://example.test/gemini",
            payload={"contents": []},
            timeout_seconds=30,
        )

    assert exc_info.value.error_code == "GEMINI_MODEL_UNAVAILABLE"
    assert len(fake_client.calls) == 3


def test_gemini_client_preferred_key_alias_reused_without_round_robin():
    fake_client = _FakeClient([_success_response("sticky")])
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b,backup2:key-c",
        multi_key_enabled=True,
    )
    # Advance RR so next default would be backup1
    assert key_manager.select_key().entry.alias == "primary"
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=1,
        http_client_factory=lambda timeout: fake_client,
        sleep=lambda seconds: None,
    )

    result = client.post_json(
        url="https://example.test/gemini",
        payload={"contents": []},
        timeout_seconds=30,
        preferred_key_alias="primary",
    )

    assert result.key_alias == "primary"
    assert _request_keys(fake_client) == ["key-a"]


_MODEL_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.5-flash:generateContent"
)


def _model_unavailable_404() -> _FakeResponse:
    return _FakeResponse(
        404,
        text=(
            '{"error":{"status":"NOT_FOUND","message":'
            '"This model models/gemini-2.5-flash is no longer available to new users"}}'
        ),
    )


def test_is_model_unavailable_response_requires_model_markers():
    assert GEMINI_CLIENT_MODULE.is_model_unavailable_response(
        _model_unavailable_404()
    )
    assert not GEMINI_CLIENT_MODULE.is_model_unavailable_response(
        _FakeResponse(404, text='{"error":{"status":"NOT_FOUND","message":"Not Found"}}')
    )
    assert not GEMINI_CLIENT_MODULE.is_model_unavailable_response(
        _FakeResponse(404, text="")
    )
    assert not GEMINI_CLIENT_MODULE.is_model_unavailable_response(
        _FakeResponse(
            404,
            text='{"error":{"status":"NOT_FOUND","message":"Endpoint /v1/foo not found"}}',
        )
    )


def test_mixed_rate_limit_and_model_unavailable_returns_key_pool_unavailable():
    fake_client = _FakeClient(
        [
            _FakeResponse(
                429,
                text='{"error":{"status":"RESOURCE_EXHAUSTED","message":"Rate limit exceeded (RPM)"}}',
                headers={"Retry-After": "1"},
            ),
            _model_unavailable_404(),
            _model_unavailable_404(),
        ]
    )
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b,backup2:key-c",
        multi_key_enabled=True,
    )
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=3,
        key_cooldown_seconds=30,
        backoff_base_ms=0,
        http_client_factory=lambda timeout: fake_client,
        sleep=lambda seconds: None,
    )

    with pytest.raises(AnalysisUnavailableError) as exc_info:
        client.post_json(
            url=_MODEL_URL,
            payload={"contents": []},
            timeout_seconds=30,
            model="gemini-2.5-flash",
        )

    assert exc_info.value.error_code == "GEMINI_KEY_POOL_UNAVAILABLE"
    assert exc_info.value.error_code != "GEMINI_RATE_LIMITED"


def test_billing_credits_depleted_uses_hard_cooldown_not_soft_90s():
    clock = KEY_MANAGER_MODULE.time.monotonic
    # Use FakeClock from key manager tests pattern via simple mutable clock
    class Clock:
        def __init__(self):
            self.now = 1000.0

        def __call__(self):
            return self.now

    clock = Clock()
    fake_client = _FakeClient(
        [
            _FakeResponse(
                429,
                text=(
                    '{"error":{"status":"RESOURCE_EXHAUSTED","message":'
                    '"Your prepayment credits are depleted"}}'
                ),
            ),
            _success_response("backup ok"),
        ]
    )
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
        clock=clock,
    )
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=3,
        key_cooldown_seconds=90,
        key_hard_cooldown_seconds=900,
        backoff_base_ms=0,
        http_client_factory=lambda timeout: fake_client,
        sleep=lambda seconds: None,
        clock=clock,
    )

    result = client.post_json(
        url=_MODEL_URL,
        payload={"contents": []},
        timeout_seconds=30,
        model="gemini-2.5-flash",
    )
    assert result.key_alias == "backup1"

    # Soft 90s would have expired; billing must keep primary hard-cooled.
    clock.now += 91
    assert key_manager.select_key(model="gemini-2.5-flash").entry.alias == "backup1"


def test_all_keys_billing_depleted_returns_billing_error_code():
    depleted = _FakeResponse(
        429,
        text=(
            '{"error":{"status":"RESOURCE_EXHAUSTED","message":'
            '"prepaid credits depleted"}}'
        ),
    )
    fake_client = _FakeClient([depleted, depleted, depleted])
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b,backup2:key-c",
        multi_key_enabled=True,
    )
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=3,
        key_hard_cooldown_seconds=900,
        backoff_base_ms=0,
        http_client_factory=lambda timeout: fake_client,
        sleep=lambda seconds: None,
    )

    with pytest.raises(AnalysisUnavailableError) as exc_info:
        client.post_json(
            url=_MODEL_URL,
            payload={"contents": []},
            timeout_seconds=30,
            model="gemini-2.5-flash",
        )

    assert exc_info.value.error_code == "GEMINI_BILLING_CREDITS_DEPLETED"


def test_free_tier_token_quota_classified_and_hard_cooled():
    free_tier = _FakeResponse(
        429,
        text=(
            '{"error":{"status":"RESOURCE_EXHAUSTED","message":'
            '"Quota exceeded for generate_content_free_tier_input_token_count",'
            '"details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure",'
            '"violations":[{"quotaMetric":'
            '"generativelanguage.googleapis.com/generate_content_free_tier_input_token_count"}]}]}}'
        ),
    )
    fake_client = _FakeClient([free_tier, _success_response("ok")])
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
    )
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=3,
        key_hard_cooldown_seconds=900,
        backoff_base_ms=0,
        http_client_factory=lambda timeout: fake_client,
        sleep=lambda seconds: None,
    )

    result = client.post_json(
        url=_MODEL_URL,
        payload={"contents": []},
        timeout_seconds=30,
        model="gemini-2.5-flash",
    )
    assert result.key_alias == "backup1"
    reason = GEMINI_CLIENT_MODULE.classify_http_429(free_tier)
    assert (
        reason
        == GEMINI_CLIENT_MODULE.GeminiKeyFailureReason.FREE_TIER_TOKEN_QUOTA_EXHAUSTED
    )


def test_transient_rpm_still_maps_to_rate_limited():
    rpm = _FakeResponse(
        429,
        text='{"error":{"status":"RESOURCE_EXHAUSTED","message":"Resource exhausted: RPM"}}',
        headers={"Retry-After": "5"},
    )
    fake_client = _FakeClient([rpm, rpm, rpm])
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b,backup2:key-c",
        multi_key_enabled=True,
    )
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=3,
        key_cooldown_seconds=30,
        backoff_base_ms=0,
        http_client_factory=lambda timeout: fake_client,
        sleep=lambda seconds: None,
    )

    with pytest.raises(AnalysisRateLimitError) as exc_info:
        client.post_json(
            url=_MODEL_URL,
            payload={"contents": []},
            timeout_seconds=30,
            model="gemini-2.5-flash",
        )

    assert exc_info.value.error_code == "GEMINI_RATE_LIMITED"


def test_generic_404_is_not_model_unavailable_and_does_not_failover():
    fake_client = _FakeClient(
        [
            _FakeResponse(
                404,
                text='{"error":{"status":"NOT_FOUND","message":"Not Found"}}',
            ),
            _success_response("should-not-be-used"),
        ]
    )
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
    )
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=3,
        backoff_base_ms=0,
        http_client_factory=lambda timeout: fake_client,
        sleep=lambda seconds: None,
    )

    with pytest.raises(AnalysisUnavailableError) as exc_info:
        client.post_json(
            url=_MODEL_URL,
            payload={"contents": []},
            timeout_seconds=30,
            model="gemini-2.5-flash",
        )

    assert exc_info.value.error_code == "GEMINI_UNAVAILABLE"
    assert len(fake_client.calls) == 1


def test_model_404_failover_then_success_with_model_cache():
    fake_client = _FakeClient(
        [
            _FakeResponse(
                429,
                text='{"error":{"message":"Rate limit exceeded"}}',
                headers={"Retry-After": "1"},
            ),
            _model_unavailable_404(),
            _success_response("From backup2"),
        ]
    )
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b,backup2:key-c",
        multi_key_enabled=True,
    )
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=3,
        key_cooldown_seconds=30,
        backoff_base_ms=0,
        http_client_factory=lambda timeout: fake_client,
        sleep=lambda seconds: None,
    )

    result = client.post_json(
        url=_MODEL_URL,
        payload={"contents": []},
        timeout_seconds=30,
        model="gemini-2.5-flash",
    )

    assert result.key_alias == "backup2"
    assert key_manager.is_model_unsupported("backup1", "gemini-2.5-flash")
    # Same key still usable for another model.
    assert not key_manager.is_model_unsupported("backup1", "gemini-2.0-flash")


def test_max_tokens_retry_does_not_exceed_configured_maximum(monkeypatch):
    fake_client = _FakeClient(
        [
            _FakeResponse(
                200,
                {
                    "candidates": [
                        {
                            "finishReason": "MAX_TOKENS",
                            "content": {"parts": [{"text": '{"summary":"truncated"}'}]},
                        }
                    ],
                    "usageMetadata": {"candidatesTokenCount": 8192},
                },
            ),
            _success_response(summary="Still capped"),
        ]
    )
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)
    analyzer = GeminiAnalyzer(
        api_key="key-a",
        analysis_model="gemini-2.5-flash",
        analysis_max_output_tokens=8192,
        gemini_max_attempts=2,
        gemini_backoff_base_ms=0,
        gemini_key_cooldown_seconds=30,
    )
    result = analyzer.analyze_meeting("Speaker 1: capped retry")
    assert result["summary"] == "Still capped"
    # Both calls stay at configured maximum (8192), never unbounded growth.
    budgets = [
        call[1]["json"]["generationConfig"]["maxOutputTokens"]
        for call in fake_client.calls
    ]
    assert budgets[0] == 8192
    assert budgets[1] == 8192
    assert max(budgets) <= 8192


def test_embedding_index_uses_get_settings_not_missing_settings_export(monkeypatch):
    """Regression: tasks must not `from app.config import settings`."""
    import app.config as config_mod
    import app.tasks as tasks_mod

    assert not hasattr(config_mod, "settings")
    # Import path used by process_meeting embedding block must resolve.
    from app.config import get_settings
    from app.services.embedding_service import index_meeting_for_search

    settings = get_settings()
    monkeypatch.setenv("EMBEDDING_SEARCH_ENABLED", "false")
    # Optional skip must not raise when embeddings are disabled.
    index_meeting_for_search(
        settings=settings,
        meeting_id=1,
        user_id=1,
        title="t",
        summary="s",
    )
    source = Path(tasks_mod.__file__).read_text(encoding="utf-8")
    assert "from app.config import settings" not in source
    assert "from app.config import get_settings" in source


def test_cached_unsupported_all_keys_raises_model_unavailable_without_http():
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b,backup2:key-c",
        multi_key_enabled=True,
    )
    for alias in ("primary", "backup1", "backup2"):
        key_manager.mark_model_unsupported(alias, "gemini-2.5-flash")

    fake_client = _FakeClient([_success_response("should-not-call")])
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=3,
        backoff_base_ms=0,
        http_client_factory=lambda timeout: fake_client,
        sleep=lambda seconds: None,
    )

    with pytest.raises(AnalysisUnavailableError) as exc_info:
        client.post_json(
            url=_MODEL_URL,
            payload={"contents": []},
            timeout_seconds=30,
            model="gemini-2.5-flash",
        )

    assert exc_info.value.error_code == "GEMINI_MODEL_UNAVAILABLE"
    assert exc_info.value.retryable is False
    assert len(fake_client.calls) == 0


def test_cached_unsupported_model_a_still_allows_model_b():
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
    )
    key_manager.mark_model_unsupported("primary", "gemini-2.5-flash")
    key_manager.mark_model_unsupported("backup1", "gemini-2.5-flash")

    fake_client = _FakeClient([_success_response("model-b-ok")])
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=1,
        backoff_base_ms=0,
        http_client_factory=lambda timeout: fake_client,
        sleep=lambda seconds: None,
    )

    result = client.post_json(
        url=(
            "https://generativelanguage.googleapis.com/v1beta/models/"
            "gemini-2.0-flash:generateContent"
        ),
        payload={"contents": []},
        timeout_seconds=30,
        model="gemini-2.0-flash",
    )
    assert result.response.status_code == 200
    assert len(fake_client.calls) == 1


def test_all_terminal_mixed_key_pool_is_not_retryable():
    failures = {
        "primary": GEMINI_CLIENT_MODULE.GeminiKeyFailureReason.BILLING_CREDITS_DEPLETED,
        "backup1": GEMINI_CLIENT_MODULE.GeminiKeyFailureReason.MODEL_UNAVAILABLE,
    }
    error = GEMINI_CLIENT_MODULE.conclude_key_pool_failure(failures)
    assert error.error_code == "GEMINI_KEY_POOL_UNAVAILABLE"
    assert error.retryable is False


def test_analysis_unavailable_error_pickle_roundtrip():
    import pickle

    original = AnalysisUnavailableError(
        "Gemini model is unavailable for all configured API keys",
        provider="gemini",
        error_code="GEMINI_MODEL_UNAVAILABLE",
        retryable=False,
        key_alias="primary",
    )
    restored = pickle.loads(pickle.dumps(original))
    assert isinstance(restored, AnalysisUnavailableError)
    assert restored.error_code == "GEMINI_MODEL_UNAVAILABLE"
    assert restored.retryable is False
    assert restored.provider == "gemini"
    assert str(restored) == str(original)


def test_process_meeting_records_provider_error_without_reraising(monkeypatch):
    """Terminal Gemini errors mark job FAILED and keep the Celery worker healthy."""
    import app.tasks as tasks_mod

    recorded = {}

    class FakePipeline:
        def process_meeting(self, **kwargs):
            raise AnalysisUnavailableError(
                "Gemini model is unavailable for all configured API keys",
                provider="gemini",
                error_code="GEMINI_MODEL_UNAVAILABLE",
                retryable=False,
            )

    class FakeSession:
        def close(self):
            return None

    monkeypatch.setattr(tasks_mod, "pipeline", FakePipeline())
    monkeypatch.setattr(tasks_mod, "SessionLocal", lambda: FakeSession())

    def fake_set_job_status(meeting_id, status, **kwargs):
        recorded["meeting_id"] = meeting_id
        recorded["status"] = status
        recorded["error"] = kwargs.get("error")

    monkeypatch.setattr(tasks_mod, "set_job_status", fake_set_job_status)

    tasks_mod.process_meeting(
        {
            "meeting_id": 88,
            "audio_path": "/tmp/x.wav",
            "trace_id": "t-88",
            "file_id": "f-88",
        }
    )

    assert recorded["status"] == "FAILED"
    assert "GEMINI_MODEL_UNAVAILABLE" in str(recorded["error"])


def test_vps_exact_primary_429_backup1_200_two_keys():
    """VPS pool shape: primary + backup1 only."""
    billing_429 = _FakeResponse(
        429,
        text=(
            '{"error":{"status":"RESOURCE_EXHAUSTED","message":'
            '"Your prepayment credits are depleted"}}'
        ),
    )
    fake_client = _FakeClient([billing_429, _success_response("vps-backup1-ok")])
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
    )
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=3,
        key_hard_cooldown_seconds=900,
        backoff_base_ms=0,
        fail_fast_seconds=30,
        http_client_factory=lambda timeout: fake_client,
        sleep=lambda seconds: None,
    )

    result = client.post_json(
        url=_MODEL_URL,
        payload={"contents": []},
        timeout_seconds=30,
        model="gemini-2.5-flash",
    )

    assert result.key_alias == "backup1"
    assert result.response.status_code == 200
    assert _request_keys(fake_client) == ["key-a", "key-b"]


def test_local_three_key_primary_429_backup1_200_skips_backup2():
    billing_429 = _FakeResponse(
        429,
        text=(
            '{"error":{"status":"RESOURCE_EXHAUSTED","message":'
            '"Your prepayment credits are depleted"}}'
        ),
    )
    fake_client = _FakeClient(
        [
            billing_429,
            _success_response("local-backup1-ok"),
            _success_response("should-not-call-backup2"),
        ]
    )
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b,backup2:key-c",
        multi_key_enabled=True,
    )
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=2,
        key_hard_cooldown_seconds=900,
        backoff_base_ms=0,
        fail_fast_seconds=30,
        http_client_factory=lambda timeout: fake_client,
        sleep=lambda seconds: None,
    )

    result = client.post_json(
        url=_MODEL_URL,
        payload={"contents": []},
        timeout_seconds=30,
        model="gemini-2.5-flash",
    )

    assert result.key_alias == "backup1"
    assert _request_keys(fake_client) == ["key-a", "key-b"]
    assert "key-c" not in _request_keys(fake_client)


def test_backup2_model_unsupported_does_not_block_backup1_success():
    billing_429 = _FakeResponse(
        429,
        text=(
            '{"error":{"status":"RESOURCE_EXHAUSTED","message":'
            '"Your prepayment credits are depleted"}}'
        ),
    )
    fake_client = _FakeClient([billing_429, _success_response("backup1-wins")])
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b,backup2:key-c",
        multi_key_enabled=True,
    )
    key_manager.mark_model_unsupported("backup2", "gemini-2.5-flash")
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=3,
        key_hard_cooldown_seconds=900,
        backoff_base_ms=0,
        http_client_factory=lambda timeout: fake_client,
        sleep=lambda seconds: None,
    )

    result = client.post_json(
        url=_MODEL_URL,
        payload={"contents": []},
        timeout_seconds=30,
        model="gemini-2.5-flash",
    )

    assert result.key_alias == "backup1"
    assert _request_keys(fake_client) == ["key-a", "key-b"]


def test_backup1_success_beats_prior_primary_failure_no_pool_error():
    fake_client = _FakeClient(
        [
            _FakeResponse(
                429,
                text='{"error":{"message":"Rate limit exceeded (RPM)"}}',
                headers={"Retry-After": "1"},
            ),
            _success_response("ok"),
        ]
    )
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
    )
    client = GEMINI_CLIENT_MODULE.GeminiClient(
        key_manager,
        max_attempts=3,
        key_cooldown_seconds=30,
        backoff_base_ms=0,
        http_client_factory=lambda timeout: fake_client,
        sleep=lambda seconds: None,
    )

    result = client.post_json(
        url=_MODEL_URL,
        payload={"contents": []},
        timeout_seconds=30,
        model="gemini-2.5-flash",
    )
    assert result.key_alias == "backup1"
    # Must not raise GEMINI_KEY_POOL_UNAVAILABLE after a successful backup1 call.


def test_cooldown_expiry_allows_backup1_again():
    class Clock:
        def __init__(self):
            self.now = 1000.0

        def __call__(self):
            return self.now

    clock = Clock()
    key_manager = KEY_MANAGER_MODULE.GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
        clock=clock,
    )
    key_manager.cooldown_key("backup1", seconds=30, reason="rate_limit")
    assert key_manager.select_key(model="gemini-2.5-flash").entry.alias == "primary"
    clock.now += 31
    assert key_manager.has_eligible_key("gemini-2.5-flash")
    # After expiry, round-robin can pick backup1 again.
    aliases = {
        key_manager.select_key(model="gemini-2.5-flash").entry.alias for _ in range(4)
    }
    assert "backup1" in aliases
