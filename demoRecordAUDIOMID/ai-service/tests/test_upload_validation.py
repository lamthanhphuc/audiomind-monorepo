import pytest
from fastapi import HTTPException

from app.main import _map_http_exception
from app.upload_validation_policy import (
    STRICT_ALLOWED_EXTENSIONS,
    STRICT_MAX_UPLOAD_BYTES,
    effective_allowed_extensions,
    effective_max_upload_bytes,
)
from starlette.requests import Request


def _make_request(path: str = "/api/upload-audio") -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "http",
            "path": path,
            "headers": [],
            "query_string": b"",
        }
    )


def test_effective_policy_uses_contract_when_strict_enabled():
    assert effective_max_upload_bytes(strict=True, legacy_max_bytes=999) == STRICT_MAX_UPLOAD_BYTES
    assert effective_allowed_extensions(strict=True, legacy_extensions=".ogg") == STRICT_ALLOWED_EXTENSIONS


def test_map_http_exception_maps_upload_too_large():
    request = _make_request()
    error_code, message, _details = _map_http_exception(
        request, HTTPException(status_code=413, detail="UPLOAD_TOO_LARGE")
  )
    assert error_code == "UPLOAD_TOO_LARGE"
    assert "100MB" in message


def test_map_http_exception_maps_upload_unsupported_format():
    request = _make_request()
    error_code, message, _details = _map_http_exception(
        request, HTTPException(status_code=415, detail="UPLOAD_UNSUPPORTED_FORMAT")
    )
    assert error_code == "UPLOAD_UNSUPPORTED_FORMAT"
    assert ".mp3" in message
