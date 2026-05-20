from types import SimpleNamespace

from app.services.ai_analyzer import AIAnalyzer
from app.services.analysis_factory import build_analysis_analyzer
from app.services.gemini_analyzer import GeminiAnalyzer


def _build_settings(provider: str):
    return SimpleNamespace(
        analysis_provider=provider,
        ollama_model="qwen2.5:3b-instruct",
        ollama_base_url="http://ollama-service:11434",
        ollama_timeout_seconds=300,
        gemini_api_key="test-gemini-key",
        gemini_analysis_model="gemini-2.5-flash",
        gemini_summary_model="gemini-2.5-flash",
        openai_api_key="test-openai-key",
        openai_model="gpt-4o",
        openai_analysis_model="",
        openai_summary_model="",
    )


def test_build_analysis_analyzer_selects_gemini():
    analyzer = build_analysis_analyzer(_build_settings("gemini"))

    assert isinstance(analyzer, GeminiAnalyzer)
    assert analyzer.provider == "gemini"


def test_build_analysis_analyzer_selects_ollama():
    analyzer = build_analysis_analyzer(_build_settings("ollama"))

    assert isinstance(analyzer, AIAnalyzer)
    assert analyzer.provider == "ollama"
