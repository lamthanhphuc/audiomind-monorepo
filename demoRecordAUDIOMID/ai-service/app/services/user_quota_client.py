"""Internal quota enforcement against user-service."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx
from loguru import logger

from app.config import get_settings


class GeminiQuotaExceededError(RuntimeError):
    """Raised when monthly Gemini input quota is exhausted."""


@dataclass(frozen=True)
class QuotaConsumeResult:
    allowed: bool
    details: dict[str, Any] | None = None
    error: str | None = None


def _normalized_base_url(base_url: str) -> str:
    return (base_url or "").rstrip("/")


def consume_quota(
    user_id: int,
    *,
    stt_seconds_delta: int = 0,
    gemini_chars_delta: int = 0,
) -> QuotaConsumeResult:
    settings = get_settings()
    token = (getattr(settings, "internal_service_token", "") or "").strip()
    fail_open = bool(getattr(settings, "quota_fail_open", True))

    if user_id is None or user_id <= 0:
        return QuotaConsumeResult(True)

    if not token:
        if fail_open:
            logger.warning(
                "event=QUOTA_CLIENT_SKIPPED reason=missing_internal_token userId={}",
                user_id,
            )
            return QuotaConsumeResult(True)
        return QuotaConsumeResult(False, error="QUOTA_CLIENT_UNCONFIGURED")

    body = {
        "userId": user_id,
        "sttSecondsDelta": max(0, int(stt_seconds_delta)),
        "geminiCharsDelta": max(0, int(gemini_chars_delta)),
    }
    headers = {
        "Content-Type": "application/json",
        "X-Internal-Service-Token": token,
    }
    url = f"{_normalized_base_url(settings.user_api_base_url)}/internal/quota/consume"

    try:
        with httpx.Client(timeout=10.0) as client:
            response = client.post(url, json=body, headers=headers)
        if response.status_code >= 400:
            if fail_open:
                logger.warning(
                    "event=QUOTA_CLIENT_FAIL_OPEN userId={} httpStatus={}",
                    user_id,
                    response.status_code,
                )
                return QuotaConsumeResult(True)
            return QuotaConsumeResult(False, error="QUOTA_HTTP_ERROR")

        payload = response.json()
        allowed = bool(payload.get("allowed"))
        return QuotaConsumeResult(allowed, details=payload)
    except Exception as ex:
        if fail_open:
            logger.warning(
                "event=QUOTA_CLIENT_FAIL_OPEN userId={} errorCode={}",
                user_id,
                type(ex).__name__,
            )
            return QuotaConsumeResult(True)
        logger.error(
            "event=QUOTA_CLIENT_ERROR userId={} errorCode={}",
            user_id,
            type(ex).__name__,
        )
        return QuotaConsumeResult(False, error="QUOTA_CLIENT_ERROR")


def enforce_gemini_quota(user_id: int | None, transcript_text: str) -> None:
    if user_id is None or user_id <= 0:
        return
    chars = len(transcript_text or "")
    if chars <= 0:
        return

    provider = (get_settings().analysis_provider or "gemini").strip().lower()
    if provider != "gemini":
        return

    result = consume_quota(user_id, gemini_chars_delta=chars)
    if not result.allowed:
        raise GeminiQuotaExceededError("GEMINI_QUOTA_EXHAUSTED")
