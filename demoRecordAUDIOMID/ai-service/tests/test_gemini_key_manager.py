from concurrent.futures import ThreadPoolExecutor

import pytest

from app.services.gemini_key_manager import (
    GeminiKeyConfigError,
    GeminiKeyManager,
    parse_gemini_api_keys,
)


class FakeClock:
    def __init__(self, now: float = 100.0):
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


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
    class FakeRedis:
        def __init__(self):
            self.values: dict[str, int] = {}

        def ttl(self, key):
            return self.values.get(key, -2)

        def setex(self, key, ttl, value):
            current = self.values.get(key, -2)
            ttl_value = int(ttl)
            if current < 0 or ttl_value > current:
                self.values[key] = ttl_value

    from app.services.gemini_key_cooldown_store import RedisGeminiKeyCooldownStore
    from app.services.gemini_key_manager import GeminiKeyEntry

    redis = FakeRedis()
    store = RedisGeminiKeyCooldownStore(redis)
    entry = GeminiKeyEntry(alias="primary", secret="key-a")
    manager_a = GeminiKeyManager([entry], clock=FakeClock(), cooldown_store=store)
    manager_b = GeminiKeyManager([entry], clock=FakeClock(), cooldown_store=store)

    manager_a.cooldown_key("primary", seconds=30, reason="429")
    assert manager_b.select_key().available is False


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
