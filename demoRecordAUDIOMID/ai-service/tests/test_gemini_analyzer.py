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
    fake_client = _FakeClient([response])
    monkeypatch.setattr(MODULE.httpx, "Client", lambda timeout: fake_client)

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] == "Tong hop cuoc hop"
    assert result["keywords"] == ["deployment"]
    assert result["technicalTerms"][0]["term"] == "API"
    assert result["painPoints"][0]["severity"] == "high"
    assert result["actionItems"] == ["Cap nhat env"]
    assert result["domainMode"] == "it"
    assert result["key_points"] == ["deployment"]
    assert result["risks_blockers"] == ["Thieu API key"]
    assert result["promptVersion"] == AI_MODULE.AIAnalyzer.PROMPT_VERSION
    assert result["schemaVersion"] == AI_MODULE.AIAnalyzer.SCHEMA_VERSION


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

    result = analyzer.analyze_meeting("hello world")

    assert len(fake_client.calls) == 3
    assert sleep_calls == [2, 4]
    assert result["summary"] != "hello world"
    assert "hello world" in result["summary"]
    assert result["keywords"] == []
    assert result["actionItems"] == []


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

    analyzer = GeminiAnalyzer(api_key="test-gemini-key", analysis_retry_max_attempts=4)
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
    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] != "hello world"
    assert "hello world" in result["summary"]
    assert result["keywords"] == []
    assert result["technicalTerms"] == []
    assert result["painPoints"] == []
    assert result["actionItems"] == []
    assert result["domainMode"] == "it"


def test_gemini_analyzer_requires_api_key():
    analyzer = GeminiAnalyzer(api_key="")

    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] != "hello world"
    assert "hello world" in result["summary"]
    assert result["keywords"] == []
    assert result["technicalTerms"] == []
    assert result["painPoints"] == []
    assert result["actionItems"] == []
    assert result["domainMode"] == "it"


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
    assert '"oneOf"' not in schema_json
    assert '"anyOf"' not in schema_json
    assert '"nullable"' not in schema_json
    assert '"additionalProperties"' not in schema_json
    assert '"minItems"' not in schema_json
    assert '"maxItems"' not in schema_json
    assert generation_config["responseSchema"]["type"] == "OBJECT"


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
    result = analyzer.analyze_meeting(transcript)

    assert len(fake_client.calls) == 2
    assert result["summary"] != transcript
    assert len(result["summary"]) <= 240
    assert result["keywords"] == []
    assert result["technicalTerms"] == []
    assert result["painPoints"] == []
    assert result["actionItems"] == []


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

    monkeypatch.setattr(AI_MODULE, "logger", _CaptureLogger())

    analyzer = GeminiAnalyzer(api_key="super-secret-key")
    analyzer.analyze_meeting(transcript)

    http_error_logs = [
        message
        for message in captured_messages
        if "GEMINI_ANALYSIS_HTTP_ERROR" in message
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
    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] != ""
    assert any(
        "GEMINI_ANALYSIS_FALLBACK reason=missing_summary" in m
        for m in captured_messages
    )
    assert not any("GEMINI_ANALYSIS_RESPONSE_PARSED" in m for m in captured_messages)


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
