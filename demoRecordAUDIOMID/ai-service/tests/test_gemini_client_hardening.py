"""Client retry and proxy logging safety tests."""

from __future__ import annotations

import httpx
import pytest

from app.services.gemini_client import (
    GeminiClient,
    SafeProxyContext,
    _is_invalid_api_key_response,
    _sanitize_proxy_for_log,
    build_gemini_request_headers,
)
from app.services.gemini_key_manager import GeminiKeyManager


def test_sanitize_proxy_for_log_strips_credentials() -> None:
    assert _sanitize_proxy_for_log("http://user:secret@proxy.local:7890") == (
        "http://***@proxy.local:7890"
    )
    assert _sanitize_proxy_for_log("http://proxy.local:7890") == (
        "http://proxy.local:7890"
    )


def test_safe_proxy_context_log_label() -> None:
    ctx = SafeProxyContext("http://admin:pass@127.0.0.1:8080")
    assert "pass" not in ctx.log_label
    assert "admin" not in ctx.log_label
    assert "127.0.0.1" in ctx.log_label


def test_is_invalid_api_key_response_detects_ai_studio_400() -> None:
    class Response:
        status_code = 400

        def json(self):
            return {
                "error": {
                    "status": "INVALID_ARGUMENT",
                    "message": "API key not valid. Please pass a valid API key.",
                }
            }

    assert _is_invalid_api_key_response(Response()) is True


def test_is_invalid_api_key_response_does_not_classify_schema_400() -> None:
    class Response:
        status_code = 400

        def json(self):
            return {
                "error": {
                    "status": "INVALID_ARGUMENT",
                    "message": "Invalid JSON payload provided to google.ai.generativelanguage.v1beta.GenerativeService.GenerateContent",
                }
            }

    assert _is_invalid_api_key_response(Response()) is False


def test_build_gemini_request_headers_accepts_auth_aq_keys() -> None:
    headers = build_gemini_request_headers("AQ.Ab8RN6K45kNmiQx3NkGhvBM9Bs_example")
    assert headers["x-goog-api-key"].startswith("AQ.")
    assert headers["Content-Type"] == "application/json"


def test_build_gemini_request_headers_accepts_standard_aiza_keys() -> None:
    headers = build_gemini_request_headers("AIzaSyExampleStandardKey")
    assert headers["x-goog-api-key"].startswith("AIza")


def test_model_unavailable_does_not_fallback_by_default(monkeypatch) -> None:
    """Cost guard: model fallback is off; unavailable model fails without retrying another model."""
    from app.services.analysis_errors import AnalysisUnavailableError

    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:AQ.Ab8RN6K45kNmiQx3NkGhvBM9Bs_example",
        multi_key_enabled=True,
    )
    posted_urls: list[str] = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, *args, **kwargs):
            posted_urls.append(url)

            class R:
                status_code = 404
                text = ""
                headers = {}

                def json(self):
                    return {
                        "error": {
                            "status": "NOT_FOUND",
                            "message": (
                                "This model models/gemini-2.5-flash is no longer "
                                "available to new users. Please update your code "
                                "to use a newer model"
                            ),
                        }
                    }

            return R()

    client = GeminiClient(
        manager,
        http_client_factory=FakeClient,
        max_attempts=2,
        sleep=lambda seconds: None,
    )
    with pytest.raises(AnalysisUnavailableError) as exc_info:
        client.post_json(
            url="https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
            payload={"contents": []},
            timeout_seconds=30,
            model="gemini-2.5-flash",
        )
    assert exc_info.value.error_code == "GEMINI_MODEL_UNAVAILABLE"
    assert len(posted_urls) == 1
    assert "gemini-2.5-flash" in posted_urls[0]


def test_http_success_does_not_clear_model_marker(monkeypatch) -> None:
    manager = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        gemini_api_keys="",
        multi_key_enabled=False,
    )
    cleared: list[tuple[str, str]] = []

    def _clear(alias: str, model: str) -> None:
        cleared.append((alias, model))

    monkeypatch.setattr(manager, "clear_model_unsupported", _clear)

    class FakeResponse:
        status_code = 200

        def json(self):
            return {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, *args, **kwargs):
            return FakeResponse()

    client = GeminiClient(
        manager,
        http_client_factory=FakeClient,
        max_attempts=1,
    )
    result = client.post_json(
        url="https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
        payload={"contents": []},
        timeout_seconds=5,
        model="gemini-2.0-flash",
    )
    assert result.key_alias == "primary"
    assert cleared == []


def test_bounded_same_alias_transient_retry_for_503(monkeypatch) -> None:
    manager = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        gemini_api_keys="",
        multi_key_enabled=False,
    )
    call_aliases: list[str] = []

    class FakeResponse:
        status_code = 503

        def json(self):
            return {"error": {"message": "unavailable"}}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, *args, **kwargs):
            return FakeResponse()

    def _select_key(**kwargs):
        from app.services.gemini_key_manager import GeminiKeySelection

        entry = manager.entries[0]
        call_aliases.append(entry.alias)
        return GeminiKeySelection(
            available=True,
            entry=entry,
            has_unattempted_eligible=False,
        )

    monkeypatch.setattr(manager, "select_key", _select_key)
    monkeypatch.setattr(manager, "validate_selection", lambda *a, **k: True)
    monkeypatch.setattr(GeminiClient, "_sleep_before_retry", lambda *a, **k: None)

    client = GeminiClient(
        manager,
        http_client_factory=FakeClient,
        max_attempts=3,
    )
    with pytest.raises(Exception):
        client.post_json(
            url="https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
            payload={"contents": []},
            timeout_seconds=5,
        )
    assert len(call_aliases) >= 2
    assert all(alias == "primary" for alias in call_aliases)
