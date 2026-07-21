from types import SimpleNamespace

import pytest

from app.services.ai_analyzer import AIAnalyzer
from app.services.analysis_errors import AnalysisConfigError
from app.services.analysis_factory import build_analysis_analyzer
from app.services.gemini_analyzer import GeminiAnalyzer


def _build_settings(provider: str = "gemini", *, allow_legacy_local_ai: bool = False):
    return SimpleNamespace(
        analysis_provider=provider,
        allow_legacy_local_ai=allow_legacy_local_ai,
        ollama_model="qwen2.5:3b-instruct",
        ollama_base_url="http://ollama-service:11434",
        ollama_timeout_seconds=300,
        gemini_api_key="test-gemini-key",
        gemini_analysis_model="gemini-3.1-flash-lite",
        gemini_summary_model="gemini-3.1-flash-lite",
        gemini_analysis_domain_mode="it",
        gemini_analysis_max_input_tokens=12000,
        gemini_analysis_max_output_tokens=4096,
        gemini_structured_analysis_max_output_tokens=4096,
        gemini_analysis_thinking_budget=0,
        gemini_analysis_retry_max_attempts=3,
        gemini_max_single_request_chars=50000,
        gemini_request_delay_seconds=15.0,
    )


def test_build_analysis_analyzer_selects_gemini():
    analyzer = build_analysis_analyzer(_build_settings("gemini"))

    assert isinstance(analyzer, GeminiAnalyzer)
    assert analyzer.provider == "gemini"
    assert analyzer.analysis_domain_mode == "it"
    assert analyzer.analysis_max_output_tokens == 4096
    assert analyzer.structured_analysis_max_output_tokens == 4096
    assert analyzer.analysis_thinking_budget == 0


def test_build_analysis_analyzer_defaults_to_gemini():
    analyzer = build_analysis_analyzer(_build_settings())

    assert isinstance(analyzer, GeminiAnalyzer)
    assert analyzer.provider == "gemini"


def test_build_analysis_analyzer_selects_ollama():
    analyzer = build_analysis_analyzer(
        _build_settings("ollama", allow_legacy_local_ai=True)
    )

    assert isinstance(analyzer, AIAnalyzer)
    assert analyzer.provider == "ollama"


def test_build_analysis_analyzer_blocks_ollama_without_legacy_opt_in():
    with pytest.raises(AnalysisConfigError, match="LEGACY_LOCAL_AI_DISABLED"):
        build_analysis_analyzer(_build_settings("ollama"))


def test_build_analysis_analyzer_requires_gemini_api_key():
    settings = _build_settings("gemini")
    settings.gemini_api_key = ""

    with pytest.raises(AnalysisConfigError, match="GEMINI_CONFIG_MISSING"):
        build_analysis_analyzer(settings)
