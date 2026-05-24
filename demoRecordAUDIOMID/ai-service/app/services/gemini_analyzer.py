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
        analysis_domain_mode: str = "it",
        analysis_max_input_tokens: int = 12000,
        analysis_max_output_tokens: int = 4096,
        analysis_thinking_budget: int | None = 0,
        analysis_retry_max_attempts: int = 3,
        gemini_max_single_request_chars: int = 50000,
        gemini_request_delay_seconds: float = 15.0,
        timeout_seconds: int = 300,
    ):
        super().__init__(
            api_key=api_key,
            model=analysis_model,
            provider="gemini",
            summary_model=summary_model,
            analysis_domain_mode=analysis_domain_mode,
            analysis_max_input_tokens=analysis_max_input_tokens,
            analysis_max_output_tokens=analysis_max_output_tokens,
            analysis_thinking_budget=analysis_thinking_budget,
            analysis_retry_max_attempts=analysis_retry_max_attempts,
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
