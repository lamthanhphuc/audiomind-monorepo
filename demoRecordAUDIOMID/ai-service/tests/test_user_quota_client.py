from unittest.mock import MagicMock

import pytest

from app.services.user_quota_client import (
    GeminiQuotaExceededError,
    consume_quota,
    enforce_gemini_quota,
)


def test_consume_quota_fail_open_when_token_missing(monkeypatch):
    settings = MagicMock()
    settings.internal_service_token = ""
    settings.quota_fail_open = True
    settings.user_api_base_url = "http://user-api:8083"
    monkeypatch.setattr("app.services.user_quota_client.get_settings", lambda: settings)

    result = consume_quota(9, gemini_chars_delta=100)

    assert result.allowed is True


def test_enforce_gemini_quota_raises_when_denied(monkeypatch):
    settings = MagicMock()
    settings.analysis_provider = "gemini"
    monkeypatch.setattr("app.services.user_quota_client.get_settings", lambda: settings)
    monkeypatch.setattr(
        "app.services.user_quota_client.consume_quota",
        lambda user_id, **kwargs: MagicMock(allowed=False),
    )

    with pytest.raises(GeminiQuotaExceededError):
        enforce_gemini_quota(7, "transcript text")


def test_enforce_gemini_quota_skips_non_gemini_provider(monkeypatch):
    settings = MagicMock()
    settings.analysis_provider = "ollama"
    monkeypatch.setattr("app.services.user_quota_client.get_settings", lambda: settings)

    enforce_gemini_quota(7, "transcript text")
