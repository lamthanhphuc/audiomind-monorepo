"""Shared study exception classification for provider / network failures."""

from __future__ import annotations

from app.services.study import StudyTransientError, StudyValidationError


def is_transient_provider_error(exc: BaseException) -> bool:
    """True when the failure looks like a retryable provider/network error."""
    if isinstance(exc, (TimeoutError, ConnectionError, BrokenPipeError, ConnectionResetError)):
        return True

    name = type(exc).__name__.lower()
    module = (type(exc).__module__ or "").lower()
    msg = str(exc).lower()

    if "httpx" in module or "requests" in module or "urllib3" in module or "urllib" in module:
        if any(
            token in name
            for token in ("timeout", "connect", "network", "remote", "httpstatus", "protocol")
        ):
            return True
        if any(
            token in msg
            for token in ("timeout", "timed out", "connection", "temporarily", "reset")
        ):
            return True

    transient_tokens = (
        "timeout",
        "timed out",
        "connection reset",
        "connection refused",
        "connection aborted",
        "temporarily unavailable",
        "service unavailable",
        "too many requests",
        "rate limit",
        "429",
        " 502",
        " 503",
        " 504",
        "http 5",
        "status code 5",
        "status=5",
        "deadline exceeded",
    )
    if any(token in msg for token in transient_tokens):
        return True
    if "429" in name or "ratelimit" in name or "timeout" in name:
        return True
    return False


def classify_provider_exception(exc: BaseException) -> BaseException:
    """Classify helper/provider failures for study generation.

    - StudyValidationError / StudyTransientError → returned as-is
    - Transient network/provider → StudyTransientError
    - TypeError / AttributeError / KeyError → returned as-is (programming)
    - Else → returned as-is (caller may mark INTERNAL; not transient)
    """
    if isinstance(exc, (StudyValidationError, StudyTransientError)):
        return exc
    if isinstance(exc, (TypeError, AttributeError, KeyError)):
        return exc
    if is_transient_provider_error(exc):
        return StudyTransientError(str(exc))
    return exc
