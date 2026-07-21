"""V2 Redis integration tests (REDIS-04..REDIS-21 mandatory subset)."""

from __future__ import annotations

import json

import pytest

from app.services.gemini_key_cooldown_store import key_fingerprint
from app.services.gemini_key_manager import (
    GeminiKeyEntry,
    GeminiKeyManager,
    LocalCooldownState,
)
from app.services.gemini_shared_state_contracts import (
    INTEGRATION_REMAINING_MS_TOLERANCE,
    MAX_RECONCILE_ATTEMPTS,
    ApplyReconcileStatus,
    DesiredIntent,
    PendingOperationResult,
    PendingOperationStatus,
    PendingSharedOperation,
    RedisCallTiming,
    SharedStateScope,
    build_v2_cooldown_revision_key,
    build_v2_cooldown_state_key,
    build_v2_model_revision_key,
    build_v2_model_state_key,
)
from app.services.gemini_shared_state_reconcile import (
    ReconcilePlanCapture,
    apply_reconcile_business_locked,
    build_publish_operation_locked,
    handle_operation_result,
    run_reconcile_loop,
)
from app.services.gemini_shared_state_store import RedisV2GeminiKeyCooldownStore

pytestmark = pytest.mark.redis_integration


@pytest.fixture(autouse=True)
def clean_redis(redis_client):
    redis_client.flushdb()
    yield
    redis_client.flushdb()


class MonotonicClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds

    def now_ms(self) -> int:
        return int(self.t * 1000)


def _v2_scope(
    alias: str = "primary", secret: str = "fake-primary-key"
) -> SharedStateScope:
    return SharedStateScope(alias=alias, fingerprint=key_fingerprint(secret))


def _v2_store(
    redis_client,
    request,
    *,
    aliases=None,
    clock: MonotonicClock | None = None,
):
    namespace = f"v2-integration:{request.node.name}"
    allowed = aliases or frozenset({"primary", "backup1"})
    kwargs = {
        "namespace": namespace,
        "allowed_aliases": allowed,
    }
    if clock is not None:
        kwargs["wall_clock_ms"] = clock.now_ms
    return RedisV2GeminiKeyCooldownStore(redis_client, **kwargs)


def _manager(store, clock: MonotonicClock) -> GeminiKeyManager:
    return GeminiKeyManager(
        [GeminiKeyEntry(alias="primary", secret="fake-primary-key")],
        clock=clock,
        wall_clock=clock,
        cooldown_store=store,
    )


def _is_tombstone(raw: str | None) -> bool:
    if not raw:
        return False
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return False
    return isinstance(parsed, dict) and parsed.get("cleared") is True


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
    assert stale.status is PendingOperationStatus.SUPERSEDED


def test_redis_09_stale_publish_wrong_expected_superseded(
    redis_client, request
) -> None:
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
    assert (
        abs(second.final_remaining_ms - retry_ms) <= INTEGRATION_REMAINING_MS_TOLERANCE
    )


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
    assert (
        redis_client.get(build_v2_cooldown_state_key(store.namespace, gemini_scope))
        is None
    )
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
    cleared = store.clear_cooldown_cas(scope, expected_revision=published.revision)
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


def test_redis_10_stale_model_publish_superseded(redis_client, request) -> None:
    """REDIS-10: stale model publish with wrong revision is SUPERSEDED."""
    store = _v2_store(redis_client, request)
    scope = _v2_scope()
    model_scope = SharedStateScope(
        alias=scope.alias,
        fingerprint=scope.fingerprint,
        model="gemini-2.0-flash",
    )
    first = store.mark_model_unsupported_cas(model_scope, expected_revision=0)
    assert first.status is PendingOperationStatus.APPLIED
    assert first.revision == 1

    gemini_scope = scope.to_key_scope()
    model_state_key = build_v2_model_state_key(
        store.namespace, gemini_scope, "gemini-2.0-flash"
    )
    model_rev_key = build_v2_model_revision_key(
        store.namespace, gemini_scope, "gemini-2.0-flash"
    )
    before_raw = redis_client.get(model_state_key)
    before_rev = int(redis_client.get(model_rev_key) or 0)

    stale = store.mark_model_unsupported_cas(model_scope, expected_revision=0)
    assert stale.status is PendingOperationStatus.SUPERSEDED
    assert stale.revision == before_rev
    assert int(redis_client.get(model_rev_key) or 0) == before_rev
    assert redis_client.get(model_state_key) == before_raw

    cooldown = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=30_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert cooldown.status is PendingOperationStatus.APPLIED
    snapshot = store.read_scope_snapshot(scope, model="gemini-2.0-flash")
    assert snapshot.model_unsupported is True
    assert snapshot.cooldown_state is not None


def test_redis_11_fresh_publish_after_tombstone_matching_revision(
    redis_client, request
) -> None:
    """REDIS-11: publish at matching tombstone revision creates active state."""
    store = _v2_store(redis_client, request)
    scope = _v2_scope()
    applied = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=60_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert applied.status is PendingOperationStatus.APPLIED
    assert applied.revision == 1

    cleared = store.clear_cooldown_cas(scope, expected_revision=1)
    assert cleared.status is PendingOperationStatus.APPLIED
    assert cleared.revision == 2

    gemini_scope = scope.to_key_scope()
    state_key = build_v2_cooldown_state_key(store.namespace, gemini_scope)
    assert _is_tombstone(redis_client.get(state_key))

    republished = store.apply_cooldown_cas(
        scope,
        expected_revision=2,
        remaining_ms=45_000,
        reason="billing_credits_depleted",
        cooldown_type="hard",
    )
    assert republished.status is PendingOperationStatus.APPLIED
    assert republished.revision == 3

    raw = redis_client.get(state_key)
    assert raw is not None
    assert not _is_tombstone(raw)
    snapshot = store.read_scope_snapshot(scope)
    assert snapshot.cooldown_state is not None
    assert snapshot.cooldown_state.cooldown_type == "hard"
    assert snapshot.cooldown_revision == 3


def test_redis_12_superseded_publish_refresh_merge_republish(
    redis_client, request
) -> None:
    """REDIS-12: SUPERSEDED publish converges to local hard cooldown via reconcile."""
    clock = MonotonicClock()
    store = _v2_store(redis_client, request, clock=clock)
    scope = _v2_scope()
    manager = _manager(store, clock)

    store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=60_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    protected = clock() + 900.0
    root_id = "root-redis-12"
    pending = PendingSharedOperation(
        operation_id="attempt-stale",
        root_operation_id=root_id,
        operation_type="publish",
        scope=scope,
        local_revision=0,
        intent_revision=1,
        expected_shared_revision=0,
        expected_value_digest=None,
        reconcile_attempts=0,
        created_at_monotonic=clock(),
        next_retry_at_monotonic=clock(),
        operation_deadline_monotonic=protected,
        protected_state_expires_at_monotonic=protected,
    )
    stale_write = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=900_000,
        reason="billing_credits_depleted",
        cooldown_type="hard",
    )
    assert stale_write.status is PendingOperationStatus.REJECTED

    stale_result = PendingOperationResult(
        operation_id="attempt-stale",
        status=stale_write.status,
        write_result=stale_write,
        timing=RedisCallTiming(
            started_at_monotonic=clock(), completed_at_monotonic=clock()
        ),
    )

    def capture_plan_locked() -> ReconcilePlanCapture:
        with manager._lock:
            return manager._capture_reconcile_plan_locked(
                scope=scope,
                desired_intent=DesiredIntent.PUBLISH,
                pending=pending,
                protected_deadline_monotonic=protected,
                needs_redis_refresh=True,
            )

    def apply_locked(plan, read_snapshot, operation_result):
        with manager._lock:
            return manager._apply_reconcile_locked(
                plan,
                read_snapshot,
                operation_result,
                pending=pending,
                desired_intent=DesiredIntent.PUBLISH,
                publish_reason="billing_credits_depleted",
                publish_cooldown_type="hard",
            )

    outcome = handle_operation_result(
        scope=scope,
        store=store,
        clock=clock,
        operation_result=stale_result,
        capture_plan_locked=capture_plan_locked,
        apply_locked=apply_locked,
    )
    assert outcome.status is ApplyReconcileStatus.CONVERGED

    snapshot = store.read_scope_snapshot(scope)
    assert snapshot.cooldown_state is not None
    assert snapshot.cooldown_state.reason == "billing_credits_depleted"
    assert snapshot.cooldown_state.cooldown_type == "hard"
    assert snapshot.cooldown_revision >= 2
    remaining_ms = snapshot.cooldown_pttl_ms
    assert remaining_ms > 800_000 - INTEGRATION_REMAINING_MS_TOLERANCE
    assert remaining_ms <= 900_000 + INTEGRATION_REMAINING_MS_TOLERANCE


def test_redis_15_old_publish_applied_desired_clear(redis_client, request) -> None:
    """REDIS-15: late publish APPLIED with desired CLEAR ends in tombstone."""
    clock = MonotonicClock()
    store = _v2_store(redis_client, request, clock=clock)
    scope = _v2_scope()
    manager = _manager(store, clock)
    protected = clock() + 900.0
    pending = build_publish_operation_locked(
        scope=scope,
        intent_revision=1,
        protected_deadline_monotonic=protected,
        expected_shared_revision=0,
        expected_value_digest=None,
        current_pending=None,
        clock=clock,
        reason="billing_credits_depleted",
        cooldown_type="hard",
    )
    started = clock()
    applied = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=900_000,
        reason="billing_credits_depleted",
        cooldown_type="hard",
    )
    completed = clock() + 0.5
    assert applied.status is PendingOperationStatus.APPLIED
    assert applied.revision == 1

    with manager._lock:
        manager._local_cooldown.pop("primary", None)
        state = manager._states.get("primary")
        if state is not None:
            state.disabled_until_monotonic = 0.0
        manager._bump_cooldown_intent_locked("primary")
        clear_intent = manager._intent_revisions["primary"]

    pending = PendingSharedOperation(
        **{
            **pending.__dict__,
            "intent_revision": clear_intent,
        }
    )

    op_result = PendingOperationResult(
        operation_id=pending.operation_id,
        status=PendingOperationStatus.APPLIED,
        write_result=applied,
        timing=RedisCallTiming(
            started_at_monotonic=started,
            completed_at_monotonic=completed,
        ),
    )

    def capture_plan_locked() -> ReconcilePlanCapture:
        with manager._lock:
            return manager._capture_reconcile_plan_locked(
                scope=scope,
                desired_intent=DesiredIntent.CLEAR,
                pending=pending,
                protected_deadline_monotonic=protected,
                needs_redis_refresh=False,
            )

    def apply_locked(plan, read_snapshot, operation_result):
        with manager._lock:
            return manager._apply_reconcile_locked(
                plan,
                read_snapshot,
                operation_result,
                pending=pending,
                desired_intent=DesiredIntent.CLEAR,
            )

    outcome = handle_operation_result(
        scope=scope,
        store=store,
        clock=clock,
        operation_result=op_result,
        capture_plan_locked=capture_plan_locked,
        apply_locked=apply_locked,
    )
    assert outcome.status is ApplyReconcileStatus.CONVERGED

    gemini_scope = scope.to_key_scope()
    state_key = build_v2_cooldown_state_key(store.namespace, gemini_scope)
    rev_key = build_v2_cooldown_revision_key(store.namespace, gemini_scope)
    raw = redis_client.get(state_key)
    assert raw is not None
    assert _is_tombstone(raw)
    assert int(redis_client.get(rev_key) or 0) >= 2
    snapshot = store.read_scope_snapshot(scope)
    assert snapshot.cooldown_state is None
    assert manager.select_key().available is True


def test_redis_16_old_clear_applied_desired_publish(redis_client, request) -> None:
    """REDIS-16: late clear APPLIED with desired PUBLISH restores active cooldown."""
    clock = MonotonicClock()
    store = _v2_store(redis_client, request, clock=clock)
    scope = _v2_scope()
    manager = _manager(store, clock)
    protected = clock() + 600.0

    store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=900_000,
        reason="billing_credits_depleted",
        cooldown_type="hard",
    )
    pending_clear = PendingSharedOperation(
        operation_id="clear-attempt",
        root_operation_id="root-redis-16",
        operation_type="clear",
        scope=scope,
        local_revision=0,
        intent_revision=1,
        expected_shared_revision=1,
        expected_value_digest=None,
        reconcile_attempts=0,
        created_at_monotonic=clock(),
        next_retry_at_monotonic=clock(),
        operation_deadline_monotonic=clock() + 300,
        protected_state_expires_at_monotonic=None,
    )
    started = clock()
    cleared = store.clear_cooldown_cas(scope, expected_revision=1)
    completed = clock() + 0.5
    assert cleared.status is PendingOperationStatus.APPLIED
    assert cleared.revision == 2

    with manager._lock:
        manager._local_cooldown["primary"] = LocalCooldownState(
            reason="billing_credits_depleted",
            cooldown_type="hard",
            expires_at_monotonic=protected,
        )
        manager._bump_cooldown_intent_locked("primary")
        publish_intent = manager._intent_revisions["primary"]

    pending_clear = PendingSharedOperation(
        **{
            **pending_clear.__dict__,
            "intent_revision": publish_intent,
        }
    )

    op_result = PendingOperationResult(
        operation_id=pending_clear.operation_id,
        status=PendingOperationStatus.APPLIED,
        write_result=cleared,
        timing=RedisCallTiming(
            started_at_monotonic=started,
            completed_at_monotonic=completed,
        ),
    )

    def capture_plan_locked() -> ReconcilePlanCapture:
        with manager._lock:
            return manager._capture_reconcile_plan_locked(
                scope=scope,
                desired_intent=DesiredIntent.PUBLISH,
                pending=pending_clear,
                protected_deadline_monotonic=protected,
                needs_redis_refresh=False,
            )

    def apply_locked(plan, read_snapshot, operation_result):
        with manager._lock:
            return manager._apply_reconcile_locked(
                plan,
                read_snapshot,
                operation_result,
                pending=pending_clear,
                desired_intent=DesiredIntent.PUBLISH,
                publish_reason="billing_credits_depleted",
                publish_cooldown_type="hard",
            )

    outcome = handle_operation_result(
        scope=scope,
        store=store,
        clock=clock,
        operation_result=op_result,
        capture_plan_locked=capture_plan_locked,
        apply_locked=apply_locked,
    )
    assert outcome.status is ApplyReconcileStatus.CONVERGED

    gemini_scope = scope.to_key_scope()
    state_key = build_v2_cooldown_state_key(store.namespace, gemini_scope)
    raw = redis_client.get(state_key)
    assert raw is not None
    assert not _is_tombstone(raw)
    snapshot = store.read_scope_snapshot(scope)
    assert snapshot.cooldown_state is not None
    assert snapshot.cooldown_state.cooldown_type == "hard"
    assert snapshot.cooldown_pttl_ms > 0
    assert snapshot.cooldown_pttl_ms <= 600_000 + INTEGRATION_REMAINING_MS_TOLERANCE


def test_redis_20_shared_stronger_safe_anchored_deadline(redis_client, request) -> None:
    """REDIS-20: shared-stronger merge extends deadline via call-start anchor only."""
    from app.services.gemini_shared_state_contracts import build_reconcile_plan_locked

    clock = MonotonicClock()
    store = _v2_store(redis_client, request, clock=clock)
    scope = _v2_scope()

    store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=900_000,
        reason="billing_credits_depleted",
        cooldown_type="hard",
    )
    protected = clock() + 300.0
    started = clock()
    write = store.apply_cooldown_cas(
        scope,
        expected_revision=1,
        remaining_ms=60_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    delayed_completed = clock() + 120.0
    assert write.merged_from_shared_stronger is True
    assert write.final_remaining_ms is not None
    assert write.final_remaining_ms > 60_000

    pending = build_publish_operation_locked(
        scope=scope,
        intent_revision=1,
        protected_deadline_monotonic=protected,
        expected_shared_revision=1,
        expected_value_digest=None,
        current_pending=None,
        clock=clock,
        reason="rate_limit",
        cooldown_type="soft",
    )

    op_result = PendingOperationResult(
        operation_id=pending.operation_id,
        status=PendingOperationStatus.APPLIED,
        write_result=write,
        timing=RedisCallTiming(
            started_at_monotonic=started,
            completed_at_monotonic=delayed_completed,
        ),
    )

    outcome, _, _ = apply_reconcile_business_locked(
        build_reconcile_plan_locked(
            scope=scope,
            current_pending=pending,
            desired_intent=DesiredIntent.PUBLISH,
            intent_revision=1,
            protected_deadline_monotonic=protected,
            needs_redis_refresh=False,
        ),
        None,
        op_result,
        current_intent_revision=1,
        current_operation_id=pending.operation_id,
        current_pending=pending,
        desired_intent=DesiredIntent.PUBLISH,
        clock=clock,
    )
    assert outcome.status is ApplyReconcileStatus.CONVERGED
    anchored = pending.protected_state_expires_at_monotonic
    assert anchored is not None
    expected_floor = started + write.final_remaining_ms / 1000.0
    assert anchored >= expected_floor - 1.0
    assert anchored <= expected_floor + 1.0
    assert anchored > protected + 100.0
    wrong_if_receive_time = delayed_completed + write.final_remaining_ms / 1000.0
    assert anchored < wrong_if_receive_time - 100.0


def test_redis_21_convergence_conflict_budget(redis_client, request) -> None:
    """REDIS-21: continuous conflicts stop at reconcile budget with bounded Redis I/O."""
    from app.services.gemini_shared_state_contracts import (
        SharedWriteResult,
        build_reconcile_plan_locked,
    )

    clock = MonotonicClock()
    store = _v2_store(redis_client, request, clock=clock)
    scope = _v2_scope()
    root_id = "root-redis-21"
    protected = clock() + 900.0

    store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=60_000,
        reason="rate_limit",
        cooldown_type="soft",
    )

    pending = PendingSharedOperation(
        operation_id="attempt-0",
        root_operation_id=root_id,
        operation_type="publish",
        scope=scope,
        local_revision=0,
        intent_revision=1,
        expected_shared_revision=0,
        expected_value_digest=None,
        reconcile_attempts=0,
        created_at_monotonic=clock(),
        next_retry_at_monotonic=clock(),
        operation_deadline_monotonic=protected,
        protected_state_expires_at_monotonic=protected,
    )

    read_calls = {"count": 0}
    write_calls = {"count": 0}
    original_read = store.read_scope_snapshot
    original_apply = store.apply_cooldown_cas

    def counting_read(*args, **kwargs):
        read_calls["count"] += 1
        return original_read(*args, **kwargs)

    def counting_apply(scope_arg, *, expected_revision, **kwargs):
        write_calls["count"] += 1
        snapshot = original_read(scope_arg)
        current_rev = snapshot.cooldown_revision
        if expected_revision == current_rev and current_rev > 0:
            original_apply(
                scope_arg,
                expected_revision=current_rev,
                remaining_ms=45_000,
                reason="rate_limit",
                cooldown_type="soft",
            )
        return original_apply(
            scope_arg,
            expected_revision=expected_revision,
            **kwargs,
        )

    store.read_scope_snapshot = counting_read  # type: ignore[method-assign]
    store.apply_cooldown_cas = counting_apply  # type: ignore[method-assign]

    attempt_ids: list[str] = [pending.operation_id]
    reconcile_attempts_seen: list[int] = [0]

    def capture_plan_locked() -> ReconcilePlanCapture:
        return ReconcilePlanCapture(
            plan=build_reconcile_plan_locked(
                scope=scope,
                current_pending=pending,
                desired_intent=DesiredIntent.PUBLISH,
                intent_revision=1,
                protected_deadline_monotonic=protected,
                needs_redis_refresh=True,
            ),
            current_intent_revision=1,
            current_operation_id=pending.operation_id,
        )

    def apply_locked(plan, read_snapshot, operation_result):
        nonlocal pending
        outcome, updated, convergence = apply_reconcile_business_locked(
            plan,
            read_snapshot,
            operation_result,
            current_intent_revision=1,
            current_operation_id=pending.operation_id,
            current_pending=pending,
            desired_intent=DesiredIntent.PUBLISH,
            clock=clock,
            publish_reason="rate_limit",
            publish_cooldown_type="soft",
        )
        if convergence is not None:
            pending = convergence.operation
            attempt_ids.append(pending.operation_id)
            reconcile_attempts_seen.append(pending.reconcile_attempts)
        elif updated is not None:
            pending = updated
        return outcome, updated, convergence

    stale = PendingOperationResult(
        operation_id=pending.operation_id,
        status=PendingOperationStatus.REJECTED,
        write_result=SharedWriteResult(
            status=PendingOperationStatus.REJECTED,
            revision=1,
        ),
        timing=RedisCallTiming(
            started_at_monotonic=clock(), completed_at_monotonic=clock()
        ),
    )

    outcome = run_reconcile_loop(
        scope=scope,
        store=store,
        clock=clock,
        capture_plan_locked=capture_plan_locked,
        apply_locked=apply_locked,
        initial_operation_result=stale,
    )

    assert outcome.status is ApplyReconcileStatus.TERMINAL_FAILURE
    assert len(set(attempt_ids)) == len(attempt_ids)
    assert all(
        reconcile_attempts_seen[i] <= reconcile_attempts_seen[i + 1]
        for i in range(len(reconcile_attempts_seen) - 1)
    )
    assert pending.root_operation_id == root_id
    assert read_calls["count"] <= MAX_RECONCILE_ATTEMPTS + 2
    assert write_calls["count"] <= MAX_RECONCILE_ATTEMPTS


def test_v2_final_validation_blocks_state_created_after_selection(
    redis_client, request
) -> None:
    clock = MonotonicClock()
    store = _v2_store(redis_client, request, clock=clock)
    manager = _manager(store, clock)
    scope = _v2_scope()
    selection = manager.select_key(model="gemini-3.1-flash-lite")
    assert selection.available is True

    current = store.read_scope_snapshot(scope)
    applied = store.apply_cooldown_cas(
        scope,
        expected_revision=current.cooldown_revision,
        expected_digest=current.cooldown_digest,
        remaining_ms=30_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert applied.status is PendingOperationStatus.APPLIED
    assert manager.validate_selection(selection, model="gemini-3.1-flash-lite") is False
