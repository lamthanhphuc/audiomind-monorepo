import httpx
import pytest

from app.services import gemini_client as gemini_client_module
from app.services.analysis_errors import (
    AnalysisUnavailableError,
)
from app.services.gemini_analyzer import GeminiAnalyzer
from app.services.gemini_fault_injection import (
    GeminiFaultInjectionClient,
    resolve_gemini_http_client_factory,
)
from app.services.gemini_key_manager import GeminiKeyManager


class _TrackingFaultClient(GeminiFaultInjectionClient):
    def __init__(self, profile: str):
        super().__init__(profile)
        self.api_keys: list[str] = []

    def post(
        self,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        json=None,
        timeout=None
    ):
        if headers and headers.get("x-goog-api-key"):
            self.api_keys.append(headers["x-goog-api-key"])
        return super().post(url, headers=headers, json=json, timeout=timeout)


def _analyzer_with_profile(profile: str) -> tuple[GeminiAnalyzer, _TrackingFaultClient]:
    tracking_client = _TrackingFaultClient(profile)
    key_manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
    )

    def factory(*_args, **_kwargs):
        return tracking_client

    gemini_client = gemini_client_module.GeminiClient(
        key_manager,
        max_attempts=4,
        backoff_base_ms=0,
        backoff_max_ms=0,
        fail_fast_seconds=30,
        http_client_factory=factory,
        sleep=lambda _seconds: None,
        random_float=lambda _low, _high: 0.0,
    )
    analyzer = GeminiAnalyzer(
        api_key="key-a",
        gemini_api_keys="primary:key-a,backup1:key-b",
        gemini_multi_key_enabled=True,
        gemini_max_attempts=4,
        gemini_backoff_base_ms=0,
        gemini_backoff_max_ms=0,
    )
    analyzer.gemini_client = gemini_client
    return analyzer, tracking_client


def test_fault_profile_primary_429_backup_ok():
    analyzer, tracking_client = _analyzer_with_profile("primary_429_backup_ok")
    result = analyzer._analyze_with_gemini("Speaker 1: retryable transcript content")

    assert result["summary"] == "Fault injection success"
    assert tracking_client.api_keys == ["key-a", "key-b"]


def test_fault_profile_all_503_maps_to_retryable_unavailable():
    analyzer, _ = _analyzer_with_profile("all_503")

    with pytest.raises(AnalysisUnavailableError) as exc_info:
        analyzer._analyze_with_gemini("Speaker 1: overloaded transcript")

    assert exc_info.value.error_code == "GEMINI_UNAVAILABLE"


def test_fault_profile_timeout_maps_to_gemini_unavailable():
    analyzer, _ = _analyzer_with_profile("timeout")

    with pytest.raises(AnalysisUnavailableError) as exc_info:
        analyzer._analyze_with_gemini("Speaker 1: timeout transcript")

    assert exc_info.value.error_code == "GEMINI_UNAVAILABLE"


def test_fault_profile_invalid_400_is_not_retryable():
    analyzer, _ = _analyzer_with_profile("invalid_400")

    with pytest.raises(AnalysisUnavailableError) as exc_info:
        analyzer._analyze_with_gemini("Speaker 1: invalid transcript")

    assert exc_info.value.error_code == "GEMINI_INVALID_REQUEST"
    assert exc_info.value.retryable is False


def test_resolve_factory_passthrough_without_profile():
    factory = resolve_gemini_http_client_factory("")
    assert factory is httpx.Client
