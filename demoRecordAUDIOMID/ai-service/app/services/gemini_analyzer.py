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
        gemini_max_single_request_chars: int = 50000,
        gemini_request_delay_seconds: float = 15.0,
        timeout_seconds: int = 300,
    ):
        super().__init__(
            api_key=api_key,
            model=analysis_model,
            provider="gemini",
            summary_model=summary_model,
            gemini_max_single_request_chars=gemini_max_single_request_chars,
            gemini_request_delay_seconds=gemini_request_delay_seconds,
            timeout_seconds=timeout_seconds,
        )


__all__ = [
    "GeminiAnalyzer",
    "logger",
    "httpx",
    "AnalysisConfigError",
    "AnalysisParseError",
]
