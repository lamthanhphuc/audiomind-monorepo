"""Pickle / Celery serialization safety for analysis exceptions."""

from __future__ import annotations

import pickle

import pytest

from app.services.analysis_errors import (
    AnalysisConfigError,
    AnalysisNotImplementedError,
    AnalysisParseError,
    AnalysisProviderError,
    AnalysisRateLimitError,
    AnalysisUnavailableError,
)


def _assert_round_trip(error: AnalysisProviderError) -> AnalysisProviderError:
    restored = pickle.loads(pickle.dumps(error))
    assert type(restored) is type(error)
    assert restored.provider == error.provider
    assert restored.error_code == error.error_code
    assert restored.key_alias == error.key_alias
    assert restored.status_code == error.status_code
    assert restored.retryable == error.retryable
    assert restored.retry_after_seconds == error.retry_after_seconds
    assert str(restored) == str(error)
    return restored


@pytest.mark.parametrize(
    "error",
    [
        AnalysisUnavailableError(
            "Gemini model unavailable",
            provider="gemini",
            error_code="GEMINI_MODEL_UNAVAILABLE",
            retryable=False,
            key_alias="backup1",
        ),
        AnalysisRateLimitError(
            "Gemini rate limit reached",
            provider="gemini",
            error_code="GEMINI_RATE_LIMITED",
            retry_after_seconds=42,
            key_alias="primary",
        ),
        AnalysisUnavailableError(
            "Gemini key pool unavailable",
            provider="gemini",
            error_code="GEMINI_KEY_POOL_UNAVAILABLE",
            retryable=True,
            retry_after_seconds=30,
            key_alias=None,
        ),
        AnalysisUnavailableError(
            "billing depleted",
            provider="gemini",
            error_code="GEMINI_BILLING_CREDITS_DEPLETED",
            retryable=False,
            key_alias="primary",
        ),
        AnalysisConfigError(
            "invalid key",
            provider="gemini",
            error_code="GEMINI_INVALID_KEY",
            key_alias="backup2",
        ),
        AnalysisParseError("bad json", provider="gemini"),
        AnalysisNotImplementedError("not impl", provider="ollama"),
        AnalysisProviderError(
            "base",
            provider="gemini",
            status_code=502,
            retryable=True,
            error_code="GEMINI_UNAVAILABLE",
            key_alias="primary",
        ),
    ],
)
def test_analysis_errors_pickle_round_trip(error):
    _assert_round_trip(error)


def test_celery_get_pickleable_exception_preserves_type():
    pytest.importorskip("celery")
    from celery.utils.serialization import get_pickleable_exception

    error = AnalysisUnavailableError(
        "pool mixed",
        provider="gemini",
        error_code="GEMINI_KEY_POOL_UNAVAILABLE",
        key_alias="backup1",
    )
    pickleable = get_pickleable_exception(error)
    restored = pickle.loads(pickle.dumps(pickleable))
    assert type(restored) is AnalysisUnavailableError
    assert restored.error_code == "GEMINI_KEY_POOL_UNAVAILABLE"
    assert restored.key_alias == "backup1"
    assert "UnpickleableExceptionWrapper" not in type(restored).__name__
