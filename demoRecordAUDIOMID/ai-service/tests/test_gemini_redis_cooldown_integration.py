"""Integration tests for shared Gemini key cooldown across ai-api replicas (real Redis)."""

from __future__ import annotations

import time

import pytest

pytest.importorskip("testcontainers")

from testcontainers.redis import RedisContainer  # noqa: E402

from app.services.gemini_key_cooldown_store import RedisGeminiKeyCooldownStore  # noqa: E402
from app.services.gemini_key_manager import GeminiKeyEntry, GeminiKeyManager  # noqa: E402


@pytest.fixture(scope="module")
def redis_url() -> str:
    with RedisContainer("redis:7-alpine") as container:
        host = container.get_container_host_ip()
        port = container.get_exposed_port(6379)
        yield f"redis://{host}:{port}/0"


def test_redis_cooldown_shared_between_two_manager_replicas(redis_url: str) -> None:
    import redis

    client = redis.Redis.from_url(redis_url, decode_responses=True)
    store = RedisGeminiKeyCooldownStore(client)
    entry = GeminiKeyEntry(alias="primary", secret="key-a")
    manager_a = GeminiKeyManager([entry], cooldown_store=store)
    manager_b = GeminiKeyManager([entry], cooldown_store=store)

    manager_a.cooldown_key("primary", seconds=2, reason="429")
    assert manager_b.select_key().available is False

    time.sleep(2.5)
    assert manager_b.select_key().available is True
