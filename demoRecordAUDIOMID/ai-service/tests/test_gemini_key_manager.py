import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.services.gemini_key_manager import (
    GeminiKeyConfigError,
    GeminiKeyManager,
    parse_gemini_api_keys,
)

from app.services.gemini_key_cooldown_store import (
    InMemoryGeminiKeyCooldownStore,
    SharedPoolSnapshot,
)


class FakeClock:
    def __init__(self, now: float = 100.0):
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds

    def now_ms(self) -> int:
        return int(self.now * 1000)


def test_single_key_backward_compatibility_uses_gemini_api_key():
    manager = GeminiKeyManager.from_config(
        gemini_api_key="single-test-key",
        gemini_api_keys="",
        multi_key_enabled=False,
        clock=FakeClock(),
    )

    selection = manager.select_key()

    assert selection.available
    assert selection.entry.alias == "primary"
    assert selection.entry.secret == "single-test-key"


def test_multi_key_json_parsing():
    entries = parse_gemini_api_keys(
        '[{"alias":"primary","key":"key-a"},{"alias":"backup1","key":"key-b"}]'
    )

    assert [(entry.alias, entry.secret) for entry in entries] == [
        ("primary", "key-a"),
        ("backup1", "key-b"),
    ]


def test_comma_alias_key_parsing():
    entries = parse_gemini_api_keys("primary:key-a,backup1:key-b")

    assert [(entry.alias, entry.secret) for entry in entries] == [
        ("primary", "key-a"),
        ("backup1", "key-b"),
    ]


@pytest.mark.parametrize(
    ("raw", "secret"),
    [
        ("Primary:key-a", "key-a"),
        ("primary:key-a,primary:key-b", "key-b"),
        ("primary:key-a,backup:key-a", "key-a"),
        ("primary:", "primary:"),
        ("not-json", "not-json"),
    ],
)
def test_invalid_parser_inputs_are_rejected_safely(raw, secret):
    with pytest.raises(GeminiKeyConfigError) as exc_info:
        parse_gemini_api_keys(raw)

    rendered = str(exc_info.value)
    assert secret not in rendered
    assert raw not in rendered


def test_key_entry_repr_does_not_expose_secret():
    entry = parse_gemini_api_keys("primary:super-secret-key")[0]

    rendered = repr(entry)

    assert "primary" in rendered
    assert "super-secret-key" not in rendered


def test_round_robin_selection_skips_cooled_down_keys():
    clock = FakeClock()
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
        clock=clock,
    )

    assert manager.select_key().entry.alias == "primary"
    manager.cooldown_key("backup1", seconds=30, reason="rate_limit")
    assert manager.select_key().entry.alias == "primary"


def test_cooldown_expiry_makes_key_eligible_again():
    clock = FakeClock()
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
        clock=clock,
    )

    manager.cooldown_key("primary", seconds=10, reason="rate_limit")
    assert manager.select_key().entry.alias == "backup1"

    clock.advance(11)

    assert manager.select_key().entry.alias == "primary"


def test_hard_cooldown_makes_key_ineligible():
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
        clock=FakeClock(),
    )

    manager.hard_cooldown_key("primary", seconds=900, reason="invalid_key")

    assert manager.select_key().entry.alias == "backup1"


def test_all_keys_exhausted_returns_retry_after_seconds():
    clock = FakeClock()
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
        clock=clock,
    )
    manager.cooldown_key("primary", seconds=20, reason="rate_limit")
    manager.cooldown_key("backup1", seconds=5, reason="rate_limit")

    selection = manager.select_key()

    assert not selection.available
    assert selection.retry_after_seconds == 5
    assert selection.cooldown_active == 2


def test_selection_is_thread_safe():
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b,backup2:key-c",
        multi_key_enabled=True,
        clock=FakeClock(),
    )

    with ThreadPoolExecutor(max_workers=8) as executor:
        aliases = list(
            executor.map(lambda _: manager.select_key().entry.alias, range(60))
        )

    assert set(aliases) == {"primary", "backup1", "backup2"}


def test_redis_cooldown_store_shares_state_across_managers():
    from tests.test_gemini_cooldown_store import FakeRedis, FakeWallClock

    from app.services.gemini_key_cooldown_store import RedisGeminiKeyCooldownStore
    from app.services.gemini_key_manager import GeminiKeyEntry

    clock = FakeWallClock()
    redis = FakeRedis(wall_clock=clock)
    store = RedisGeminiKeyCooldownStore(
        redis, namespace="test:ai-service", wall_clock_ms=clock.now_ms
    )
    entry = GeminiKeyEntry(alias="primary", secret="key-a")
    manager_a = GeminiKeyManager(
        [entry], clock=clock, wall_clock=clock, cooldown_store=store
    )
    manager_b = GeminiKeyManager(
        [entry], clock=clock, wall_clock=clock, cooldown_store=store
    )

    manager_a.cooldown_key("primary", seconds=30, reason="rate_limit")
    assert manager_b.select_key().available is False
    assert manager_b.select_key().unavailable_reasons.get("primary") == "rate_limit"


def test_select_key_prefers_sticky_alias_without_advancing_round_robin():
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b,backup2:key-c",
        multi_key_enabled=True,
        clock=FakeClock(),
    )
    first = manager.select_key()
    assert first.entry.alias == "primary"

    sticky = manager.select_key(preferred_alias="primary")
    assert sticky.available
    assert sticky.entry.alias == "primary"

    # Round-robin cursor still points at backup1 for non-sticky selection.
    next_rr = manager.select_key()
    assert next_rr.entry.alias == "backup1"


def test_model_specific_unsupported_cache_allows_other_models():
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="backup1:key-b,backup2:key-c",
        multi_key_enabled=True,
        clock=FakeClock(),
    )
    manager.mark_model_unsupported("backup1", "gemini-2.5-flash")

    blocked = manager.select_key(preferred_alias="backup1", model="gemini-2.5-flash")
    assert blocked.available
    assert blocked.entry.alias == "backup2"

    allowed = manager.select_key(preferred_alias="backup1", model="gemini-2.0-flash")
    assert allowed.available
    assert allowed.entry.alias == "backup1"


def test_model_unsupported_does_not_use_shared_rate_limit_cooldown():
    clock = FakeClock()
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
        clock=clock,
    )
    manager.mark_model_unsupported("primary", "models/gemini-2.5-flash")

    # Still eligible for a different model immediately (no soft cooldown).
    other = manager.select_key(model="gemini-1.5-flash")
    assert other.entry.alias == "primary"

    # Unsupported for the blocked model.
    selection = manager.select_key(model="gemini-2.5-flash")
    assert selection.entry.alias == "backup1"


def test_all_keys_unsupported_for_model_helper():
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
        clock=FakeClock(),
    )
    assert not manager.all_keys_unsupported_for_model("gemini-2.5-flash")
    manager.mark_model_unsupported("primary", "gemini-2.5-flash")
    assert not manager.all_keys_unsupported_for_model("gemini-2.5-flash")
    manager.mark_model_unsupported("backup1", "gemini-2.5-flash")
    assert manager.all_keys_unsupported_for_model("gemini-2.5-flash")
    assert not manager.all_keys_unsupported_for_model("gemini-2.0-flash")


def test_concurrent_model_cache_and_selection_is_thread_safe():
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b,backup2:key-c",
        multi_key_enabled=True,
        clock=FakeClock(),
    )

    def worker(i: int):
        if i % 3 == 0:
            manager.mark_model_unsupported("primary", "gemini-2.5-flash")
        return manager.select_key(model="gemini-2.0-flash").entry.alias

    with ThreadPoolExecutor(max_workers=8) as executor:
        aliases = list(executor.map(worker, range(48)))

    assert set(aliases) <= {"primary", "backup1", "backup2"}
    assert manager.select_key(model="gemini-2.5-flash").entry.alias in {
        "backup1",
        "backup2",
    }


def test_unavailable_selection_preserves_terminal_reasons_without_secrets():
    clock = FakeClock()
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys=(
            "primary:fake-primary-key,backup1:fake-backup-key,backup2:fake-third-key"
        ),
        multi_key_enabled=True,
        clock=clock,
    )
    manager.hard_cooldown_key(
        "primary", seconds=900, reason="billing_credits_depleted"
    )
    manager.hard_cooldown_key(
        "backup1", seconds=900, reason="free_tier_token_quota_exhausted"
    )
    manager.mark_model_unsupported("backup2", "gemini-2.5-flash")

    selection = manager.select_key(model="gemini-2.5-flash")

    assert selection.available is False
    assert selection.unavailable_reasons == {
        "primary": "billing_credits_depleted",
        "backup1": "free_tier_token_quota_exhausted",
        "backup2": "model_unavailable",
    }
    assert selection.all_terminal is True
    assert "fake-primary-key" not in str(selection)
    assert "fake-backup-key" not in str(selection)


def test_has_unattempted_eligible_key_skips_attempted_aliases():
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:fake-primary-key,backup1:fake-backup-key",
        multi_key_enabled=True,
        clock=FakeClock(),
    )

    assert manager.has_unattempted_eligible_key(
        "gemini-2.5-flash", attempted_aliases=set()
    )
    assert manager.has_unattempted_eligible_key(
        "gemini-2.5-flash", attempted_aliases={"primary"}
    )
    assert not manager.has_unattempted_eligible_key(
        "gemini-2.5-flash", attempted_aliases={"primary", "backup1"}
    )


def test_soft_cooldown_unavailable_is_not_all_terminal():
    clock = FakeClock()
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:fake-primary-key,backup1:fake-backup-key",
        multi_key_enabled=True,
        clock=clock,
    )
    manager.cooldown_key("primary", seconds=30, reason="rate_limit")
    manager.cooldown_key("backup1", seconds=30, reason="rate_limit")

    selection = manager.select_key(model="gemini-2.5-flash")

    assert selection.available is False
    assert selection.all_terminal is False
    assert selection.unavailable_reasons == {
        "primary": "rate_limit",
        "backup1": "rate_limit",
    }

    clock.advance(31)
    assert manager.select_key(model="gemini-2.5-flash").available is True


def _manager_pair(shared_store, *, clock=None):
    clock = clock or FakeClock()
    return GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys=(
            "primary:fake-primary-key,backup1:fake-backup-key,backup2:fake-third-key"
        ),
        multi_key_enabled=True,
        clock=clock,
        wall_clock=clock,
        cooldown_store=shared_store,
    )


def test_cross_process_terminal_pool_reasons_shared_without_local_state():
    from app.services.gemini_key_cooldown_store import InMemoryGeminiKeyCooldownStore

    clock = FakeClock()
    shared_store = InMemoryGeminiKeyCooldownStore(wall_clock_ms=clock.now_ms)
    manager_a = _manager_pair(shared_store, clock=clock)
    manager_a.hard_cooldown_key(
        "primary", seconds=900, reason="billing_credits_depleted"
    )
    manager_a.hard_cooldown_key(
        "backup1", seconds=900, reason="free_tier_token_quota_exhausted"
    )
    manager_a.mark_model_unsupported("backup2", "gemini-2.5-flash")

    selection_a = manager_a.select_key(model="gemini-2.5-flash")
    assert selection_a.all_terminal is True
    assert selection_a.unavailable_reasons == {
        "primary": "billing_credits_depleted",
        "backup1": "free_tier_token_quota_exhausted",
        "backup2": "model_unavailable",
    }

    manager_b = _manager_pair(shared_store, clock=clock)
    selection_b = manager_b.select_key(model="gemini-2.5-flash")
    assert selection_b.available is False
    assert selection_b.all_terminal is True
    assert selection_b.unavailable_reasons == {
        "primary": "billing_credits_depleted",
        "backup1": "free_tier_token_quota_exhausted",
        "backup2": "model_unavailable",
    }


def test_cross_process_transient_cooldown_is_retryable_not_terminal_pool():
    from app.services.gemini_key_cooldown_store import InMemoryGeminiKeyCooldownStore

    clock = FakeClock()
    shared_store = InMemoryGeminiKeyCooldownStore(wall_clock_ms=clock.now_ms)
    manager_a = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:fake-primary-key,backup1:fake-backup-key",
        multi_key_enabled=True,
        clock=clock,
        wall_clock=clock,
        cooldown_store=shared_store,
    )
    manager_a.cooldown_key("primary", seconds=30, reason="rate_limit")
    manager_a.cooldown_key("backup1", seconds=30, reason="rate_limit")

    manager_b = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:fake-primary-key,backup1:fake-backup-key",
        multi_key_enabled=True,
        clock=clock,
        wall_clock=clock,
        cooldown_store=shared_store,
    )
    selection = manager_b.select_key(model="gemini-2.5-flash")
    assert selection.available is False
    assert selection.all_terminal is False
    assert selection.unavailable_reasons == {
        "primary": "rate_limit",
        "backup1": "rate_limit",
    }


def test_cross_process_cooldown_expiry_clears_shared_terminal_reason():
    from app.services.gemini_key_cooldown_store import InMemoryGeminiKeyCooldownStore

    clock = FakeClock()
    shared_store = InMemoryGeminiKeyCooldownStore(wall_clock_ms=clock.now_ms)
    manager_a = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        gemini_api_keys="",
        multi_key_enabled=False,
        clock=clock,
        wall_clock=clock,
        cooldown_store=shared_store,
    )
    manager_a.hard_cooldown_key(
        "primary", seconds=30, reason="billing_credits_depleted"
    )

    manager_b = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        gemini_api_keys="",
        multi_key_enabled=False,
        clock=clock,
        wall_clock=clock,
        cooldown_store=shared_store,
    )
    before = manager_b.select_key(model="gemini-2.5-flash")
    assert before.available is False
    assert before.unavailable_reasons.get("primary") == "billing_credits_depleted"

    clock.advance(31)
    after = manager_b.select_key(model="gemini-2.5-flash")
    assert after.available is True
    assert "primary" not in after.unavailable_reasons


class LegacyDurationOnlyCooldownStore:
    """Backward-compatible store exposing only duration, no reason metadata."""

    def __init__(self) -> None:
        self._remaining: dict[str, float] = {}

    def cooldown_remaining(self, alias: str, *, now: float) -> float:
        return max(0.0, float(self._remaining.get(alias, 0.0)))

    def apply_cooldown(self, alias: str, *, seconds: float, **_kwargs) -> None:
        self._remaining[alias] = max(
            float(self._remaining.get(alias, 0.0)), float(seconds or 0.0)
        )


def test_legacy_store_without_reason_falls_back_to_cooldown_not_terminal():
    store = LegacyDurationOnlyCooldownStore()
    clock = FakeClock()
    manager_a = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:fake-primary-key,backup1:fake-backup-key",
        multi_key_enabled=True,
        clock=clock,
        cooldown_store=store,
    )
    manager_a.cooldown_key("primary", seconds=30, reason="billing_credits_depleted")
    manager_a.cooldown_key("backup1", seconds=30, reason="billing_credits_depleted")

    manager_b = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:fake-primary-key,backup1:fake-backup-key",
        multi_key_enabled=True,
        clock=clock,
        cooldown_store=store,
    )
    selection = manager_b.select_key(model="gemini-2.5-flash")
    assert selection.available is False
    assert selection.unavailable_reasons.get("primary") == "cooldown"
    assert selection.all_terminal is False


def test_clear_cooldown_makes_alias_eligible_in_other_manager():
    from app.services.gemini_key_cooldown_store import InMemoryGeminiKeyCooldownStore

    clock = FakeClock()
    shared_store = InMemoryGeminiKeyCooldownStore(wall_clock_ms=clock.now_ms)
    manager_a = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        gemini_api_keys="",
        multi_key_enabled=False,
        clock=clock,
        wall_clock=clock,
        cooldown_store=shared_store,
    )
    manager_a.hard_cooldown_key(
        "primary", seconds=900, reason="billing_credits_depleted"
    )
    manager_blocked = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        gemini_api_keys="",
        multi_key_enabled=False,
        clock=clock,
        wall_clock=clock,
        cooldown_store=shared_store,
    )
    assert manager_blocked.select_key().available is False

    manager_a.clear_cooldown("primary")
    manager_b = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        gemini_api_keys="",
        multi_key_enabled=False,
        clock=clock,
        wall_clock=clock,
        cooldown_store=shared_store,
    )
    assert manager_b.select_key().available is True


def test_stale_shared_snapshot_cannot_erase_new_local_cooldown():
    snapshot_read = threading.Event()
    release_snapshot = threading.Event()

    class BlockingSnapshotStore(InMemoryGeminiKeyCooldownStore):
        def read_pool_snapshot(self, *args, **kwargs):
            snapshot = super().read_pool_snapshot(*args, **kwargs)
            snapshot_read.set()
            assert release_snapshot.wait(timeout=2)
            return snapshot

    store = BlockingSnapshotStore()
    manager = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        multi_key_enabled=False,
        cooldown_store=store,
    )
    result = {}

    thread = threading.Thread(
        target=lambda: result.setdefault("selection", manager.select_key())
    )
    thread.start()
    assert snapshot_read.wait(timeout=2)
    manager.cooldown_key("primary", seconds=60, reason="rate_limit")
    release_snapshot.set()
    thread.join(timeout=2)

    assert not thread.is_alive()
    assert result["selection"].available is False
    assert result["selection"].unavailable_reasons == {"primary": "rate_limit"}


def test_concurrent_round_robin_reserves_unique_start_tickets():
    snapshot_barrier = threading.Barrier(30)

    class ConcurrentSnapshotStore(InMemoryGeminiKeyCooldownStore):
        def read_pool_snapshot(self, *args, **kwargs):
            snapshot_barrier.wait()
            return super().read_pool_snapshot(*args, **kwargs)

    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b,backup2:key-c",
        multi_key_enabled=True,
        cooldown_store=ConcurrentSnapshotStore(),
    )
    barrier = threading.Barrier(30)

    def select_alias(_index: int) -> str:
        barrier.wait()
        return manager.select_key().entry.alias

    with ThreadPoolExecutor(max_workers=30) as executor:
        aliases = list(executor.map(select_alias, range(30)))

    counts = Counter(aliases)
    assert counts == {"primary": 10, "backup1": 10, "backup2": 10}


def test_redis_wait_does_not_hold_manager_lock_for_local_cooldown_update():
    read_started = threading.Event()
    release_read = threading.Event()
    cooldown_updated = threading.Event()

    class BlockingSnapshotStore(InMemoryGeminiKeyCooldownStore):
        def read_pool_snapshot(self, *args, **kwargs):
            read_started.set()
            assert release_read.wait(timeout=2)
            return super().read_pool_snapshot(*args, **kwargs)

        def apply_cooldown(self, *args, **kwargs):
            cooldown_updated.set()
            return super().apply_cooldown(*args, **kwargs)

    store = BlockingSnapshotStore()
    manager = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        multi_key_enabled=False,
        cooldown_store=store,
    )
    reader = threading.Thread(target=manager.has_eligible_key)
    reader.start()
    assert read_started.wait(timeout=2)

    writer = threading.Thread(
        target=lambda: manager.cooldown_key(
            "primary", seconds=30, reason="rate_limit"
        )
    )
    writer.start()
    assert cooldown_updated.wait(timeout=0.5)
    writer.join(timeout=1)
    release_read.set()
    reader.join(timeout=2)

    assert not writer.is_alive()
    assert not reader.is_alive()


def test_positive_shared_cooldown_is_cached_for_redis_failure_fallback():
    class FailingAfterFirstRead(InMemoryGeminiKeyCooldownStore):
        fail_reads = False

        def read_pool_snapshot(self, *args, **kwargs):
            if self.fail_reads:
                return SharedPoolSnapshot(
                    success=False, error=TimeoutError("redis timeout")
                )
            return super().read_pool_snapshot(*args, **kwargs)

    store = FailingAfterFirstRead()
    scope = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key", multi_key_enabled=False
    )._scope_for("primary")
    store.apply_cooldown(
        scope,
        seconds=900,
        reason="billing_credits_depleted",
        cooldown_type="hard",
    )
    manager = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        multi_key_enabled=False,
        cooldown_store=store,
    )

    assert manager.select_key().available is False
    store.fail_reads = True
    fallback = manager.select_key()

    assert fallback.available is False
    assert fallback.unavailable_reasons == {
        "primary": "billing_credits_depleted"
    }


def test_positive_shared_model_marker_is_cached_for_redis_failure_fallback():
    class FailingAfterFirstRead(InMemoryGeminiKeyCooldownStore):
        fail_reads = False

        def read_pool_snapshot(self, *args, **kwargs):
            if self.fail_reads:
                return SharedPoolSnapshot(
                    success=False, error=TimeoutError("redis timeout")
                )
            return super().read_pool_snapshot(*args, **kwargs)

    store = FailingAfterFirstRead(model_unsupported_ttl_seconds=60)
    manager = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        multi_key_enabled=False,
        cooldown_store=store,
    )
    scope = manager._scope_for("primary")
    store.mark_model_unsupported(scope, "gemini-2.5-flash")

    assert manager.select_key(model="gemini-2.5-flash").available is False
    store.fail_reads = True
    fallback = manager.select_key(model="gemini-2.5-flash")

    assert fallback.available is False
    assert fallback.all_model_unsupported is True


def test_clear_failure_keeps_local_tombstone_and_retries_in_next_snapshot():
    class FailClearOnceStore(InMemoryGeminiKeyCooldownStore):
        allow_retry = False
        clear_calls = 0

        def clear_cooldown(self, scope):
            self.clear_calls += 1
            if not self.allow_retry:
                return False
            return super().clear_cooldown(scope)

    store = FailClearOnceStore()
    manager = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        multi_key_enabled=False,
        cooldown_store=store,
        clock=FakeClock(),
    )
    manager.hard_cooldown_key(
        "primary", seconds=900, reason="billing_credits_depleted"
    )
    manager.clear_cooldown("primary")

    assert manager.select_key().available is True
    assert "primary" in manager._pending_cooldown_clears

    store.allow_retry = True
    manager._clock.advance(2.0)
    assert manager.select_key().available is True
    assert "primary" not in manager._pending_cooldown_clears

    fresh_manager = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        multi_key_enabled=False,
        cooldown_store=store,
    )
    assert fresh_manager.select_key().available is True


def _three_key_manager(**kwargs):
    return GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b,backup2:key-c",
        multi_key_enabled=True,
        clock=FakeClock(),
        **kwargs,
    )


def test_attempted_alias_is_not_selected_on_normal_retry():
    manager = _three_key_manager()
    selection = manager.select_key(attempted_aliases={"primary"})
    assert selection.available
    assert selection.entry.alias in {"backup1", "backup2"}
    assert selection.entry.alias != "primary"


def test_two_attempted_aliases_leave_only_unattempted():
    manager = _three_key_manager()
    selection = manager.select_key(
        attempted_aliases={"primary", "backup1"}
    )
    assert selection.available
    assert selection.entry.alias == "backup2"


def test_all_aliases_attempted_returns_unavailable():
    manager = _three_key_manager()
    selection = manager.select_key(
        attempted_aliases={"primary", "backup1", "backup2"}
    )
    assert not selection.available
    assert not manager.has_unattempted_eligible_key(
        "gemini-2.5-flash", attempted_aliases={"primary", "backup1", "backup2"}
    )


def test_preferred_attempted_without_reuse_is_not_selected():
    manager = _three_key_manager()
    selection = manager.select_key(
        preferred_alias="primary",
        attempted_aliases={"primary"},
        allow_preferred_reuse=False,
    )
    assert selection.available
    assert selection.entry.alias != "primary"


def test_sticky_preferred_reuse_allows_attempted_primary():
    manager = _three_key_manager()
    selection = manager.select_key(
        preferred_alias="primary",
        attempted_aliases={"primary"},
        allow_preferred_reuse=True,
    )
    assert selection.available
    assert selection.entry.alias == "primary"


def test_preferred_reuse_does_not_bypass_cooldown():
    manager = _three_key_manager()
    manager.cooldown_key("primary", seconds=60, reason="rate_limit")
    selection = manager.select_key(
        preferred_alias="primary",
        attempted_aliases={"primary"},
        allow_preferred_reuse=True,
    )
    assert selection.available
    assert selection.entry.alias != "primary"


def test_backup1_mutation_does_not_invalidate_primary_validation():
    store = InMemoryGeminiKeyCooldownStore()
    manager = _three_key_manager(cooldown_store=store)
    selection = manager.select_key(model="gemini-2.5-flash")
    assert selection.entry.alias == "primary"
    primary_revision = selection.selection_revision

    manager.cooldown_key("backup1", seconds=30, reason="rate_limit")
    assert manager._alias_generation.get("primary", 0) == primary_revision.alias_generation
    assert manager.validate_selection(selection, model="gemini-2.5-flash")


def test_redis_cooldown_blocks_final_validation_despite_other_alias_change():
    class PrimaryValidationStore(InMemoryGeminiKeyCooldownStore):
        validation_started = threading.Event()
        release_validation = threading.Event()

        def read_pool_snapshot(self, scopes, model_name, **kwargs):
            if len(scopes) == 1 and scopes[0].alias == "primary":
                self.validation_started.set()
                assert self.release_validation.wait(timeout=2)
            return super().read_pool_snapshot(scopes, model_name, **kwargs)

    store = PrimaryValidationStore()
    manager = _three_key_manager(cooldown_store=store)
    selection = manager.select_key(model="gemini-2.5-flash")
    assert selection.entry.alias == "primary"
    result = {}

    def validate():
        result["valid"] = manager.validate_selection(
            selection, model="gemini-2.5-flash"
        )

    thread = threading.Thread(target=validate)
    thread.start()
    assert store.validation_started.wait(timeout=2)
    scope = manager._scope_for("primary")
    store.apply_cooldown(
        scope, seconds=30, reason="rate_limit", cooldown_type="soft"
    )
    manager.cooldown_key("backup1", seconds=30, reason="rate_limit")
    store.release_validation.set()
    thread.join(timeout=2)
    assert not thread.is_alive()
    assert result["valid"] is False


def test_same_alias_local_change_retries_validation_then_invalid():
    store = InMemoryGeminiKeyCooldownStore()
    manager = _three_key_manager(cooldown_store=store)
    selection = manager.select_key(model="gemini-2.5-flash")
    assert selection.entry.alias == "primary"
    manager.cooldown_key("primary", seconds=60, reason="rate_limit")
    assert manager.validate_selection(selection, model="gemini-2.5-flash") is False


def test_noop_redis_sync_does_not_bump_alias_generation():
    store = InMemoryGeminiKeyCooldownStore()
    manager = _three_key_manager(cooldown_store=store)
    scope = manager._scope_for("primary")
    store.apply_cooldown(
        scope, seconds=30, reason="rate_limit", cooldown_type="soft"
    )
    manager.select_key(model="gemini-2.5-flash")
    before = manager._alias_generation.get("primary", 0)
    manager.select_key(model="gemini-2.5-flash")
    assert manager._alias_generation.get("primary", 0) == before


def test_reason_change_bumps_alias_generation():
    store = InMemoryGeminiKeyCooldownStore()
    manager = _three_key_manager(cooldown_store=store)
    scope = manager._scope_for("primary")
    store.apply_cooldown(
        scope, seconds=30, reason="rate_limit", cooldown_type="soft"
    )
    manager.select_key(model="gemini-2.5-flash")
    before = manager._alias_generation.get("primary", 0)
    store.apply_cooldown(
        scope,
        seconds=30,
        reason="billing_credits_depleted",
        cooldown_type="hard",
    )
    manager.select_key(model="gemini-2.5-flash")
    assert manager._alias_generation.get("primary", 0) > before


def test_backup1_change_does_not_bump_primary_generation():
    store = InMemoryGeminiKeyCooldownStore()
    manager = _three_key_manager(cooldown_store=store)
    manager.select_key(model="gemini-2.5-flash")
    before = manager._alias_generation.get("primary", 0)
    manager.cooldown_key("backup1", seconds=30, reason="rate_limit")
    assert manager._alias_generation.get("primary", 0) == before
    assert manager._alias_generation.get("backup1", 0) > 0


def test_pending_clear_survives_three_failures_and_retries_after_backoff():
    clock = FakeClock()

    class AlwaysFailClearStore(InMemoryGeminiKeyCooldownStore):
        def clear_cooldown(self, scope):
            return False

    store = AlwaysFailClearStore()
    manager = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        multi_key_enabled=False,
        cooldown_store=store,
        clock=clock,
    )
    manager.hard_cooldown_key(
        "primary", seconds=900, reason="billing_credits_depleted"
    )
    manager.clear_cooldown("primary")
    pending = manager._pending_cooldown_clears["primary"]
    for _ in range(3):
        clock.advance(60.0)
        manager.select_key()
        assert "primary" in manager._pending_cooldown_clears
        assert manager._pending_cooldown_clears["primary"].attempts >= pending.attempts
        pending = manager._pending_cooldown_clears["primary"]


def test_pending_clear_expires_and_stops_suppressing_redis():
    clock = FakeClock()

    class AlwaysFailClearStore(InMemoryGeminiKeyCooldownStore):
        def clear_cooldown(self, scope):
            return False

    store = AlwaysFailClearStore()
    manager = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        multi_key_enabled=False,
        cooldown_store=store,
        clock=clock,
    )
    scope = manager._scope_for("primary")
    store.apply_cooldown(
        scope, seconds=900, reason="billing_credits_depleted", cooldown_type="hard"
    )
    manager.clear_cooldown("primary")
    clock.advance(301.0)
    manager.select_key()
    assert "primary" not in manager._pending_cooldown_clears


def test_concurrent_round_robin_skips_attempted_primary():
    snapshot_barrier = threading.Barrier(30)

    class ConcurrentSnapshotStore(InMemoryGeminiKeyCooldownStore):
        def read_pool_snapshot(self, *args, **kwargs):
            snapshot_barrier.wait()
            return super().read_pool_snapshot(*args, **kwargs)

    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b,backup2:key-c",
        multi_key_enabled=True,
        cooldown_store=ConcurrentSnapshotStore(),
    )
    barrier = threading.Barrier(30)

    def select_alias(_index: int) -> str:
        barrier.wait()
        return manager.select_key(
            attempted_aliases={"primary"}
        ).entry.alias

    with ThreadPoolExecutor(max_workers=30) as executor:
        aliases = list(executor.map(select_alias, range(30)))

    counts = Counter(aliases)
    assert "primary" not in counts
    assert set(counts) == {"backup1", "backup2"}
    assert sum(counts.values()) == 30
