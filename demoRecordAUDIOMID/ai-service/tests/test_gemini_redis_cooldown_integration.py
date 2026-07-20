"""Real Redis integration tests for shared Gemini cooldown Lua merge."""

from __future__ import annotations

import json
import time

import pytest

pytestmark = pytest.mark.redis_integration

pytest.importorskip("testcontainers")


def _docker_available() -> bool:
    try:
        import docker
    except ImportError:
        return False
    try:
        docker.from_env().ping()
        return True
    except (docker.errors.DockerException, OSError):
        return False


@pytest.fixture(scope="module")
def redis_client():
    if not _docker_available():
        pytest.skip("Docker/Redis integration unavailable")

    try:
        from testcontainers.redis import RedisContainer
    except ImportError:
        pytest.skip("testcontainers not installed")

    try:
        import docker
        import redis as redis_lib

        with RedisContainer("redis:7-alpine") as container:
            host = container.get_container_host_ip()
            port = container.get_exposed_port(6379)
            client = redis_lib.Redis.from_url(
                f"redis://{host}:{port}/0",
                decode_responses=True,
            )
            yield client
    except docker.errors.DockerException:
        pytest.skip("Docker/Redis integration unavailable")


@pytest.fixture(autouse=True)
def clean_redis(redis_client):
    redis_client.flushdb()
    yield
    redis_client.flushdb()


def _scope(alias: str = "primary", secret: str = "fake-primary-key"):
    from app.services.gemini_key_cooldown_store import (
        GeminiKeyScope,
        key_fingerprint,
    )

    return GeminiKeyScope(alias=alias, fingerprint=key_fingerprint(secret))


def _store(redis_client, request, *, wall_clock_ms=None):
    from app.services.gemini_key_cooldown_store import RedisGeminiKeyCooldownStore

    namespace = f"integration-test:{request.node.name}"
    kwargs = {"namespace": namespace}
    if wall_clock_ms is not None:
        kwargs["wall_clock_ms"] = wall_clock_ms
    return RedisGeminiKeyCooldownStore(redis_client, **kwargs)


def test_redis_lua_soft_to_hard_merge_preserves_longer_ttl(redis_client, request) -> None:
    store = _store(redis_client, request)
    scope = _scope()
    store.apply_cooldown(
        scope, seconds=0.9, reason="rate_limit", cooldown_type="soft", now_ms=1_700_000_000_000
    )
    store.apply_cooldown(
        scope,
        seconds=0.09,
        reason="billing_credits_depleted",
        cooldown_type="hard",
        now_ms=1_700_000_000_000,
    )
    state = store.get_cooldown_state(scope, now=0.0, now_ms=1_700_000_000_000)
    assert state is not None
    assert state.reason == "billing_credits_depleted"
    assert state.cooldown_type == "hard"
    assert state.remaining_seconds >= 0.8


def test_redis_lua_hard_not_downgraded_by_soft(redis_client, request) -> None:
    store = _store(redis_client, request)
    scope = _scope()
    store.apply_cooldown(
        scope,
        seconds=0.9,
        reason="billing_credits_depleted",
        cooldown_type="hard",
        now_ms=1_700_000_000_000,
    )
    store.apply_cooldown(
        scope,
        seconds=0.9,
        reason="rate_limit",
        cooldown_type="soft",
        now_ms=1_700_000_000_000,
    )
    state = store.get_cooldown_state(scope, now=0.0, now_ms=1_700_000_000_000)
    assert state is not None
    assert state.reason == "billing_credits_depleted"
    assert state.cooldown_type == "hard"


def test_redis_lua_specific_terminal_beats_generic(redis_client, request) -> None:
    store = _store(redis_client, request)
    scope = _scope()
    store.apply_cooldown(
        scope,
        seconds=0.9,
        reason="billing_credits_depleted",
        cooldown_type="hard",
        now_ms=1_700_000_000_000,
    )
    store.apply_cooldown(
        scope,
        seconds=0.9,
        reason="terminal_unknown",
        cooldown_type="hard",
        now_ms=1_700_000_000_000,
    )
    state = store.get_cooldown_state(scope, now=0.0, now_ms=1_700_000_000_000)
    assert state is not None
    assert state.reason == "billing_credits_depleted"


def test_redis_lua_rate_limit_beats_generic_cooldown(redis_client, request) -> None:
    store = _store(redis_client, request)
    scope = _scope()
    store.apply_cooldown(
        scope, seconds=0.9, reason="cooldown", cooldown_type="soft", now_ms=1_700_000_000_000
    )
    store.apply_cooldown(
        scope, seconds=0.9, reason="rate_limit", cooldown_type="soft", now_ms=1_700_000_000_000
    )
    state = store.get_cooldown_state(scope, now=0.0, now_ms=1_700_000_000_000)
    assert state is not None
    assert state.reason == "rate_limit"


def test_redis_legacy_one_payload_with_pttl(redis_client, request) -> None:
    store = _store(redis_client, request)
    scope = _scope()
    key = store._cooldown_key(scope)
    redis_client.psetex(key, 300, "1")
    state = store.get_cooldown_state(scope, now=0.0, now_ms=1_700_000_000_000)
    assert state is not None
    assert 0.2 <= state.remaining_seconds <= 0.35
    assert state.reason == "cooldown"
    store.apply_cooldown(
        scope, seconds=0.2, reason="rate_limit", cooldown_type="soft", now_ms=1_700_000_000_000
    )
    raw = redis_client.get(key)
    assert raw is not None
    assert raw != "1"
    assert "version" in raw


def test_redis_pttl_source_of_truth_under_clock_skew(redis_client, request) -> None:
    scope = _scope()
    key = _store(redis_client, request)._cooldown_key(scope)
    payload = json.dumps(
        {
            "version": 2,
            "expires_at_ms": 1_800_000_000_000,
            "reason": "rate_limit",
            "cooldown_type": "soft",
        }
    )
    redis_client.psetex(key, 300, payload)

    fast_ms = 1_800_000_000_000
    slow_ms = fast_ms + 600_000
    fast_store = _store(redis_client, request, wall_clock_ms=lambda: fast_ms)
    slow_store = _store(redis_client, request, wall_clock_ms=lambda: slow_ms)

    fast_state = fast_store.get_cooldown_state(scope, now=0.0, now_ms=fast_ms)
    slow_state = slow_store.get_cooldown_state(scope, now=0.0, now_ms=slow_ms)

    assert fast_state is not None
    assert slow_state is not None
    assert 0.2 <= fast_state.remaining_seconds <= 0.35
    assert 0.2 <= slow_state.remaining_seconds <= 0.35
    assert fast_state.reason == "rate_limit"
    assert slow_state.reason == "rate_limit"


def test_redis_cooldown_expires_without_sleep(redis_client, request) -> None:
    from app.services.gemini_key_manager import GeminiKeyEntry, GeminiKeyManager

    store = _store(redis_client, request)
    entry = GeminiKeyEntry(alias="primary", secret="fake-primary-key")
    manager_a = GeminiKeyManager([entry], cooldown_store=store)
    manager_b = GeminiKeyManager([entry], cooldown_store=store)

    manager_a.cooldown_key("primary", seconds=0.15, reason="rate_limit")
    assert manager_b.select_key().available is False

    deadline = time.monotonic() + 1.0
    while time.monotonic() < deadline:
        if manager_b.select_key().available:
            break
        time.sleep(0.02)
    assert manager_b.select_key().available is True
