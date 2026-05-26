import asyncio
import json

import app.main as main_module
from fastapi.responses import JSONResponse


class _FakeConnection:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, _query):
        return 1


class _FakeEngine:
    def connect(self):
        return _FakeConnection()


class _FailingEngine:
    def connect(self):
        raise RuntimeError("db unavailable")


class _HealthyRedisClient:
    def ping(self):
        return True


class _FailingRedisClient:
    def ping(self):
        raise RuntimeError("redis unavailable")


async def _noop_cleanup():
    return None


def test_health_returns_standardized_payload(monkeypatch):
    monkeypatch.setattr(main_module, "_cleanup_stale_stt_actors", _noop_cleanup)
    monkeypatch.setattr(main_module, "_stt_registry_summary", lambda: {"total": 0})

    payload = asyncio.run(main_module.health_check())

    assert payload["status"] == "UP"
    assert payload["service"] == "ai-service"
    assert payload["legacyStatus"] == "healthy"
    assert payload["dependencies"] == {}
    assert payload["timestamp"].endswith("Z")


def test_ready_returns_up_when_required_dependencies_are_available(monkeypatch):
    monkeypatch.setattr(main_module, "_cleanup_stale_stt_actors", _noop_cleanup)
    monkeypatch.setattr(main_module, "_stt_registry_summary", lambda: {"total": 1})
    monkeypatch.setattr(main_module, "engine", _FakeEngine())
    monkeypatch.setattr(main_module, "_get_client", lambda: _HealthyRedisClient())
    monkeypatch.setattr(main_module, "pipeline", object())
    monkeypatch.setattr(main_module.settings, "stt_provider", "local_whisper")
    monkeypatch.setattr(main_module.settings, "analysis_provider", "openai")
    monkeypatch.setattr(main_module.settings, "deepgram_api_key", "")
    monkeypatch.setattr(main_module.settings, "gemini_api_key", "gm-secret-value")

    payload = asyncio.run(main_module.readiness_check())

    assert payload["status"] == "UP"
    assert payload["service"] == "ai-service"
    assert payload["legacyStatus"] == "ready"
    assert payload["dependencies"]["database"] == "UP"
    assert payload["dependencies"]["redis"] == "UP"
    assert payload["dependencies"]["pipeline"] == "UP"
    assert payload["dependencies"]["deepgramConfigured"] == "DOWN"
    assert payload["dependencies"]["geminiConfigured"] == "UP"
    assert "gm-secret-value" not in json.dumps(payload)


def test_ready_returns_503_with_down_payload_when_checks_fail(monkeypatch):
    monkeypatch.setattr(main_module, "_cleanup_stale_stt_actors", _noop_cleanup)
    monkeypatch.setattr(main_module, "_stt_registry_summary", lambda: {"total": 0})
    monkeypatch.setattr(main_module, "engine", _FailingEngine())
    monkeypatch.setattr(main_module, "_get_client", lambda: _FailingRedisClient())
    monkeypatch.setattr(main_module, "pipeline", None)
    monkeypatch.setattr(main_module.settings, "stt_provider", "deepgram")
    monkeypatch.setattr(main_module.settings, "analysis_provider", "gemini")
    monkeypatch.setattr(main_module.settings, "deepgram_api_key", "")
    monkeypatch.setattr(main_module.settings, "gemini_api_key", "")

    response = asyncio.run(main_module.readiness_check())

    assert isinstance(response, JSONResponse)
    assert response.status_code == 503

    payload = json.loads(response.body.decode("utf-8"))
    assert payload["status"] == "DOWN"
    assert payload["service"] == "ai-service"
    assert payload["legacyStatus"] == "not_ready"
    assert payload["dependencies"]["database"] == "DOWN"
    assert payload["dependencies"]["redis"] == "DOWN"
    assert payload["dependencies"]["pipeline"] == "DOWN"
    assert payload["dependencies"]["deepgramConfigured"] == "DOWN"
    assert payload["dependencies"]["geminiConfigured"] == "DOWN"
