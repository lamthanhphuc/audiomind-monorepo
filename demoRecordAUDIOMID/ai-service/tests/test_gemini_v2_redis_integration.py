"""V2 Redis integration tests (REDIS-04..REDIS-21 mandatory subset)."""

from __future__ import annotations

import pytest

from app.services.gemini_key_cooldown_store import key_fingerprint
from app.services.gemini_shared_state_contracts import (
    INTEGRATION_REMAINING_MS_TOLERANCE,
    PendingOperationStatus,
    SharedStateScope,
    build_v2_cooldown_revision_key,
    build_v2_cooldown_state_key,
)
from app.services.gemini_shared_state_store import RedisV2GeminiKeyCooldownStore

pytestmark = pytest.mark.redis_integration


def _v2_scope(alias: str = "primary", secret: str = "fake-primary-key") -> SharedStateScope:
    return SharedStateScope(alias=alias, fingerprint=key_fingerprint(secret))


def _v2_store(redis_client, request, *, aliases=None):
    namespace = f"v2-integration:{request.node.name}"
    allowed = aliases or frozenset({"primary", "backup1"})
    return RedisV2GeminiKeyCooldownStore(
        redis_client,
        namespace=namespace,
        allowed_aliases=allowed,
    )


def test_redis_04_two_manager_cooldown_cas(redis_client, request) -> None:
    store_a = _v2_store(redis_client, request)
    store_b = _v2_store(redis_client, request)
    scope = _v2_scope()
    first = store_a.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=30_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert first.status is PendingOperationStatus.APPLIED
    stale = store_b.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=20_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert stale.status is PendingOperationStatus.REJECTED
    fresh = store_b.apply_cooldown_cas(
        scope,
        expected_revision=first.revision,
        remaining_ms=25_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert fresh.status is PendingOperationStatus.APPLIED


def test_redis_05_two_manager_model_marker_cas(redis_client, request) -> None:
    store_a = _v2_store(redis_client, request)
    store_b = _v2_store(redis_client, request)
    scope = _v2_scope()
    model_scope = SharedStateScope(
        alias=scope.alias, fingerprint=scope.fingerprint, model="gemini-2.0-flash"
    )
    first = store_a.mark_model_unsupported_cas(model_scope, expected_revision=0)
    assert first.status is PendingOperationStatus.APPLIED
    stale = store_b.mark_model_unsupported_cas(model_scope, expected_revision=0)
    assert stale.status is PendingOperationStatus.REJECTED


def test_redis_09_stale_publish_wrong_expected_superseded(redis_client, request) -> None:
    store = _v2_store(redis_client, request)
    scope = _v2_scope()
    applied = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=900_000,
        reason="billing_credits_depleted",
        cooldown_type="hard",
    )
    assert applied.status is PendingOperationStatus.APPLIED
    stale = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=900_000,
        reason="billing_credits_depleted",
        cooldown_type="hard",
    )
    assert stale.status is PendingOperationStatus.REJECTED


def test_redis_14_fresh_publish_with_matching_ledger(redis_client, request) -> None:
    store = _v2_store(redis_client, request)
    scope = _v2_scope()
    snapshot = store.read_scope_snapshot(scope)
    assert snapshot.cooldown_revision == 0
    applied = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=60_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert applied.status is PendingOperationStatus.APPLIED
    assert applied.revision == 1


def test_redis_17_republish_uses_remaining_ms_not_original_duration(
    redis_client, request
) -> None:
    clock_ms = [1_700_000_000_000]

    def wall_clock_ms() -> int:
        return clock_ms[0]

    namespace = f"v2-integration:{request.node.name}:redis17"
    store = RedisV2GeminiKeyCooldownStore(
        redis_client,
        namespace=namespace,
        allowed_aliases=frozenset({"primary"}),
        wall_clock_ms=wall_clock_ms,
    )
    scope = _v2_scope()
    initial_ms = 900_000
    first = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=initial_ms,
        reason="billing_credits_depleted",
        cooldown_type="hard",
    )
    assert first.status is PendingOperationStatus.APPLIED
    clock_ms[0] += 100_000
    retry_ms = 800_000
    second = store.apply_cooldown_cas(
        scope,
        expected_revision=first.revision,
        remaining_ms=retry_ms,
        reason="billing_credits_depleted",
        cooldown_type="hard",
    )
    assert second.status is PendingOperationStatus.APPLIED
    assert second.final_remaining_ms is not None
    assert abs(second.final_remaining_ms - retry_ms) <= INTEGRATION_REMAINING_MS_TOLERANCE


def test_redis_19_invalid_scope_rejected_no_keys(redis_client, request) -> None:
    store = _v2_store(redis_client, request, aliases=frozenset({"primary"}))
    scope = _v2_scope(alias="unknown")
    result = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=30_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert result.status is PendingOperationStatus.REJECTED
    gemini_scope = scope.to_key_scope()
    assert redis_client.get(build_v2_cooldown_state_key(store.namespace, gemini_scope)) is None
    assert (
        redis_client.get(build_v2_cooldown_revision_key(store.namespace, gemini_scope))
        is None
    )


def test_redis_18_clear_superseded_then_refresh_clear(redis_client, request) -> None:
    store = _v2_store(redis_client, request)
    scope = _v2_scope()
    published = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=60_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert published.status is PendingOperationStatus.APPLIED
    stale_clear = store.clear_cooldown_cas(scope, expected_revision=0)
    assert stale_clear.status is PendingOperationStatus.REJECTED
    cleared = store.clear_cooldown_cas(
        scope, expected_revision=published.revision
    )
    assert cleared.status is PendingOperationStatus.APPLIED


def test_redis_13_ledger_survives_state_ttl_expiry(redis_client, request) -> None:
    store = _v2_store(redis_client, request)
    scope = _v2_scope()
    applied = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=50,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert applied.status is PendingOperationStatus.APPLIED
    gemini_scope = scope.to_key_scope()
    state_key = build_v2_cooldown_state_key(store.namespace, gemini_scope)
    rev_key = build_v2_cooldown_revision_key(store.namespace, gemini_scope)
    import time

    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if redis_client.pttl(state_key) <= 0:
            break
        time.sleep(0.02)
    assert int(redis_client.get(rev_key) or 0) >= 1
    stale = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=30_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert stale.status is PendingOperationStatus.REJECTED
