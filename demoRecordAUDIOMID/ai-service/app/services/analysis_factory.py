from loguru import logger

from app.services.ai_analyzer import AIAnalyzer
from app.services.gemini_analyzer import GeminiAnalyzer


def build_analysis_analyzer(settings):
    provider = (settings.analysis_provider or "openai").strip().lower()

    if provider in {"ollama", "local"}:
        logger.info(
            "Selected analysis provider=ollama model={} timeout_seconds={}",
            settings.ollama_model,
            settings.ollama_timeout_seconds,
        )
        return AIAnalyzer(
            api_key="",
            model=settings.ollama_model,
            provider="ollama",
            ollama_base_url=settings.ollama_base_url,
            timeout_seconds=settings.ollama_timeout_seconds,
        )

    if provider == "gemini":
        logger.info(
            "Selected analysis provider=gemini analysis_model={} summary_model={}",
            settings.gemini_analysis_model,
            settings.gemini_summary_model,
        )
        return GeminiAnalyzer(
            api_key=settings.gemini_api_key,
            analysis_model=settings.gemini_analysis_model,
            summary_model=settings.gemini_summary_model,
            gemini_max_single_request_chars=settings.gemini_max_single_request_chars,
            gemini_request_delay_seconds=settings.gemini_request_delay_seconds,
            timeout_seconds=settings.ollama_timeout_seconds,
        )

    logger.info(
        "Selected analysis provider=openai model={} summary_model={}",
        settings.openai_model,
        settings.openai_summary_model,
    )
    return AIAnalyzer(
        api_key=settings.openai_api_key,
        model=settings.openai_model,
        provider="openai",
        summary_model=settings.openai_summary_model or settings.openai_analysis_model,
        timeout_seconds=settings.ollama_timeout_seconds,
    )
