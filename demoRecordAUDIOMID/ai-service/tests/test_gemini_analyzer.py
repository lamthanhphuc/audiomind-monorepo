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


class _FakeResponse:
    def __init__(self, status_code: int, body: dict | None = None, text: str = ""):
        self.status_code = status_code
        self._body = body or {}
        self._text = text

    def json(self):
        if self._body:
            return self._body
        return json.loads(self._text)


class _FakeClient:
    def __init__(self, response: _FakeResponse):
        self.response = response

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def post(self, *args, **kwargs):
        return self.response


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
    monkeypatch.setattr(MODULE.httpx, "Client", lambda timeout: _FakeClient(response))

    analyzer = GeminiAnalyzer(api_key="test-gemini-key")
    result = analyzer.analyze_meeting("hello world")

    assert result["summary"] == "Tong hop cuoc hop"
    assert result["key_points"] == ["API", "deployment"]
    assert result["decisions"] == ["Dung Gemini"]
    assert result["action_items"][0]["task"] == "Cap nhat env"
    assert result["risks_blockers"] == ["Thieu API key"]
    assert result["topics"] == ["analysis"]


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
    monkeypatch.setattr(MODULE.httpx, "Client", lambda timeout: _FakeClient(response))

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
    monkeypatch.setattr(MODULE.httpx, "Client", lambda timeout: _FakeClient(response))

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
    monkeypatch.setattr(MODULE.httpx, "Client", lambda timeout: _FakeClient(response))

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
