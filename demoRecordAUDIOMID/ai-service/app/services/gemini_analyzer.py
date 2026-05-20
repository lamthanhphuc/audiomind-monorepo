import httpx
from loguru import logger

from app.services.ai_analyzer import AIAnalyzer
from app.services.analysis_errors import AnalysisConfigError, AnalysisParseError


class GeminiAnalyzer(AIAnalyzer):
    def __init__(
        self,
        api_key: str,
        analysis_model: str = "gemini-2.5-flash",
        summary_model: str = "gemini-2.5-flash",
        timeout_seconds: int = 300,
    ):
        super().__init__(
            api_key=api_key,
            model=analysis_model,
            provider="gemini",
            summary_model=summary_model,
            timeout_seconds=timeout_seconds,
        )


__all__ = [
    "GeminiAnalyzer",
    "logger",
    "httpx",
    "AnalysisConfigError",
    "AnalysisParseError",
]
