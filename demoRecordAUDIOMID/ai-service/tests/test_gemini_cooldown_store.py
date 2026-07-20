"""Offline tests for Gemini cooldown merge policy and shared stores."""

from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.services.gemini_cooldown_merge import CooldownMetadata, merge_cooldown_states
from app.services.gemini_key_cooldown_store import (
    DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS,
    GeminiKeyScope,
    InMemoryGeminiKeyCooldownStore,
    LegacyGeminiCooldownStoreAdapter,
    RedisGeminiKeyCooldownStore,
    build_redis_gemini_cooldown_store,
    decode_cooldown_payload,
    encode_cooldown_payload,
    key_fingerprint,
    resolve_shared_state_namespace,
    store_supports_cooldown_metadata,
)
from app.services.gemini_key_manager import GeminiKeyManager


class FakeWallClock:
    def __init__(self, start_ms: int = 1_700_000_000_000) -> None:
        self._ms = int(start_ms)

    def now_ms(self) -> int:
        return self._ms

    def advance_ms(self, delta: int) -> None:
        self._ms += int(delta)


class FakeRedis:
    """Minimal Redis double with overwrite semantics and Lua merge hook."""

    def __init__(self, *, wall_clock: FakeWallClock | None = None) -> None:
        self._wall_clock = wall_clock or FakeWallClock()
        self._values: dict[str, tuple[int, str]] = {}
        self._lock = threading.RLock()

    def _now_ms(self) -> int:
        return self._wall_clock.now_ms()

    def get(self, key: str):
        with self._lock:
            entry = self._values.get(key)
            if entry is None:
                return None
            expires_at_ms, value = entry
            if expires_at_ms <= self._now_ms():
                self._values.pop(key, None)
                return None
            return value

    def pttl(self, key: str) -> int:
        with self._lock:
            entry = self._values.get(key)
            if entry is None:
                return -2
            expires_at_ms, _value = entry
            remaining = expires_at_ms - self._now_ms()
            if remaining <= 0:
                self._values.pop(key, None)
                return -2
            return remaining

    def ttl(self, key: str) -> int:
        pttl = self.pttl(key)
        if pttl < 0:
            return pttl
        return max(0, int((pttl + 999) / 1000))

    def setex(self, key: str, ttl_seconds: int, value: str) -> None:
        with self._lock:
            expires_at_ms = self._now_ms() + int(ttl_seconds) * 1000
            self._values[key] = (expires_at_ms, str(value))

    def psetex(self, key: str, ttl_ms: int, value: str) -> None:
        with self._lock:
            expires_at_ms = self._now_ms() + int(ttl_ms)
            self._values[key] = (expires_at_ms, str(value))

    def delete(self, key: str) -> None:
        with self._lock:
            self._values.pop(key, None)

    def exists(self, key: str) -> int:
        return 1 if self.get(key) is not None else 0

    def eval(self, script: str, numkeys: int, *args):
        del script
        key = args[0]
        incoming_json = args[1]
        incoming_ttl_ms = int(args[2])
        now_ms = int(args[3])
        incoming = decode_cooldown_payload(incoming_json, now_ms=now_ms)
        assert incoming is not None
        incoming = CooldownMetadata(
            reason=incoming.reason,
            cooldown_type=incoming.cooldown_type,
            expires_at_ms=now_ms + incoming_ttl_ms,
        )
        current_raw = self.get(key)
        current = decode_cooldown_payload(current_raw, now_ms=now_ms)
        if current is not None and int(current.expires_at_ms or 0) <= now_ms:
            current = None
        merged = merge_cooldown_states(current, incoming, now_ms=now_ms)
        payload = encode_cooldown_payload(merged)
        ttl_ms = max(1, int(merged.expires_at_ms) - now_ms)
        self.psetex(key, ttl_ms, payload)
        return payload

    def register_script(self, script: str):
        redis = self

        class _Script:
            def __call__(self, *, keys, args):
                return redis.eval(script, len(keys), keys[0], *args)

        return _Script()


def _scope(alias: str, secret: str) -> GeminiKeyScope:
    return GeminiKeyScope(alias=alias, fingerprint=key_fingerprint(secret))


@pytest.mark.parametrize(
    ("existing", "incoming", "expected_reason", "expected_type"),
    [
        (
            CooldownMetadata("rate_limit", "soft", 1_700_000_900_000),
            CooldownMetadata("billing_credits_depleted", "hard", 1_700_000_090_000),
            "billing_credits_depleted",
            "hard",
        ),
        (
            CooldownMetadata("billing_credits_depleted", "hard", 1_700_000_900_000),
            CooldownMetadata("rate_limit", "soft", 1_700_000_030_000),
            "billing_credits_depleted",
            "hard",
        ),
        (
            CooldownMetadata("cooldown", "soft", 1_700_000_900_000),
            CooldownMetadata("rate_limit", "soft", 1_700_000_900_000),
            "rate_limit",
            "soft",
        ),
    ],
)
def test_merge_cooldown_states_priority(existing, incoming, expected_reason, expected_type):
    now_ms = 1_700_000_000_000
    merged = merge_cooldown_states(existing, incoming, now_ms=now_ms)
    assert merged.reason == expected_reason
    assert merged.cooldown_type == expected_type
    assert merged.expires_at_ms >= max(existing.expires_at_ms, incoming.expires_at_ms)


def test_inmemory_soft_to_hard_equal_ttl():
    clock = FakeWallClock()
    store = InMemoryGeminiKeyCooldownStore(
        wall_clock_ms=clock.now_ms,
        namespace="test:ai-service",
    )
    scope = _scope("primary", "fake-primary-key")
    store.apply_cooldown(
        scope, seconds=900, reason="rate_limit", cooldown_type="soft", now_ms=clock.now_ms()
    )
    store.apply_cooldown(
        scope,
        seconds=900,
        reason="billing_credits_depleted",
        cooldown_type="hard",
        now_ms=clock.now_ms(),
    )
    state = store.get_cooldown_state(scope, now=0.0, now_ms=clock.now_ms())
    assert state is not None
    assert state.reason == "billing_credits_depleted"
    assert state.cooldown_type == "hard"


def test_redis_soft_to_hard_shorter_incoming_ttl():
    clock = FakeWallClock()
    redis = FakeRedis(wall_clock=clock)
    store = RedisGeminiKeyCooldownStore(
        redis,
        namespace="test:ai-service",
        wall_clock_ms=clock.now_ms,
    )
    scope = _scope("backup1", "fake-backup-key")
    store.apply_cooldown(
        scope, seconds=900, reason="rate_limit", cooldown_type="soft", now_ms=clock.now_ms()
    )
    store.apply_cooldown(
        scope,
        seconds=90,
        reason="billing_credits_depleted",
        cooldown_type="hard",
        now_ms=clock.now_ms(),
    )
    state = store.get_cooldown_state(scope, now=0.0, now_ms=clock.now_ms())
    assert state is not None
    assert state.reason == "billing_credits_depleted"
    assert state.cooldown_type == "hard"
    assert state.remaining_seconds >= 890


def test_redis_concurrent_soft_and_hard_merge():
    clock = FakeWallClock()
    redis = FakeRedis(wall_clock=clock)
    store = RedisGeminiKeyCooldownStore(
        redis, namespace="test:ai-service", wall_clock_ms=clock.now_ms
    )
    scope = _scope("primary", "fake-primary-key")
    barrier = threading.Barrier(2)

    def soft_worker() -> None:
        barrier.wait()
        store.apply_cooldown(
            scope, seconds=900, reason="rate_limit", cooldown_type="soft", now_ms=clock.now_ms()
        )

    def hard_worker() -> None:
        barrier.wait()
        store.apply_cooldown(
            scope,
            seconds=900,
            reason="billing_credits_depleted",
            cooldown_type="hard",
            now_ms=clock.now_ms(),
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda fn: fn(), [soft_worker, hard_worker]))

    state = store.get_cooldown_state(scope, now=0.0, now_ms=clock.now_ms())
    assert state is not None
    assert state.cooldown_type == "hard"
    assert state.reason == "billing_credits_depleted"


def test_key_rotation_does_not_inherit_cooldown():
    clock = FakeWallClock()
    store = InMemoryGeminiKeyCooldownStore(
        wall_clock_ms=clock.now_ms, namespace="test:ai-service"
    )
    scope_a = _scope("backup1", "fake-backup-key")
    scope_b = _scope("backup1", "fake-rotated-key")
    store.apply_cooldown(
        scope_a,
        seconds=900,
        reason="billing_credits_depleted",
        cooldown_type="hard",
        now_ms=clock.now_ms(),
    )
    assert store.get_cooldown_state(scope_b, now=0.0, now_ms=clock.now_ms()) is None


def test_environment_namespace_isolation():
    clock = FakeWallClock()
    store_a = InMemoryGeminiKeyCooldownStore(
        wall_clock_ms=clock.now_ms, namespace="dev:ai-service"
    )
    store_b = InMemoryGeminiKeyCooldownStore(
        wall_clock_ms=clock.now_ms, namespace="prod:ai-service"
    )
    scope = _scope("primary", "fake-primary-key")
    store_a.apply_cooldown(
        scope, seconds=900, reason="rate_limit", cooldown_type="soft", now_ms=clock.now_ms()
    )
    assert store_b.get_cooldown_state(scope, now=0.0, now_ms=clock.now_ms()) is None


def test_redis_keys_do_not_contain_raw_secret():
    clock = FakeWallClock()
    redis = FakeRedis(wall_clock=clock)
    store = RedisGeminiKeyCooldownStore(
        redis, namespace="test:ai-service", wall_clock_ms=clock.now_ms
    )
    secret = "fake-primary-key"
    scope = _scope("primary", secret)
    store.apply_cooldown(
        scope, seconds=30, reason="rate_limit", cooldown_type="soft", now_ms=clock.now_ms()
    )
    rendered = json.dumps({k: v[1] for k, v in redis._values.items()})
    assert secret not in rendered
    assert key_fingerprint(secret) in rendered


def test_model_unsupported_ttl_and_expiry():
    clock = FakeWallClock()
    store = InMemoryGeminiKeyCooldownStore(
        wall_clock_ms=clock.now_ms,
        namespace="test:ai-service",
        model_unsupported_ttl_seconds=60,
    )
    scope = _scope("primary", "fake-primary-key")
    store.mark_model_unsupported(scope, "gemini-2.5-flash", now_ms=clock.now_ms())
    assert store.is_model_unsupported(scope, "gemini-2.5-flash", now_ms=clock.now_ms())
    clock.advance_ms(61_000)
    assert not store.is_model_unsupported(
        scope, "gemini-2.5-flash", now_ms=clock.now_ms()
    )


def test_success_clears_model_unsupported_marker():
    clock = FakeWallClock()
    store = InMemoryGeminiKeyCooldownStore(
        wall_clock_ms=clock.now_ms, namespace="test:ai-service"
    )
    scope = _scope("primary", "fake-primary-key")
    store.mark_model_unsupported(scope, "gemini-2.5-flash", now_ms=clock.now_ms())
    store.clear_model_unsupported(scope, "gemini-2.5-flash")
    assert not store.is_model_unsupported(
        scope, "gemini-2.5-flash", now_ms=clock.now_ms()
    )


def test_legacy_redis_value_one_is_readable():
    metadata = decode_cooldown_payload("1", now_ms=1_700_000_000_000)
    assert metadata is not None
    assert metadata.reason == "cooldown"
    assert metadata.cooldown_type == "soft"


class LegacyDurationOnlyCooldownStore:
    def cooldown_remaining(self, alias: str, *, now: float) -> float:
        del now
        return float(getattr(self, "_remaining", {}).get(alias, 0.0))

    def apply_cooldown(self, alias: str, *, seconds: float) -> None:
        remaining = getattr(self, "_remaining", {})
        remaining[alias] = max(float(remaining.get(alias, 0.0)), float(seconds or 0.0))
        self._remaining = remaining


def test_legacy_store_exact_signature_does_not_crash():
    legacy = LegacyDurationOnlyCooldownStore()
    assert not store_supports_cooldown_metadata(legacy)
    adapter = LegacyGeminiCooldownStoreAdapter(legacy)
    scope = _scope("primary", "fake-primary-key")
    adapter.apply_cooldown(
        scope,
        seconds=30,
        reason="billing_credits_depleted",
        cooldown_type="hard",
    )
    assert adapter.cooldown_remaining(scope, now=0.0) == 30.0
    state = adapter.get_cooldown_state(scope, now=0.0)
    assert state is not None
    assert state.reason == "cooldown"
    assert state.cooldown_type == "soft"


def test_redis_outage_write_keeps_local_manager_state():
    class BrokenRedis:
        def eval(self, *args, **kwargs):
            raise ConnectionError("redis down")

        def register_script(self, script):
            del script

            class _Script:
                def __call__(self, *, keys, args):
                    raise ConnectionError("redis down")

            return _Script()

        def get(self, *args, **kwargs):
            raise ConnectionError("redis down")

        def pttl(self, *args, **kwargs):
            raise ConnectionError("redis down")

        def delete(self, *args, **kwargs):
            raise ConnectionError("redis down")

        def setex(self, *args, **kwargs):
            raise ConnectionError("redis down")

        def exists(self, *args, **kwargs):
            raise ConnectionError("redis down")

    store = RedisGeminiKeyCooldownStore(BrokenRedis(), namespace="test:ai-service")
    manager = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        gemini_api_keys="",
        multi_key_enabled=False,
        cooldown_store=store,
    )
    manager.hard_cooldown_key(
        "primary", seconds=900, reason="billing_credits_depleted"
    )
    selection = manager.select_key(model="gemini-2.5-flash")
    assert selection.available is False
    assert selection.unavailable_reasons.get("primary") == "billing_credits_depleted"


def test_build_redis_store_namespace_from_settings(monkeypatch):
    from app.config import Settings, get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.setenv("APP_COMPONENT", "worker")
    settings = Settings()
    namespace = resolve_shared_state_namespace(
        app_env=settings.app_env,
        service_name=settings.app_component,
        explicit_namespace=settings.gemini_shared_state_namespace,
    )
    assert namespace == "staging:worker"
    store = build_redis_gemini_cooldown_store(FakeRedis(), settings=settings)
    assert store.namespace == "staging:worker"
    assert store.model_unsupported_ttl_seconds == DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS
    get_settings.cache_clear()
