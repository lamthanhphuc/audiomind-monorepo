import asyncio
import json

import app.main as main_module
from fastapi.exceptions import RequestValidationError
from starlette.requests import Request


def _make_request(path: str, trace_id: str | None = None) -> Request:
    headers = []
    if trace_id:
        headers.append((b"x-trace-id", trace_id.encode("utf-8")))
    scope = {
        "type": "http",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "query_string": b"",
        "headers": headers,
        "server": ("testserver", 80),
        "client": ("pytest", 5000),
    }
    request = Request(scope)
    if trace_id:
        request.state.trace_id = trace_id
    return request


def test_http_exception_not_found_analysis_returns_canonical_payload():
    request = _make_request("/api/meeting/123/analysis", trace_id="test-trace-123")
    exception = main_module.HTTPException(status_code=404, detail="Analysis not found")

    response = asyncio.run(main_module.http_exception_handler(request, exception))
    payload = json.loads(response.body.decode("utf-8"))

    assert response.status_code == 404
    assert response.headers.get("x-trace-id") == "test-trace-123"
    assert payload["error"] == "ANALYSIS_NOT_READY"
    assert payload["message"] == "Analysis is not ready yet"
    assert payload["status"] == 404
    assert payload["traceId"] == "test-trace-123"
    assert payload["path"] == "/api/meeting/123/analysis"
    assert payload["details"]["meetingId"] == "123"
    assert payload["timestamp"].endswith("Z")


def test_validation_exception_returns_canonical_payload_with_422_status():
    request = _make_request("/api/process", trace_id="trace-validation-1")
    exception = RequestValidationError(
        [
            {
                "loc": ("body", "meeting_id"),
                "msg": "Field required",
                "type": "missing",
                "input": None,
            }
        ]
    )

    response = asyncio.run(main_module.validation_exception_handler(request, exception))
    payload = json.loads(response.body.decode("utf-8"))

    assert response.status_code == 422
    assert payload["error"] == "VALIDATION_ERROR"
    assert payload["status"] == 422
    assert payload["traceId"] == "trace-validation-1"
    assert payload["details"]["errors"][0]["type"] == "missing"


def test_generic_exception_returns_internal_error_without_sensitive_text():
    request = _make_request("/api/meeting/1/transcript", trace_id="trace-generic-1")
    response = asyncio.run(
        main_module.global_exception_handler(
            request, RuntimeError("secret token=abc123 should not leak")
        )
    )
    payload = json.loads(response.body.decode("utf-8"))

    assert response.status_code == 500
    assert payload["error"] == "INTERNAL_ERROR"
    assert payload["message"] == "Unexpected server error"
    assert "token=abc123" not in json.dumps(payload)
    assert payload["traceId"] == "trace-generic-1"


def test_analysis_provider_exception_maps_to_gemini_unavailable():
    request = _make_request(
        "/api/internal/realtime-analysis", trace_id="trace-provider-1"
    )
    exception = main_module.AnalysisConfigError(
        "missing gemini config", provider="gemini"
    )

    response = asyncio.run(
        main_module.analysis_provider_exception_handler(request, exception)
    )
    payload = json.loads(response.body.decode("utf-8"))

    assert response.status_code == 503
    assert payload["error"] == "GEMINI_UNAVAILABLE"
    assert payload["traceId"] == "trace-provider-1"
    assert payload["details"]["provider"] == "gemini"
