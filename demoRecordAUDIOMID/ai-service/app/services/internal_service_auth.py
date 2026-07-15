"""Internal service authentication helpers for trusted service-to-service calls."""

from __future__ import annotations

import hmac
import logging
from typing import Any

from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)

INTERNAL_SERVICE_TOKEN_HEADER = "X-Internal-Service-Token"


class FinalAudioAuthError(Exception):
    """Authentication/authorization failure for final-audio fallback."""

    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message
        self.status_code = status_code


def _configured_internal_token(settings: Any | None = None) -> str:
    from app.config import get_settings

    cfg = settings or get_settings()
    return str(getattr(cfg, "internal_service_token", "") or "").strip()


def require_internal_service_token(
    request: Request,
    *,
    settings: Any | None = None,
    header_name: str = INTERNAL_SERVICE_TOKEN_HEADER,
) -> None:
    """
    Require X-Internal-Service-Token matching INTERNAL_SERVICE_TOKEN.

    Safe defaults:
    - Missing configured token → 503 (endpoint not publicly available / misconfigured).
    - Missing header → 401.
    - Invalid header → 403.
    Never logs token values.
    """
    expected = _configured_internal_token(settings)
    if not expected:
        logger.error(
            "FINAL_AUDIO_INTERNAL_AUTH_MISCONFIGURED reason=missing_configured_token"
        )
        raise FinalAudioAuthError(
            "FINAL_AUDIO_INTERNAL_AUTH_MISCONFIGURED",
            "Internal audio fallback is not configured",
            503,
        )

    provided = request.headers.get(header_name)
    if provided is None:
        provided = request.headers.get(header_name.lower())
    # Missing or empty header → 401. Do NOT trim raw request credentials.
    if provided is None or provided == "":
        raise FinalAudioAuthError(
            "FINAL_AUDIO_UNAUTHORIZED",
            "Internal service authentication is required",
            401,
        )

    provided_bytes = provided.encode("utf-8")
    expected_bytes = expected.encode("utf-8")
    if not hmac.compare_digest(provided_bytes, expected_bytes):
        raise FinalAudioAuthError(
            "FINAL_AUDIO_FORBIDDEN",
            "Internal service authentication failed",
            403,
        )


def raise_http_for_auth_error(exc: FinalAudioAuthError) -> None:
    raise HTTPException(
        status_code=exc.status_code,
        detail={"error_code": exc.code, "message": exc.safe_message},
    ) from None
