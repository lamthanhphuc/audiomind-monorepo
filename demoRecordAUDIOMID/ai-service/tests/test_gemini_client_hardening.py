"""Client retry and proxy logging safety tests."""

from __future__ import annotations

import httpx
import pytest

from app.services.gemini_client import (
    GeminiClient,
    SafeProxyContext,
    _sanitize_proxy_for_log,
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
