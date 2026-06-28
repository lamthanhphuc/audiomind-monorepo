from __future__ import annotations

import time
from math import ceil
from typing import Callable, Protocol


class GeminiKeyCooldownStore(Protocol):
    def cooldown_remaining(self, alias: str, *, now: float) -> float:
        ...

    def apply_cooldown(self, alias: str, *, seconds: float) -> None:
        ...


class InMemoryGeminiKeyCooldownStore:
    def __init__(self) -> None:
        self._disabled_until: dict[str, float] = {}

    def cooldown_remaining(self, alias: str, *, now: float) -> float:
        disabled_until = float(self._disabled_until.get(alias, 0.0))
        return max(0.0, disabled_until - now)

    def apply_cooldown(self, alias: str, *, seconds: float) -> None:
        cooldown_seconds = max(0.0, float(seconds or 0.0))
        now = time.monotonic()
        self._disabled_until[alias] = max(
            float(self._disabled_until.get(alias, 0.0)),
            now + cooldown_seconds,
        )


class RedisGeminiKeyCooldownStore:
    """Shared cooldown markers across ai-api replicas using Redis TTL."""

    KEY_PREFIX = "gemini:key-cooldown:"

    def __init__(self, redis_client):
        self._redis = redis_client

    def cooldown_remaining(self, alias: str, *, now: float) -> float:
        ttl = self._redis.ttl(f"{self.KEY_PREFIX}{alias}")
        return float(max(0, int(ttl)))

    def apply_cooldown(self, alias: str, *, seconds: float) -> None:
        key = f"{self.KEY_PREFIX}{alias}"
        cooldown_seconds = max(1, int(ceil(float(seconds or 0.0))))
        current_ttl = int(self._redis.ttl(key))
        if current_ttl < 0 or cooldown_seconds > current_ttl:
            self._redis.setex(key, cooldown_seconds, "1")
