from loguru import logger

from app.services.ai_analyzer import AIAnalyzer
from app.services.analysis_errors import AnalysisConfigError
from app.services.gemini_analyzer import GeminiAnalyzer


def build_analysis_analyzer(settings):
    provider = (settings.analysis_provider or "gemini").strip().lower()

    if provider in {"ollama", "local"}:
        if not bool(getattr(settings, "allow_legacy_local_ai", False)):
            logger.error(
                "Selected analysis provider=ollama blocked reason=legacy_local_ai_disabled allowLegacyLocalAi={}",
                bool(getattr(settings, "allow_legacy_local_ai", False)),
            )
            raise AnalysisConfigError(
                "LEGACY_LOCAL_AI_DISABLED: set ALLOW_LEGACY_LOCAL_AI=true to use Ollama",
                provider="ollama",
            )
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
        gemini_multi_key_enabled = bool(
            getattr(settings, "gemini_multi_key_enabled", False)
        )
        gemini_api_keys = getattr(settings, "gemini_api_keys", "")
        if not (settings.gemini_api_key or "").strip() and not (
            gemini_multi_key_enabled and (gemini_api_keys or "").strip()
        ):
            logger.error(
                "Selected analysis provider=gemini blocked reason=missing_api_key"
            )
            raise AnalysisConfigError(
                "GEMINI_CONFIG_MISSING: GEMINI_API_KEY is required when ANALYSIS_PROVIDER=gemini",
                provider="gemini",
            )
        analysis_domain_mode = getattr(settings, "gemini_analysis_domain_mode", "it")
        analysis_max_input_tokens = getattr(
            settings, "gemini_analysis_max_input_tokens", 12000
        )
        analysis_max_output_tokens = getattr(
            settings, "gemini_analysis_max_output_tokens", 8192
        )
        analysis_thinking_budget = getattr(
            settings, "gemini_analysis_thinking_budget", 0
        )
        analysis_retry_max_attempts = getattr(
            settings, "gemini_analysis_retry_max_attempts", 3
        )
        gemini_timeout_seconds = getattr(settings, "gemini_timeout_seconds", 300)
        gemini_rate_limit_retry_base_seconds = getattr(
            settings, "gemini_rate_limit_retry_base_seconds", 30.0
        )
        gemini_rate_limit_retry_max_seconds = getattr(
            settings, "gemini_rate_limit_retry_max_seconds", 90.0
        )
        gemini_retry_quota_exceeded = getattr(
            settings, "gemini_retry_quota_exceeded", False
        )
        gemini_max_tokens_retry_enabled = getattr(
            settings, "gemini_max_tokens_retry_enabled", True
        )
        gemini_max_attempts = getattr(
            settings, "gemini_max_attempts", analysis_retry_max_attempts
        )
        gemini_key_cooldown_seconds = getattr(
            settings, "gemini_key_cooldown_seconds", 90.0
        )
        gemini_key_hard_cooldown_seconds = getattr(
            settings, "gemini_key_hard_cooldown_seconds", 900.0
        )
        gemini_backoff_base_ms = getattr(settings, "gemini_backoff_base_ms", 500.0)
        gemini_backoff_max_ms = getattr(settings, "gemini_backoff_max_ms", 10000.0)
        gemini_backoff_jitter = getattr(settings, "gemini_backoff_jitter", True)
        gemini_fail_fast_seconds = getattr(settings, "gemini_fail_fast_seconds", 30.0)
        logger.info(
            "Selected analysis provider=gemini analysis_model={} summary_model={} timeout_seconds={} retry_max_attempts={}",
            settings.gemini_analysis_model,
            settings.gemini_summary_model,
            gemini_timeout_seconds,
            analysis_retry_max_attempts,
        )
        return GeminiAnalyzer(
            api_key=settings.gemini_api_key,
            analysis_model=settings.gemini_analysis_model,
            summary_model=settings.gemini_summary_model,
            analysis_domain_mode=analysis_domain_mode,
            analysis_max_input_tokens=analysis_max_input_tokens,
            analysis_max_output_tokens=analysis_max_output_tokens,
            analysis_thinking_budget=analysis_thinking_budget,
            analysis_retry_max_attempts=analysis_retry_max_attempts,
            gemini_rate_limit_retry_base_seconds=gemini_rate_limit_retry_base_seconds,
            gemini_rate_limit_retry_max_seconds=gemini_rate_limit_retry_max_seconds,
            gemini_retry_quota_exceeded=gemini_retry_quota_exceeded,
            gemini_max_tokens_retry_enabled=gemini_max_tokens_retry_enabled,
            gemini_max_single_request_chars=settings.gemini_max_single_request_chars,
            gemini_request_delay_seconds=settings.gemini_request_delay_seconds,
            gemini_api_keys=gemini_api_keys,
            gemini_multi_key_enabled=gemini_multi_key_enabled,
            gemini_max_attempts=gemini_max_attempts,
            gemini_key_cooldown_seconds=gemini_key_cooldown_seconds,
            gemini_key_hard_cooldown_seconds=gemini_key_hard_cooldown_seconds,
            gemini_backoff_base_ms=gemini_backoff_base_ms,
            gemini_backoff_max_ms=gemini_backoff_max_ms,
            gemini_backoff_jitter=gemini_backoff_jitter,
            gemini_fail_fast_seconds=gemini_fail_fast_seconds,
            timeout_seconds=gemini_timeout_seconds,
        )

    raise AnalysisConfigError(
        f"Unsupported analysis provider: {provider}. Use ANALYSIS_PROVIDER=gemini.",
        provider=provider,
    )
