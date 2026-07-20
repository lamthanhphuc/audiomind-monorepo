import pytest

from app.services.gemini_fault_injection import GeminiFaultInjectionClient

# Spec alias for fault-injection doubles used in test_gemini_analyzer profiles.
FakeGeminiClient = GeminiFaultInjectionClient

_GROUPED_ACTION_PLAN_TEST = "test_grouped_action_plan.py"

_OFFLINE_GEMINI_TEST_FILES = frozenset(
    {
        "test_gemini_analyzer.py",
        "test_gemini_key_manager.py",
        "test_analysis_response.py",
        "test_tasks.py",
        "test_offline_network_guard.py",
        "test_analysis_errors.py",
    }
)

_ALLOWED_NETWORK_HOSTS = frozenset(
    {
        "example.test",
        "example.com",
        "testserver",
        "localhost",
        "127.0.0.1",
        "::1",
    }
)


def _request_host(url) -> str:
    from urllib.parse import urlparse

    parsed = urlparse(str(url))
    return (parsed.hostname or "").strip().lower()


@pytest.fixture(autouse=True)
def disable_gemini_http_proxy_for_unit_tests(monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "gemini_http_proxy", "")


@pytest.fixture(autouse=True)
def disable_short_transcript_gate_for_legacy_tests(request, monkeypatch):
    if request.node.fspath.basename in (
        "test_transcript_quality_gate.py",
        _GROUPED_ACTION_PLAN_TEST,
    ):
        return
    from app import main as main_module

    monkeypatch.setattr(
        main_module.settings,
        "analysis_short_transcript_gate_enabled",
        False,
    )


@pytest.fixture(autouse=True)
def deny_real_network(request, monkeypatch):
    """Block outbound HTTP to non-local hosts in offline Gemini test suites."""
    if request.node.fspath.basename not in _OFFLINE_GEMINI_TEST_FILES:
        return None

    import httpx
    import requests

    original_client_request = httpx.Client.request
    original_async_client_request = httpx.AsyncClient.request
    original_session_request = requests.Session.request

    def _deny_client_request(self, method, url, *args, **kwargs):
        host = _request_host(url)
        if host in _ALLOWED_NETWORK_HOSTS or not host:
            return original_client_request(self, method, url, *args, **kwargs)
        raise AssertionError(
            "Real network calls are forbidden in offline Gemini tests"
        )

    async def _deny_async_client_request(self, method, url, *args, **kwargs):
        host = _request_host(url)
        if host in _ALLOWED_NETWORK_HOSTS or not host:
            return await original_async_client_request(
                self, method, url, *args, **kwargs
            )
        raise AssertionError(
            "Real network calls are forbidden in offline Gemini tests"
        )

    def _deny_session_request(self, method, url, *args, **kwargs):
        host = _request_host(url)
        if host in _ALLOWED_NETWORK_HOSTS or not host:
            return original_session_request(self, method, url, *args, **kwargs)
        raise AssertionError(
            "Real network calls are forbidden in offline Gemini tests"
        )

    monkeypatch.setattr(httpx.Client, "request", _deny_client_request)
    monkeypatch.setattr(httpx.AsyncClient, "request", _deny_async_client_request)
    monkeypatch.setattr(requests.Session, "request", _deny_session_request)
    return _deny_client_request
