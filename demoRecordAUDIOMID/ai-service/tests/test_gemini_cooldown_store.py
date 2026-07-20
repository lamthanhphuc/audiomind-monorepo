"""Offline tests for Gemini cooldown merge policy and shared stores."""

from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.services.gemini_cooldown_merge import (
    CooldownMetadata,
    merge_cooldown_states,
    merge_cooldown_states_lua_semantics,
)
from app.services.gemini_key_cooldown_store import (
    DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS,
    GeminiKeyScope,
    InMemoryGeminiKeyCooldownStore,
    LegacyGeminiCooldownStoreAdapter,
    RedisGeminiKeyCooldownStore,
    SafeRedisResult,
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

    def __call__(self) -> float:
        return self._ms / 1000.0

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
            stored = value.decode("utf-8") if isinstance(value, bytes) else str(value)
            self._values[key] = (expires_at_ms, stored)

    def psetex(self, key: str, ttl_ms: int, value: str) -> None:
        with self._lock:
            expires_at_ms = self._now_ms() + int(ttl_ms)
            stored = value.decode("utf-8") if isinstance(value, bytes) else str(value)
            self._values[key] = (expires_at_ms, stored)

    def delete(self, key: str) -> None:
        with self._lock:
            self._values.pop(key, None)

    def exists(self, key: str) -> int:
        return 1 if self.get(key) is not None else 0

    def _peek_raw(self, key: str):
        with self._lock:
            entry = self._values.get(key)
            if entry is None:
                return None
            return entry[1]

    def _eval_read_cooldown(self, key: str):
        pttl = self.pttl(key)
        if pttl <= 0:
            return ["", pttl]
        raw = self._peek_raw(key)
        if raw is None:
            return ["", pttl]
        stored = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
        return [stored, pttl]

    def _eval_merge_cooldown(
        self, key: str, incoming_json: str, incoming_ttl_ms: int, now_ms: int
    ):
        current_pttl = self.pttl(key)
        if current_pttl <= 0:
            current = None
        else:
            current_raw = self._peek_raw(key)
            current = decode_cooldown_payload(
                current_raw,
                now_ms=now_ms,
                pttl_ms=current_pttl,
            )
        incoming = decode_cooldown_payload(incoming_json, now_ms=now_ms)
        assert incoming is not None
        incoming = CooldownMetadata(
            reason=incoming.reason,
            cooldown_type=incoming.cooldown_type,
            expires_at_ms=now_ms + incoming_ttl_ms,
        )
        merged = merge_cooldown_states_lua_semantics(
            current, incoming, now_ms=now_ms
        )
        payload = encode_cooldown_payload(merged)
        ttl_ms = max(1, int(merged.expires_at_ms) - now_ms)
        self.psetex(key, ttl_ms, payload)
        return payload

    def eval(self, script: str, numkeys: int, *args):
        del script
        if numkeys == 1 and len(args) == 1:
            return self._eval_read_cooldown(args[0])
        if numkeys == 1 and len(args) == 4:
            return self._eval_merge_cooldown(
                args[0], args[1], int(args[2]), int(args[3])
            )
        raise NotImplementedError("unsupported FakeRedis eval script")

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


def test_legacy_redis_value_one_requires_pttl():
    now_ms = 1_700_000_000_000
    assert decode_cooldown_payload("1", now_ms=now_ms) is None
    metadata = decode_cooldown_payload("1", now_ms=now_ms, pttl_ms=30_000)
    assert metadata is not None
    assert metadata.reason == "cooldown"
    assert metadata.cooldown_type == "soft"
    assert metadata.expires_at_ms == now_ms + 30_000


def test_legacy_redis_value_one_via_store_get_cooldown_state():
    clock = FakeWallClock()
    redis = FakeRedis(wall_clock=clock)
    store = RedisGeminiKeyCooldownStore(
        redis, namespace="test:ai-service", wall_clock_ms=clock.now_ms
    )
    scope = _scope("primary", "fake-primary-key")
    key = store._cooldown_key(scope)
    redis.setex(key, 30, "1")
    state = store.get_cooldown_state(scope, now=0.0, now_ms=clock.now_ms())
    assert state is not None
    assert 25 <= state.remaining_seconds <= 30
    assert state.reason == "cooldown"
    assert key in redis._values


def test_legacy_redis_bytes_value_one_via_store():
    clock = FakeWallClock()
    redis = FakeRedis(wall_clock=clock)
    store = RedisGeminiKeyCooldownStore(
        redis, namespace="test:ai-service", wall_clock_ms=clock.now_ms
    )
    scope = _scope("primary", "fake-primary-key")
    key = store._cooldown_key(scope)
    redis.setex(key, 30, b"1")
    state = store.get_cooldown_state(scope, now=0.0, now_ms=clock.now_ms())
    assert state is not None
    assert state.reason == "cooldown"


def test_legacy_redis_value_one_expired_is_cleaned_up():
    clock = FakeWallClock()
    redis = FakeRedis(wall_clock=clock)
    store = RedisGeminiKeyCooldownStore(
        redis, namespace="test:ai-service", wall_clock_ms=clock.now_ms
    )
    scope = _scope("primary", "fake-primary-key")
    key = store._cooldown_key(scope)
    redis._values[key] = (clock.now_ms(), "1")
    state = store.get_cooldown_state(scope, now=0.0, now_ms=clock.now_ms())
    assert state is None


def test_legacy_value_migrates_to_json_on_update():
    clock = FakeWallClock()
    redis = FakeRedis(wall_clock=clock)
    store = RedisGeminiKeyCooldownStore(
        redis, namespace="test:ai-service", wall_clock_ms=clock.now_ms
    )
    scope = _scope("primary", "fake-primary-key")
    key = store._cooldown_key(scope)
    redis.setex(key, 60, "1")
    store.apply_cooldown(
        scope,
        seconds=30,
        reason="rate_limit",
        cooldown_type="soft",
        now_ms=clock.now_ms(),
    )
    raw = redis.get(key)
    assert raw is not None
    assert raw != "1"
    assert "version" in raw


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


def test_safe_redis_successful_write_returning_none_does_not_log_warning(caplog):
    import logging

    clock = FakeWallClock()
    redis = FakeRedis(wall_clock=clock)
    store = RedisGeminiKeyCooldownStore(
        redis, namespace="test:ai-service", wall_clock_ms=clock.now_ms
    )
    scope = _scope("primary", "fake-primary-key")

    with caplog.at_level(logging.WARNING):
        store.apply_cooldown(
            scope,
            seconds=30,
            reason="rate_limit",
            cooldown_type="soft",
            now_ms=clock.now_ms(),
        )
    assert "GEMINI_SHARED_STATE_WRITE_FAILED" not in caplog.text


def test_safe_redis_missing_key_read_does_not_log_read_failed(caplog):
    import logging

    clock = FakeWallClock()
    redis = FakeRedis(wall_clock=clock)
    store = RedisGeminiKeyCooldownStore(
        redis, namespace="test:ai-service", wall_clock_ms=clock.now_ms
    )
    scope = _scope("primary", "fake-primary-key")
    with caplog.at_level(logging.WARNING):
        state = store.get_cooldown_state(scope, now=0.0, now_ms=clock.now_ms())
    assert state is None
    assert "GEMINI_SHARED_STATE_READ_FAILED" not in caplog.text


def test_safe_redis_result_contract():
    result = SafeRedisResult(success=True, value=None)
    assert result.success
    assert result.value is None
    assert result.error is None


def test_build_redis_store_namespace_from_settings(monkeypatch):
    from app.config import Settings, get_settings

    get_settings.cache_clear()
    monkeypatch.delenv("GEMINI_SHARED_STATE_NAMESPACE", raising=False)
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.setenv("APP_COMPONENT", "worker")
    settings = Settings(_env_file=None)
    namespace = resolve_shared_state_namespace(
        app_env=settings.app_env,
        explicit_namespace=settings.gemini_shared_state_namespace,
    )
    assert namespace == "staging:ai-service"
    store = build_redis_gemini_cooldown_store(FakeRedis(), settings=settings)
    assert store.namespace == "staging:ai-service"
    assert store.model_unsupported_ttl_seconds == DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS
    get_settings.cache_clear()


def test_redis_pttl_is_source_of_truth_despite_fast_local_clock():
    redis_clock = FakeWallClock(start_ms=1_700_000_000_000)
    redis = FakeRedis(wall_clock=redis_clock)
    scope = _scope("primary", "fake-primary-key")
    key = f"gemini:test:ai-service:cooldown:{scope.alias}:{scope.fingerprint}"
    payload = json.dumps(
        {
            "version": 2,
            "expires_at_ms": 1_800_000_000_000,
            "reason": "rate_limit",
            "cooldown_type": "soft",
        }
    )
    redis.psetex(key, 30_000, payload)
    fast_store = RedisGeminiKeyCooldownStore(
        redis,
        namespace="test:ai-service",
        wall_clock_ms=lambda: 1_800_000_000_000,
    )
    state = fast_store.get_cooldown_state(scope, now=0.0)
    assert state is not None
    assert 25 <= state.remaining_seconds <= 30
    assert state.reason == "rate_limit"
    assert state.cooldown_type == "soft"


def test_redis_pttl_is_source_of_truth_despite_slow_local_clock():
    redis_clock = FakeWallClock(start_ms=1_700_000_000_000)
    redis = FakeRedis(wall_clock=redis_clock)
    scope = _scope("primary", "fake-primary-key")
    key = f"gemini:test:ai-service:cooldown:{scope.alias}:{scope.fingerprint}"
    payload = json.dumps(
        {
            "version": 2,
            "expires_at_ms": 1_700_000_000_000,
            "reason": "billing_credits_depleted",
            "cooldown_type": "hard",
        }
    )
    redis.psetex(key, 30_000, payload)
    slow_store = RedisGeminiKeyCooldownStore(
        redis,
        namespace="test:ai-service",
        wall_clock_ms=lambda: 1_700_600_000_000,
    )
    state = slow_store.get_cooldown_state(scope, now=0.0)
    assert state is not None
    assert 25 <= state.remaining_seconds <= 30
    assert state.reason == "billing_credits_depleted"
    assert state.cooldown_type == "hard"


@pytest.mark.parametrize(
    "payload",
    [
        '{"version":2,"expires_at_ms":"invalid","reason":"rate_limit","cooldown_type":"soft"}',
        "{not-json",
        '{"version":2,"expires_at_ms":1,"reason":123,"cooldown_type":"weird"}',
    ],
)
def test_malformed_redis_payload_does_not_crash_and_uses_pttl(payload: str):
    clock = FakeWallClock()
    redis = FakeRedis(wall_clock=clock)
    store = RedisGeminiKeyCooldownStore(
        redis, namespace="test:ai-service", wall_clock_ms=clock.now_ms
    )
    scope = _scope("primary", "fake-primary-key")
    key = store._cooldown_key(scope)
    redis.psetex(key, 15_000, payload)
    state = store.get_cooldown_state(scope, now=0.0)
    assert state is not None
    assert 10 <= state.remaining_seconds <= 15
    assert state.reason in {"rate_limit", "cooldown"}
    assert state.cooldown_type in {"soft", None}


def test_malformed_bytes_payload_uses_pttl():
    clock = FakeWallClock()
    redis = FakeRedis(wall_clock=clock)
    store = RedisGeminiKeyCooldownStore(
        redis, namespace="test:ai-service", wall_clock_ms=clock.now_ms
    )
    scope = _scope("primary", "fake-primary-key")
    key = store._cooldown_key(scope)
    redis.psetex(
        key,
        15_000,
        b'{"version":2,"expires_at_ms":1,"reason":"rate_limit","cooldown_type":"soft"}',
    )
    state = store.get_cooldown_state(scope, now=0.0)
    assert state is not None
    assert state.reason == "rate_limit"


def test_malformed_payload_expired_pttl_returns_none():
    clock = FakeWallClock()
    redis = FakeRedis(wall_clock=clock)
    store = RedisGeminiKeyCooldownStore(
        redis, namespace="test:ai-service", wall_clock_ms=clock.now_ms
    )
    scope = _scope("primary", "fake-primary-key")
    key = store._cooldown_key(scope)
    redis._values[key] = (clock.now_ms(), "{bad-json")
    state = store.get_cooldown_state(scope, now=0.0)
    assert state is None


def test_redis_read_failure_logs_single_warning(monkeypatch):
    warnings: list[tuple] = []

    def _capture_warning(*args, **kwargs):
        warnings.append(args)

    monkeypatch.setattr(
        "app.services.gemini_key_cooldown_store.logger.warning",
        _capture_warning,
    )

    class BrokenRedis:
        def eval(self, *args, **kwargs):
            raise ConnectionError("redis down")

        def register_script(self, script):
            del script

            class _Script:
                def __call__(self, *, keys, args):
                    raise ConnectionError("redis down")

            return _Script()

    store = RedisGeminiKeyCooldownStore(BrokenRedis(), namespace="test:ai-service")
    scope = _scope("primary", "fake-primary-key")
    assert store.get_cooldown_state(scope, now=0.0) is None
    assert len(warnings) == 1
    assert warnings[0][1] == "READ"
    assert "redis down" not in str(warnings)


def test_redis_write_failure_logs_single_warning(monkeypatch):
    warnings: list[tuple] = []

    def _capture_warning(*args, **kwargs):
        warnings.append(args)

    monkeypatch.setattr(
        "app.services.gemini_key_cooldown_store.logger.warning",
        _capture_warning,
    )

    class BrokenRedis:
        def eval(self, *args, **kwargs):
            raise ConnectionError("redis down")

        def register_script(self, script):
            del script

            class _Script:
                def __call__(self, *, keys, args):
                    raise ConnectionError("redis down")

            return _Script()

    store = RedisGeminiKeyCooldownStore(BrokenRedis(), namespace="test:ai-service")
    scope = _scope("primary", "fake-primary-key")
    store.apply_cooldown(
        scope, seconds=30, reason="rate_limit", cooldown_type="soft"
    )
    assert len(warnings) == 1
    assert warnings[0][1] == "WRITE"
