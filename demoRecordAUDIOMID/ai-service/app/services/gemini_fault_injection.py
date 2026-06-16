from __future__ import annotations

import json
from typing import Any, Callable

import httpx

_SUCCESS_ANALYSIS_TEXT = json.dumps(
    {
        "summary": "Fault injection success",
        "keywords": ["api"],
        "technicalTerms": [],
        "painPoints": [],
        "actionItems": ["Follow up"],
        "domainMode": "it",
    }
)


class _FaultResponse:
    def __init__(self, status_code: int, payload: dict[str, Any] | None = None, headers: dict[str, str] | None = None):
        self.status_code = status_code
        self._payload = payload or {}
        self.headers = headers or {}

    def json(self) -> dict[str, Any]:
        return self._payload


class GeminiFaultInjectionClient:
    """HTTP test double for GEMINI_CLIENT_TEST_MODE profiles."""

    def __init__(self, profile: str, *, timeout: float | None = None):
        self.profile = str(profile or "").strip().lower()
        self.timeout = timeout
        self._attempt_by_alias: dict[str, int] = {}
        self._global_attempt = 0

    def post(self, url: str, *, headers: dict[str, str] | None = None, json: dict[str, Any] | None = None, timeout: float | None = None):
        _ = url, json, timeout or self.timeout, headers
        self._global_attempt += 1
        attempt = self._global_attempt

        if self.profile == "primary_429_backup_ok":
            if attempt == 1:
                return _FaultResponse(
                    429,
                    {"error": {"status": "RESOURCE_EXHAUSTED", "message": "rate limited"}},
                    {"Retry-After": "1"},
                )
            return _FaultResponse(200, {"candidates": [{"content": {"parts": [{"text": _SUCCESS_ANALYSIS_TEXT}]}}]})

        if self.profile == "all_503":
            return _FaultResponse(
                503,
                {"error": {"status": "UNAVAILABLE", "message": "model overloaded"}},
            )

        if self.profile == "timeout":
            raise httpx.TimeoutException("injected timeout", request=httpx.Request("POST", url))

        if self.profile == "invalid_400":
            return _FaultResponse(
                400,
                {"error": {"status": "INVALID_ARGUMENT", "message": "invalid request"}},
            )

        return _FaultResponse(200, {"candidates": [{"content": {"parts": [{"text": _SUCCESS_ANALYSIS_TEXT}]}}]})

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def resolve_gemini_http_client_factory(
    test_mode: str | None,
    default_factory: Callable[..., Any] = httpx.Client,
) -> Callable[..., Any]:
    profile = str(test_mode or "").strip().lower()
    if not profile:
        return default_factory

    def factory(*args, **kwargs):
        timeout = kwargs.get("timeout")
        return GeminiFaultInjectionClient(profile, timeout=timeout)

    return factory
