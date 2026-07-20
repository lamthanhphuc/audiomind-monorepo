import pytest

from app.services.gemini_fault_injection import GeminiFaultInjectionClient

# Spec alias for fault-injection doubles used in test_gemini_analyzer profiles.
FakeGeminiClient = GeminiFaultInjectionClient

_GROUPED_ACTION_PLAN_TEST = "test_grouped_action_plan.py"

_OFFLINE_GEMINI_TEST_FILES = frozenset(
    {
        "test_gemini_analyzer.py",
        "test_gemini_key_manager.py",
        "test_gemini_cooldown_store.py",
        "test_analysis_response.py",
        "test_tasks.py",
        "test_offline_network_guard.py",
        "test_analysis_errors.py",
    }
)

_ALLOWED_NETWORK_HOSTS = frozenset(
    {
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
    import socket

    original_client_request = httpx.Client.request
    original_async_client_request = httpx.AsyncClient.request
    original_session_request = requests.Session.request
    original_create_connection = socket.create_connection
    original_socket_connect = socket.socket.connect

    def _host_allowed(host: str) -> bool:
        normalized = (host or "").strip().lower()
        return not normalized or normalized in _ALLOWED_NETWORK_HOSTS

    def _uses_injected_transport(client) -> bool:
        transport = getattr(client, "_transport", None)
        if transport is None:
            return False
        return type(transport).__name__ not in {"HTTPTransport", "AsyncHTTPTransport"}

    def _deny_client_request(self, method, url, *args, **kwargs):
        if _uses_injected_transport(self):
            return original_client_request(self, method, url, *args, **kwargs)
        host = _request_host(url)
        if _host_allowed(host):
            return original_client_request(self, method, url, *args, **kwargs)
        raise AssertionError(
            "Real network calls are forbidden in offline provider tests"
        )

    async def _deny_async_client_request(self, method, url, *args, **kwargs):
        if _uses_injected_transport(self):
            return await original_async_client_request(
                self, method, url, *args, **kwargs
            )
        raise AssertionError(
            "Real network calls are forbidden in offline provider tests"
        )

    def _deny_session_request(self, method, url, *args, **kwargs):
        host = _request_host(url)
        if _host_allowed(host):
            return original_session_request(self, method, url, *args, **kwargs)
        raise AssertionError(
            "Real network calls are forbidden in offline provider tests"
        )

    def _deny_create_connection(address, *args, **kwargs):
        host = str(address[0] if isinstance(address, tuple) else address).strip().lower()
        if _host_allowed(host):
            return original_create_connection(address, *args, **kwargs)
        raise AssertionError(
            "Real network calls are forbidden in offline provider tests"
        )

    def _deny_socket_connect(self, address):
        host = str(address[0] if isinstance(address, tuple) else address).strip().lower()
        if _host_allowed(host):
            return original_socket_connect(self, address)
        raise AssertionError(
            "Real network calls are forbidden in offline provider tests"
        )

    monkeypatch.setattr(httpx.Client, "request", _deny_client_request)
    monkeypatch.setattr(httpx.AsyncClient, "request", _deny_async_client_request)
    monkeypatch.setattr(requests.Session, "request", _deny_session_request)
    monkeypatch.setattr(socket, "create_connection", _deny_create_connection)
    monkeypatch.setattr(socket.socket, "connect", _deny_socket_connect)
    return _deny_client_request
