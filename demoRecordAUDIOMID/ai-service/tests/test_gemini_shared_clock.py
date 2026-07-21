"""Shared wall-clock vs local monotonic clock isolation tests."""

from __future__ import annotations

from app.services.gemini_key_cooldown_store import InMemoryGeminiKeyCooldownStore
from app.services.gemini_key_manager import GeminiKeyManager


class FakeMonotonicClock:
    def __init__(self, start: float = 900_000.0) -> None:
        self.value = start

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class FakeWallClock:
    def __init__(self, start: float = 1_700_000_000.0) -> None:
        self.value = start

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds

    def now_ms(self) -> int:
        return int(self.value * 1000)


def test_shared_state_uses_wall_clock_not_monotonic_uptime() -> None:
    wall_a = FakeWallClock(start=1_700_000_000.0)
    wall_b = FakeWallClock(start=1_700_000_010.0)
    mono_a = FakeMonotonicClock(start=900_000.0)
    mono_b = FakeMonotonicClock(start=1_000.0)

    store = InMemoryGeminiKeyCooldownStore(
        wall_clock_ms=wall_a.now_ms,
        namespace="offline-test:ai-service",
    )
    manager_a = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        gemini_api_keys="",
        multi_key_enabled=False,
        clock=mono_a,
        wall_clock=wall_a,
        cooldown_store=store,
    )
    manager_a.hard_cooldown_key(
        "primary", seconds=60, reason="billing_credits_depleted"
    )

    manager_b = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        gemini_api_keys="",
        multi_key_enabled=False,
        clock=mono_b,
        wall_clock=wall_b,
        cooldown_store=store,
    )
    selection = manager_b.select_key(model="gemini-2.5-flash")
    assert selection.available is False
    assert selection.unavailable_reasons.get("primary") == "billing_credits_depleted"


def test_local_monotonic_deadline_does_not_extend_shared_expiry() -> None:
    wall = FakeWallClock(start=1_700_000_000.0)
    mono = FakeMonotonicClock(start=50_000.0)
    store = InMemoryGeminiKeyCooldownStore(
        wall_clock_ms=wall.now_ms,
        namespace="offline-test:ai-service",
    )
    manager = GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        gemini_api_keys="",
        multi_key_enabled=False,
        clock=mono,
        wall_clock=wall,
        cooldown_store=store,
    )
    manager.cooldown_key("primary", seconds=30, reason="rate_limit")
    mono.advance(60.0)
    wall.advance(10.0)
    selection = manager.select_key(model="gemini-2.5-flash")
    assert selection.available is False
    assert selection.unavailable_reasons.get("primary") == "rate_limit"
