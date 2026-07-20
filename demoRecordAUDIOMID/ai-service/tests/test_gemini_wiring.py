"""Offline wiring tests for shared Gemini cooldown namespace."""

from __future__ import annotations

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
