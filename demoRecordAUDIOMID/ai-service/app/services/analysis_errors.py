"""Analysis provider exceptions — Celery/pickle safe.

Constructors keep keyword-only kwargs for call sites, but every exception that
may leave a Celery task implements ``__reduce__`` so pickle round-trips restore
class, message, and structured fields without secrets.
"""

from __future__ import annotations

from typing import Any


def _rebuild_analysis_error(
    class_name: str,
    message: str,
    state: dict[str, Any],
) -> "AnalysisProviderError":
    cls = globals()[class_name]
    provider = str(state.get("provider") or "unknown")
    error_code = state.get("error_code")
    retry_after_seconds = state.get("retry_after_seconds")
    key_alias = state.get("key_alias")

    if class_name == "AnalysisProviderError":
        return AnalysisProviderError(
            message,
            provider=provider,
            status_code=int(state.get("status_code") or 503),
            retryable=bool(state.get("retryable", False)),
            error_code=error_code,
            retry_after_seconds=retry_after_seconds,
            key_alias=key_alias,
        )
    if class_name == "AnalysisConfigError":
        return AnalysisConfigError(
            message,
            provider=provider,
            error_code=error_code,
            retry_after_seconds=retry_after_seconds,
            key_alias=key_alias,
        )
    if class_name == "AnalysisUnavailableError":
        return AnalysisUnavailableError(
            message,
            provider=provider,
            error_code=error_code,
            retry_after_seconds=retry_after_seconds,
            retryable=bool(state.get("retryable", True)),
            key_alias=key_alias,
        )
    if class_name == "AnalysisRateLimitError":
        return AnalysisRateLimitError(
            message,
            provider=provider,
            error_code=error_code,
            retry_after_seconds=retry_after_seconds,
            key_alias=key_alias,
        )
    if class_name == "AnalysisParseError":
        return AnalysisParseError(message, provider=provider)
    if class_name == "AnalysisNotImplementedError":
        return AnalysisNotImplementedError(message, provider=provider)
    # Fallback for forward-compatible subclass names registered in this module.
    return cls(
        message,
        provider=provider,
        error_code=error_code,
        retry_after_seconds=retry_after_seconds,
        key_alias=key_alias,
    )


class AnalysisProviderError(Exception):
    def __init__(
        self,
        message: str,
        *,
        provider: str,
        status_code: int,
        retryable: bool = False,
        error_code: str | None = None,
        retry_after_seconds: int | None = None,
        key_alias: str | None = None,
    ):
        super().__init__(message)
        self.provider = provider
        self.status_code = status_code
        self.retryable = retryable
        self.error_code = error_code
        self.retry_after_seconds = retry_after_seconds
        self.key_alias = key_alias

    def _pickle_state(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "status_code": self.status_code,
            "retryable": self.retryable,
            "error_code": self.error_code,
            "retry_after_seconds": self.retry_after_seconds,
            "key_alias": self.key_alias,
        }

    def __reduce__(self):
        return (
            _rebuild_analysis_error,
            (self.__class__.__name__, str(self), self._pickle_state()),
        )


class AnalysisConfigError(AnalysisProviderError):
    def __init__(
        self,
        message: str,
        *,
        provider: str,
        error_code: str | None = None,
        retry_after_seconds: int | None = None,
        key_alias: str | None = None,
    ):
        super().__init__(
            message,
            provider=provider,
            status_code=503,
            retryable=False,
            error_code=error_code,
            retry_after_seconds=retry_after_seconds,
            key_alias=key_alias,
        )


class AnalysisUnavailableError(AnalysisProviderError):
    def __init__(
        self,
        message: str,
        *,
        provider: str,
        error_code: str | None = None,
        retry_after_seconds: int | None = None,
        retryable: bool = True,
        key_alias: str | None = None,
    ):
        super().__init__(
            message,
            provider=provider,
            status_code=503,
            retryable=retryable,
            error_code=error_code,
            retry_after_seconds=retry_after_seconds,
            key_alias=key_alias,
        )


class AnalysisRateLimitError(AnalysisProviderError):
    def __init__(
        self,
        message: str,
        *,
        provider: str,
        error_code: str | None = None,
        retry_after_seconds: int | None = None,
        key_alias: str | None = None,
    ):
        super().__init__(
            message,
            provider=provider,
            status_code=429,
            retryable=True,
            error_code=error_code,
            retry_after_seconds=retry_after_seconds,
            key_alias=key_alias,
        )


class AnalysisParseError(AnalysisProviderError):
    def __init__(self, message: str, *, provider: str):
        super().__init__(message, provider=provider, status_code=502, retryable=False)


class AnalysisNotImplementedError(AnalysisProviderError):
    def __init__(self, message: str, *, provider: str):
        super().__init__(message, provider=provider, status_code=501, retryable=False)
