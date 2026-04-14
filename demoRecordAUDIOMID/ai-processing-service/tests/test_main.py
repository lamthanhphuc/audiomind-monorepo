import asyncio
import importlib.util
import json
from pathlib import Path

import pytest


MODULE_PATH = Path(__file__).resolve().parents[1] / "app" / "main.py"
SPEC = importlib.util.spec_from_file_location("ai_processing_main", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


@pytest.fixture(autouse=True)
def reset_env(monkeypatch):
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("WHISPER_SERVICE_URL", raising=False)
    monkeypatch.delenv("DIARIZATION_SERVICE_URL", raising=False)
    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)


def test_validate_runtime_configuration_allows_non_production():
    MODULE.validate_runtime_configuration()


def test_validate_runtime_configuration_requires_urls_in_production(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")

    with pytest.raises(RuntimeError) as exc_info:
        MODULE.validate_runtime_configuration()

    message = str(exc_info.value)
    assert "WHISPER_SERVICE_URL" in message
    assert "DIARIZATION_SERVICE_URL" in message
    assert "OLLAMA_BASE_URL" in message


def test_validate_runtime_configuration_passes_with_required_prod_env(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("WHISPER_SERVICE_URL", "http://whisper-service:8011")
    monkeypatch.setenv("DIARIZATION_SERVICE_URL", "http://diarization-service:8012")
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ollama-service:11434")

    MODULE.validate_runtime_configuration()


def test_startup_event_calls_runtime_hooks(monkeypatch):
    called = {"dirs": False, "validation": False}

    def fake_dirs() -> None:
        called["dirs"] = True

    def fake_validation() -> None:
        called["validation"] = True

    monkeypatch.setattr(MODULE, "ensure_runtime_dirs", fake_dirs)
    monkeypatch.setattr(MODULE, "validate_runtime_configuration", fake_validation)

    MODULE.startup_event()

    assert called["dirs"]
    assert called["validation"]


def test_global_exception_handler_returns_sanitized_payload():
    response = asyncio.run(MODULE.global_exception_handler(None, Exception("secret-detail")))

    body = json.loads(response.body.decode("utf-8"))
    assert response.status_code == 500
    assert body["code"] == "INTERNAL_SERVER_ERROR"
    assert body["message"] == "Unexpected server error"
    assert body.get("trace_id")
    assert "secret-detail" not in json.dumps(body)
