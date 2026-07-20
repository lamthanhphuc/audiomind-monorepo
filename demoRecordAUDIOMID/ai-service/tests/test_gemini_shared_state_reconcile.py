"""Reconcile loop and manager integration tests (KM-15..17, LOCK-08, PERF-06/07)."""

from __future__ import annotations

import threading
from unittest.mock import patch

import pytest

from app.services.gemini_key_cooldown_store import key_fingerprint
from app.services.gemini_key_manager import GeminiKeyManager
from app.services.gemini_shared_state_contracts import (
    ApplyReconcileOutcome,
    ApplyReconcileStatus,
    DesiredIntent,
    PendingOperationResult,
    PendingOperationStatus,
    PendingSharedOperation,
    ReconcilePlan,
    RedisCallTiming,
    SharedStateScope,
    SharedWriteResult,
    apply_safe_anchored_deadline,
    build_reconcile_plan_locked,
)
from app.services.gemini_shared_state_reconcile import (
    ReconcilePlanCapture,
    apply_applied_publish_locked,
    apply_reconcile_business_locked,
    execute_reconcile_reads_unlocked,
    handle_operation_result,
    run_reconcile_loop,
)
from app.services.gemini_shared_state_store import InMemoryV2GeminiKeyCooldownStore


class FakeClock:
    def __init__(self, now: float = 1000.0) -> None:
        self.now = now
        self._ms = int(now * 1000)

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds
        self._ms = int(self.now * 1000)

    def now_ms(self) -> int:
        return self._ms


def _scope(alias: str = "primary") -> SharedStateScope:
    return SharedStateScope(
        alias=alias,
        fingerprint=key_fingerprint("fake-primary-key"),
    )


def _v2_store(clock: FakeClock) -> InMemoryV2GeminiKeyCooldownStore:
    return InMemoryV2GeminiKeyCooldownStore(
        namespace="offline-test:ai-service",
        allowed_aliases=frozenset({"primary", "backup1"}),
        wall_clock_ms=clock.now_ms,
    )


def _manager(clock: FakeClock | None = None, store=None) -> GeminiKeyManager:
    clock = clock or FakeClock()
    return GeminiKeyManager.from_config(
        gemini_api_key="fake-primary-key",
        gemini_api_keys="",
        multi_key_enabled=False,
        clock=clock,
        wall_clock=clock,
        cooldown_store=store,
    )


def test_km_16_delayed_applied_does_not_extend_protected_deadline() -> None:
    protected = 1900.0
    start = 1000.0
    result = apply_safe_anchored_deadline(
        protected_deadline_monotonic=protected,
        redis_call_started_monotonic=start,
        final_remaining_ms=900_000,
        merged_from_shared_stronger=False,
    )
    assert result == pytest.approx(protected, abs=0.001)

    op_result = PendingOperationResult(
        operation_id="op-1",
        status=PendingOperationStatus.APPLIED,
        write_result=SharedWriteResult(
            status=PendingOperationStatus.APPLIED,
            final_remaining_ms=900_000,
            merged_from_shared_stronger=False,
        ),
        timing=RedisCallTiming(started_at_monotonic=start, completed_at_monotonic=1500.0),
    )
    anchored = apply_applied_publish_locked(
        protected_deadline_monotonic=protected,
        operation_result=op_result,
    )
    assert anchored == pytest.approx(protected, abs=0.001)


def test_km_15_intent_change_during_phase_b_replans() -> None:
    clock = FakeClock()
    store = _v2_store(clock)
    scope = _scope()
    lock = threading.RLock()
    intent_revision = {"value": 1}

    def capture_plan_locked() -> ReconcilePlanCapture | None:
        with lock:
            plan = build_reconcile_plan_locked(
                scope=scope,
                current_pending=None,
                desired_intent=DesiredIntent.PUBLISH,
                intent_revision=intent_revision["value"],
                protected_deadline_monotonic=clock() + 900,
                needs_redis_refresh=True,
            )
            return ReconcilePlanCapture(
                plan=plan,
                current_intent_revision=intent_revision["value"],
                current_operation_id=None,
            )

    read_started = threading.Event()

    def apply_locked(plan, read_snapshot, operation_result):
        with lock:
            if read_snapshot is not None and read_snapshot.timing is not None:
                read_started.set()
                intent_revision["value"] = 2
            outcome, pending, convergence = apply_reconcile_business_locked(
                plan,
                read_snapshot,
                operation_result,
                current_intent_revision=intent_revision["value"],
                current_operation_id=plan.captured_operation_id or None,
                current_pending=None,
                desired_intent=DesiredIntent.CLEAR,
                clock=clock,
            )
            return outcome, pending, convergence

    with patch(
        "app.services.gemini_shared_state_reconcile.execute_reconcile_reads_unlocked",
        wraps=execute_reconcile_reads_unlocked,
    ) as read_mock:
        outcome = run_reconcile_loop(
            scope=scope,
            store=store,
            clock=clock,
            capture_plan_locked=capture_plan_locked,
            apply_locked=apply_locked,
        )
        assert read_mock.called

    assert read_started.is_set()
    assert outcome.status in (
        ApplyReconcileStatus.REPLAN_REQUIRED,
        ApplyReconcileStatus.CONVERGED,
        ApplyReconcileStatus.TERMINAL_FAILURE,
    )


def test_km_17_superseded_retries_preserve_root_and_attempts() -> None:
    clock = FakeClock()
    store = _v2_store(clock)
    scope = _scope()
    root_id = "root-op-abc"
    pending = PendingSharedOperation(
        operation_id="attempt-1",
        root_operation_id=root_id,
        operation_type="publish",
        scope=scope,
        local_revision=0,
        intent_revision=1,
        expected_shared_revision=0,
        expected_value_digest=None,
        reconcile_attempts=1,
        created_at_monotonic=clock(),
        next_retry_at_monotonic=clock(),
        operation_deadline_monotonic=clock() + 900,
        protected_state_expires_at_monotonic=clock() + 900,
    )
    plan = build_reconcile_plan_locked(
        scope=scope,
        current_pending=pending,
        desired_intent=DesiredIntent.PUBLISH,
        intent_revision=1,
        protected_deadline_monotonic=clock() + 900,
        needs_redis_refresh=False,
    )
    superseded = PendingOperationResult(
        operation_id="attempt-1",
        status=PendingOperationStatus.SUPERSEDED,
        write_result=SharedWriteResult(status=PendingOperationStatus.SUPERSEDED),
        timing=RedisCallTiming(started_at_monotonic=clock(), completed_at_monotonic=clock()),
    )
    outcome, updated_pending, convergence = apply_reconcile_business_locked(
        plan,
        None,
        superseded,
        current_intent_revision=1,
        current_operation_id="attempt-1",
        current_pending=pending,
        desired_intent=DesiredIntent.PUBLISH,
        clock=clock,
    )
    assert outcome.status is ApplyReconcileStatus.OPERATION_ENQUEUED
    assert convergence is not None
    assert convergence.operation.root_operation_id == root_id
    assert convergence.operation.reconcile_attempts == 2
    assert convergence.operation.operation_id != "attempt-1"


def test_lock_08_reconcile_read_outside_manager_lock() -> None:
    clock = FakeClock()
    store = _v2_store(clock)
    manager = _manager(clock, store)
    lock_held = threading.Event()
    release_lock = threading.Event()
    read_during_lock = {"value": False}

    original_read = store.read_scope_snapshot

    def instrumented_read(*args, **kwargs):
        if not manager._lock.acquire(blocking=False):
            read_during_lock["value"] = True
        else:
            manager._lock.release()
        return original_read(*args, **kwargs)

    store.read_scope_snapshot = instrumented_read  # type: ignore[method-assign]

    def capture_plan_locked() -> ReconcilePlanCapture:
        with manager._lock:
            lock_held.set()
            assert release_lock.wait(timeout=2)
            return manager._capture_reconcile_plan_locked(
                scope=_scope(),
                desired_intent=DesiredIntent.PUBLISH,
                pending=None,
                protected_deadline_monotonic=clock() + 900,
                needs_redis_refresh=True,
            )

    def apply_locked(plan, read_snapshot, operation_result):
        with manager._lock:
            return manager._apply_reconcile_locked(
                plan,
                read_snapshot,
                operation_result,
                pending=None,
                desired_intent=DesiredIntent.PUBLISH,
            )

    thread = threading.Thread(
        target=lambda: run_reconcile_loop(
            scope=_scope(),
            store=store,
            clock=clock,
            capture_plan_locked=capture_plan_locked,
            apply_locked=apply_locked,
        )
    )
    thread.start()
    assert lock_held.wait(timeout=2)
    release_lock.set()
    thread.join(timeout=2)
    assert not thread.is_alive()
    assert read_during_lock["value"] is False


def test_perf_06_one_superseded_triggers_at_most_one_refresh_read() -> None:
    clock = FakeClock()
    store = _v2_store(clock)
    scope = _scope()
    read_calls = {"count": 0}
    original = store.read_scope_snapshot

    def counting_read(*args, **kwargs):
        read_calls["count"] += 1
        return original(*args, **kwargs)

    store.read_scope_snapshot = counting_read  # type: ignore[method-assign]

    pending = PendingSharedOperation(
        operation_id="attempt-1",
        root_operation_id="root-1",
        operation_type="publish",
        scope=scope,
        local_revision=0,
        intent_revision=1,
        expected_shared_revision=0,
        expected_value_digest=None,
        reconcile_attempts=0,
        created_at_monotonic=clock(),
        next_retry_at_monotonic=clock(),
        operation_deadline_monotonic=clock() + 900,
        protected_state_expires_at_monotonic=clock() + 900,
    )
    superseded = PendingOperationResult(
        operation_id="attempt-1",
        status=PendingOperationStatus.SUPERSEDED,
        write_result=SharedWriteResult(status=PendingOperationStatus.SUPERSEDED),
        timing=RedisCallTiming(started_at_monotonic=clock(), completed_at_monotonic=clock()),
    )

    handle_operation_result(
        scope=scope,
        store=store,
        clock=clock,
        operation_result=superseded,
        capture_plan_locked=lambda: ReconcilePlanCapture(
            plan=build_reconcile_plan_locked(
                scope=scope,
                current_pending=pending,
                desired_intent=DesiredIntent.PUBLISH,
                intent_revision=1,
                protected_deadline_monotonic=clock() + 900,
                needs_redis_refresh=False,
            ),
            current_intent_revision=1,
            current_operation_id="attempt-1",
        ),
        apply_locked=lambda plan, read_snapshot, op_result: apply_reconcile_business_locked(
            plan,
            read_snapshot,
            op_result,
            current_intent_revision=1,
            current_operation_id="attempt-1",
            current_pending=pending,
            desired_intent=DesiredIntent.PUBLISH,
            clock=clock,
        ),
    )
    assert read_calls["count"] <= 1


def test_perf_07_reconcile_stops_at_max_attempts() -> None:
    clock = FakeClock()
    store = _v2_store(clock)
    scope = _scope()
    attempts = {"count": 0}

    def capture_plan_locked() -> ReconcilePlanCapture:
        attempts["count"] += 1
        return ReconcilePlanCapture(
            plan=ReconcilePlan(
                scope=scope,
                captured_operation_id="",
                captured_intent_revision=attempts["count"],
                desired_intent=DesiredIntent.PUBLISH,
                needs_redis_refresh=False,
                protected_deadline_monotonic=clock() + 900,
                root_operation_id="root-1",
                reconcile_attempts=attempts["count"],
            ),
            current_intent_revision=attempts["count"],
            current_operation_id=None,
        )

    def apply_locked(plan, read_snapshot, operation_result):
        return (
            ApplyReconcileOutcome(status=ApplyReconcileStatus.REPLAN_REQUIRED),
            None,
            None,
        )

    outcome = run_reconcile_loop(
        scope=scope,
        store=store,
        clock=clock,
        capture_plan_locked=capture_plan_locked,
        apply_locked=apply_locked,
    )
    assert outcome.status is ApplyReconcileStatus.TERMINAL_FAILURE
    assert attempts["count"] <= 6
