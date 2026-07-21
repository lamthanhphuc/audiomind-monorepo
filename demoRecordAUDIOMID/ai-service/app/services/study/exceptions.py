"""Shared study exception classification for provider / network failures."""

from __future__ import annotations

import json
import re

from app.services.study import StudyTransientError, StudyValidationError

try:
    from pydantic import ValidationError as PydanticValidationError
except ImportError:  # pragma: no cover
    PydanticValidationError = None


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
        " 500",
        " 501",
        " 502",
        " 503",
        " 504",
        " 505",
        "http 5",
        "status code 5",
        "status=5",
        "deadline exceeded",
    )
    if any(token in msg for token in transient_tokens):
        return True
    # Any HTTP 5xx status mentioned in the message (e.g. "500 Internal Server Error").
    if re.search(r"(?<!\d)5\d{2}(?!\d)", msg) and any(
        token in msg for token in ("http", "status", "error", "code", "server")
    ):
        return True
    if "429" in name or "ratelimit" in name or "timeout" in name:
        return True
    return False


def classify_provider_exception(exc: BaseException) -> BaseException:
    """Classify helper/provider failures for study generation.

    - StudyValidationError / StudyTransientError → returned as-is
    - json.JSONDecodeError → StudyValidationError INVALID_PROVIDER_JSON
    - pydantic ValidationError → StudyValidationError INVALID_PROVIDER_SCHEMA
    - Transient network/provider → StudyTransientError
    - TypeError / AttributeError / KeyError → returned as-is (programming)
    - Else → returned as-is (caller may mark INTERNAL; not transient)
    """
    if isinstance(exc, (StudyValidationError, StudyTransientError)):
        return exc
    if isinstance(exc, json.JSONDecodeError):
        return StudyValidationError(
            "INVALID_PROVIDER_JSON",
            "Provider response is not valid JSON",
        )
    if PydanticValidationError is not None and isinstance(exc, PydanticValidationError):
        return StudyValidationError(
            "INVALID_PROVIDER_SCHEMA",
            "Provider response does not match expected schema",
        )
    # Do NOT convert programming errors to transient (JSONDecodeError is ValueError).
    if isinstance(exc, (TypeError, AttributeError, KeyError)):
        return exc
    if is_transient_provider_error(exc):
        return StudyTransientError(str(exc))
    return exc
