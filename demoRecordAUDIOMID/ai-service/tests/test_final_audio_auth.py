from __future__ import annotations

import asyncio
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.services.final_audio_fallback import run_final_audio_fallback
from app.services.final_audio_path_validation import FinalAudioPathError
from app.services.internal_service_auth import (
    FinalAudioAuthError,
    require_internal_service_token,
)


def _request_with_headers(headers: dict[str, str]) -> Request:
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/api/v1/stt/final-audio-fallback",
        "raw_path": b"/api/v1/stt/final-audio-fallback",
        "query_string": b"",
        "headers": [
            (key.lower().encode("latin-1"), value.encode("latin-1"))
            for key, value in headers.items()
        ],
        "client": ("127.0.0.1", 12345),
        "server": ("test", 80),
    }
    return Request(scope)


def test_missing_configured_token_rejects_with_503():
    settings = MagicMock()
    settings.internal_service_token = ""
    with pytest.raises(FinalAudioAuthError) as exc:
        require_internal_service_token(_request_with_headers({}), settings=settings)
    assert exc.value.status_code == 503
    assert exc.value.code == "FINAL_AUDIO_INTERNAL_AUTH_MISCONFIGURED"


def test_missing_header_rejects_with_401():
    settings = MagicMock()
    settings.internal_service_token = "expected-secret"
    with pytest.raises(FinalAudioAuthError) as exc:
        require_internal_service_token(_request_with_headers({}), settings=settings)
    assert exc.value.status_code == 401
    assert exc.value.code == "FINAL_AUDIO_UNAUTHORIZED"
    assert "expected-secret" not in str(exc.value)


def test_invalid_token_rejects_with_403():
    settings = MagicMock()
    settings.internal_service_token = "expected-secret"
    with pytest.raises(FinalAudioAuthError) as exc:
        require_internal_service_token(
            _request_with_headers({"X-Internal-Service-Token": "wrong"}),
            settings=settings,
        )
    assert exc.value.status_code == 403
    assert exc.value.code == "FINAL_AUDIO_FORBIDDEN"
    assert "expected-secret" not in str(exc.value)
    assert "wrong" not in exc.value.safe_message


def test_valid_token_passes():
    settings = MagicMock()
    settings.internal_service_token = "expected-secret"
    require_internal_service_token(
        _request_with_headers({"X-Internal-Service-Token": "expected-secret"}),
        settings=settings,
    )


def test_run_final_audio_fallback_propagates_path_error():
    with patch(
        "app.services.final_audio_fallback.validate_final_audio_fallback_path",
        side_effect=FinalAudioPathError(
            "FINAL_AUDIO_PATH_FORBIDDEN",
            "Audio path is outside the allowed storage roots",
        ),
    ):
        with pytest.raises(FinalAudioPathError) as exc:
            run_final_audio_fallback(
                meeting_id=42,
                audio_path="/tmp/secret.webm",
                language="vi",
                trace_id="trace-42",
                request_id="req-42",
            )
    assert exc.value.code == "FINAL_AUDIO_PATH_FORBIDDEN"
    assert "/tmp" not in exc.value.safe_message


def test_final_audio_fallback_route_maps_validation_to_400():
    from app.main import final_audio_fallback

    async def run() -> None:
        request = _request_with_headers({"X-Internal-Service-Token": "svc-token"})
        with patch(
            "app.services.internal_service_auth._configured_internal_token",
            return_value="svc-token",
        ), patch(
            "asyncio.to_thread",
            side_effect=FinalAudioPathError(
                "FINAL_AUDIO_EXTENSION_REJECTED",
                "Audio file extension is not supported",
            ),
        ):
            with pytest.raises(HTTPException) as exc:
                await final_audio_fallback(
                    http_request=request,
                    meeting_id=1,
                    audio_path="/app/uploads/x.exe",
                    language="vi",
                )
        assert exc.value.status_code == 400
        assert exc.value.detail["error_code"] == "FINAL_AUDIO_EXTENSION_REJECTED"

    asyncio.run(run())


def test_final_audio_fallback_route_maps_probe_unavailable_to_503():
    from app.main import final_audio_fallback

    async def run() -> None:
        request = _request_with_headers({"X-Internal-Service-Token": "svc-token"})
        with patch(
            "app.services.internal_service_auth._configured_internal_token",
            return_value="svc-token",
        ), patch(
            "asyncio.to_thread",
            side_effect=FinalAudioPathError(
                "FINAL_AUDIO_PROBE_UNAVAILABLE",
                "Audio probe is unavailable on this server",
            ),
        ):
            with pytest.raises(HTTPException) as exc:
                await final_audio_fallback(
                    http_request=request,
                    meeting_id=1,
                    audio_path="/app/uploads/x.webm",
                    language="vi",
                )
        assert exc.value.status_code == 503

    asyncio.run(run())


def test_final_audio_fallback_route_rejects_missing_token():
    from app.main import final_audio_fallback

    async def run() -> None:
        request = _request_with_headers({})
        with patch(
            "app.services.internal_service_auth._configured_internal_token",
            return_value="svc-token",
        ):
            with pytest.raises(HTTPException) as exc:
                await final_audio_fallback(
                    http_request=request,
                    meeting_id=1,
                    audio_path="/app/uploads/x.webm",
                    language="vi",
                )
        assert exc.value.status_code == 401
        assert "svc-token" not in str(exc.value.detail)

    asyncio.run(run())
