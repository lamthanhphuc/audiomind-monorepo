"""Offline wiring tests for shared Gemini cooldown namespace."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services.gemini_key_cooldown_store import (
    GeminiKeyScope,
    build_redis_gemini_cooldown_store,
    key_fingerprint,
    resolve_shared_state_namespace,
)
from tests.test_gemini_cooldown_store import FakeRedis


def test_api_and_worker_share_default_namespace(monkeypatch) -> None:
    from app.config import Settings, get_settings

    get_settings.cache_clear()
    monkeypatch.delenv("GEMINI_SHARED_STATE_NAMESPACE", raising=False)
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.setenv("APP_COMPONENT", "api")
    api_settings = Settings(_env_file=None)
    monkeypatch.setenv("APP_COMPONENT", "worker")
    worker_settings = Settings(_env_file=None)

    api_namespace = resolve_shared_state_namespace(
        app_env=api_settings.app_env,
        explicit_namespace=api_settings.gemini_shared_state_namespace,
    )
    worker_namespace = resolve_shared_state_namespace(
        app_env=worker_settings.app_env,
        explicit_namespace=worker_settings.gemini_shared_state_namespace,
    )
    assert api_namespace == "staging:ai-service"
    assert worker_namespace == "staging:ai-service"
    get_settings.cache_clear()


def test_different_environments_have_different_namespaces(monkeypatch) -> None:
    monkeypatch.delenv("GEMINI_SHARED_STATE_NAMESPACE", raising=False)
    prod = resolve_shared_state_namespace(app_env="prod")
    staging = resolve_shared_state_namespace(app_env="staging")
    assert prod != staging


def test_explicit_namespace_override_is_used(monkeypatch) -> None:
    from app.config import Settings, get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("GEMINI_SHARED_STATE_NAMESPACE", "custom:namespace")
    settings = Settings(_env_file=None)
    namespace = resolve_shared_state_namespace(
        app_env=settings.app_env,
        explicit_namespace=settings.gemini_shared_state_namespace,
    )
    assert namespace == "custom:namespace"
    get_settings.cache_clear()


def test_build_store_does_not_embed_raw_key_in_redis_key() -> None:
    from app.config import Settings

    settings = Settings(
        _env_file=None,
        app_env="offline-test",
        gemini_shared_state_namespace="offline-test:ai-service",
    )
    redis = FakeRedis()
    store = build_redis_gemini_cooldown_store(redis, settings=settings)
    secret = "fake-primary-key"
    scope = GeminiKeyScope(alias="primary", fingerprint=key_fingerprint(secret))
    store.apply_cooldown(
        scope,
        seconds=30,
        reason="rate_limit",
        cooldown_type="soft",
        now_ms=1_700_000_000_000,
    )
    rendered = str(redis._values)
    assert secret not in rendered
    assert key_fingerprint(secret) in rendered


def test_single_key_mode_still_wires_shared_redis_store(monkeypatch) -> None:
    from app.config import get_settings
    from app.services.gemini_analyzer import GeminiAnalyzer
    from app.services.gemini_shared_state_store import InMemoryV2GeminiKeyCooldownStore

    get_settings.cache_clear()
    monkeypatch.setenv("GEMINI_SHARED_COOLDOWN_ENABLED", "true")
    shared_store = InMemoryV2GeminiKeyCooldownStore(
        namespace="test:single-key",
        allowed_aliases=frozenset({"primary"}),
    )
    redis_sentinel = object()
    monkeypatch.setattr(
        "app.services.gemini_key_cooldown_store.create_gemini_redis_client",
        lambda *args, **kwargs: redis_sentinel,
    )
    monkeypatch.setattr(
        "app.services.gemini_shared_state_store.build_v2_redis_gemini_cooldown_store",
        lambda client, **kwargs: shared_store
        if client is redis_sentinel
        else pytest.fail("unexpected Redis client"),
    )

    try:
        analyzer = GeminiAnalyzer(
            api_key="fake-primary-key",
            gemini_multi_key_enabled=False,
            http_client_factory=lambda timeout: None,
        )

        assert analyzer.gemini_key_manager is not None
        assert analyzer.gemini_key_manager._cooldown_store is shared_store
        assert [entry.alias for entry in analyzer.gemini_key_manager.entries] == [
            "primary"
        ]
    finally:
        get_settings.cache_clear()


def test_redis_client_factory_wires_bounded_timeouts_without_retry(monkeypatch):
    import redis

    from app.services.gemini_key_cooldown_store import create_gemini_redis_client

    captured = {}
    sentinel = object()

    def fake_from_url(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return sentinel

    monkeypatch.setattr(redis.Redis, "from_url", fake_from_url)
    settings = SimpleNamespace(
        gemini_redis_connect_timeout_seconds=1.0,
        gemini_redis_socket_timeout_seconds=1.5,
    )

    client = create_gemini_redis_client(
        "redis://offline.invalid:6379/0", settings=settings
    )

    assert client is sentinel
    assert captured["socket_connect_timeout"] == 1.0
    assert captured["socket_timeout"] == 1.5
    assert captured["retry_on_timeout"] is False
    assert captured["decode_responses"] is True
