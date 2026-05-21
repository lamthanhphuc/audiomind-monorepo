import importlib
import importlib.util
import json
from pathlib import Path

import pytest

MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "app" / "services" / "gemini_analyzer.py"
)
SPEC = importlib.util.spec_from_file_location("gemini_analyzer", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
GeminiAnalyzer = MODULE.GeminiAnalyzer
AI_MODULE = importlib.import_module("app.services.ai_analyzer")


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
                                        "key_points": ["API", "deployment"],
                                        "decisions": ["Dung Gemini"],
                                        "action_items": [
                                            {
                                                "task": "Cap nhat env",
                                                "owner": None,
                                                "deadline": None,
                                            }
                                        ],
                                        "risks_blockers": ["Thieu API key"],
                                        "topics": ["analysis"],
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

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] == "Tong hop cuoc hop"
    assert result["key_points"] == ["API", "deployment"]
    assert result["decisions"] == ["Dung Gemini"]
    assert result["action_items"][0]["task"] == "Cap nhat env"
    assert result["risks_blockers"] == ["Thieu API key"]
    assert result["topics"] == ["analysis"]


def test_gemini_analyzer_uses_api_key_header(monkeypatch):
    fake_client = _FakeClient([_success_response()])
    monkeypatch.setattr(AI_MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
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

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
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

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")

    with pytest.raises(AI_MODULE.AnalysisUnavailableError):
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

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] == "Recovered from rate limit"
    assert len(fake_client.calls) == 2
    assert sleep_calls == [30]


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

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] == "Recovered after longer backoff"
    assert len(fake_client.calls) == 4
    assert sleep_calls == [30, 60, 90]


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
                                        "key_points": ["A", "A"],
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
    assert result["decisions"] == []
    assert result["action_items"] == []
    assert result["risks_blockers"] == []
    assert result["topics"] == []


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

    with pytest.raises(MODULE.AnalysisParseError):
        analyzer.analyze_meeting("hello world")


def test_gemini_analyzer_requires_api_key():
    analyzer = GeminiAnalyzer(api_key="")

    with pytest.raises(MODULE.AnalysisConfigError):
        analyzer.analyze_meeting("hello world")


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
            captured_messages.append(str(message))

        def warning(self, message, *args, **kwargs):
            captured_messages.append(str(message))

        def error(self, message, *args, **kwargs):
            captured_messages.append(str(message))

    monkeypatch.setattr(MODULE, "logger", _CaptureLogger())

    analyzer = GeminiAnalyzer(api_key="super-secret-key")
    analyzer.analyze_meeting("hello world")

    assert all("super-secret-key" not in message for message in captured_messages)


def test_gemini_analyzer_uses_single_request_below_threshold(monkeypatch):
    analyzer = GeminiAnalyzer(api_key="test-gemini-key")

    call_count = {"value": 0}

    def _fake_analyze(prompt, metadata=None):
        call_count["value"] += 1
        return {
            "summary": "short",
            "key_points": [],
            "decisions": [],
            "action_items": [],
            "risks_blockers": [],
            "topics": [],
        }

    monkeypatch.setattr(analyzer, "_analyze_with_gemini", _fake_analyze)
    monkeypatch.setattr(analyzer, "_summarize_chunk_with_gemini", pytest.fail)

    transcript = "a" * 15890
    result = analyzer.analyze_meeting(transcript)

    assert result["summary"] == "short"
    assert call_count["value"] == 1


def test_gemini_analyzer_splits_only_for_long_transcripts(monkeypatch):
    analyzer = GeminiAnalyzer(
        api_key="test-gemini-key",
        gemini_max_single_request_chars=100,
        gemini_request_delay_seconds=0,
    )

    summarize_calls = []
    analyze_calls = []

    def _fake_summarize(chunk, metadata=None):
        summarize_calls.append(chunk)
        return f"summary-{len(summarize_calls)}"

    def _fake_analyze(prompt, metadata=None):
        analyze_calls.append(prompt)
        return {
            "summary": "long",
            "key_points": [],
            "decisions": [],
            "action_items": [],
            "risks_blockers": [],
            "topics": [],
        }

    monkeypatch.setattr(analyzer, "_summarize_chunk_with_gemini", _fake_summarize)
    monkeypatch.setattr(analyzer, "_analyze_with_gemini", _fake_analyze)

    transcript = "line one\n" + ("x" * 80 + "\n") * 40
    result = analyzer.analyze_meeting(transcript)

    assert result["summary"] == "long"
    assert len(summarize_calls) > 1
    assert len(analyze_calls) == 1
