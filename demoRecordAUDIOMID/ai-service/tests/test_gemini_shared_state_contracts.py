"""Contract tests for Gemini shared-state operation types."""

from __future__ import annotations

import time

import pytest

from app.services.gemini_shared_state_contracts import (
    ApplyReconcileStatus,
    DesiredIntent,
    PendingOperationStatus,
    PendingSharedOperation,
    ReconcileReadSnapshot,
    RedisCallTiming,
    SharedStateScope,
    SharedWriteResult,
    UNIT_REMAINING_MS_TOLERANCE,
    apply_reconcile_plan_locked,
    apply_safe_anchored_deadline,
    build_reconcile_plan_locked,
    build_v2_cooldown_revision_key,
    build_v2_cooldown_state_key,
    build_v2_model_revision_key,
    build_v2_model_state_key,
    digest_for_raw,
    new_operation_id,
)
from app.services.gemini_key_cooldown_store import GeminiKeyScope, key_fingerprint


def _scope(alias: str = "primary") -> SharedStateScope:
    fp = key_fingerprint("fake-primary-key")
    return SharedStateScope(alias=alias, fingerprint=fp)


def test_shared_write_result_success_only_on_applied() -> None:
    applied = SharedWriteResult(
        status=PendingOperationStatus.APPLIED, final_remaining_ms=1000
    )
    superseded = SharedWriteResult(status=PendingOperationStatus.SUPERSEDED)
    assert applied.success is True
    assert superseded.success is False


def test_v2_key_builders() -> None:
    gemini_scope = GeminiKeyScope(alias="primary", fingerprint="abc123")
    ns = "offline-test:ai-service"
    assert build_v2_cooldown_state_key(ns, gemini_scope).endswith(":cooldown:primary")
    assert build_v2_cooldown_revision_key(ns, gemini_scope).endswith(":revision")
    assert ":model:primary:" in build_v2_model_state_key(
        ns, gemini_scope, "gemini-2.0-flash"
    )
    assert build_v2_model_revision_key(ns, gemini_scope, "gemini-2.0-flash").endswith(
        ":revision"
    )


def test_digest_for_raw() -> None:
    assert digest_for_raw(None) is None
    assert digest_for_raw("") is None
    assert digest_for_raw("payload") == digest_for_raw("payload")
    assert digest_for_raw("payload") != digest_for_raw("other")


def test_build_reconcile_plan_locked_no_redis_fields() -> None:
    scope = _scope()
    plan = build_reconcile_plan_locked(
        scope=scope,
        current_pending=None,
        desired_intent=DesiredIntent.PUBLISH,
        intent_revision=1,
        protected_deadline_monotonic=100.0,
        needs_redis_refresh=False,
    )
    assert plan.captured_intent_revision == 1
    assert plan.desired_intent is DesiredIntent.PUBLISH
    assert not hasattr(plan, "redis_call_started_monotonic")


def test_apply_reconcile_plan_locked_replan_on_intent_change() -> None:
    scope = _scope()
    plan = build_reconcile_plan_locked(
        scope=scope,
        current_pending=None,
        desired_intent=DesiredIntent.PUBLISH,
        intent_revision=1,
        protected_deadline_monotonic=100.0,
        needs_redis_refresh=True,
    )
    outcome = apply_reconcile_plan_locked(
        plan,
        ReconcileReadSnapshot(shared_snapshot=None),
        None,
        current_intent_revision=2,
        current_operation_id=None,
    )
    assert outcome.status is ApplyReconcileStatus.REPLAN_REQUIRED


def test_apply_safe_anchored_deadline_km16() -> None:
    start = 1000.0
    protected = 1900.0
    # Local publish: delayed response must not extend past protected deadline
    result = apply_safe_anchored_deadline(
        protected_deadline_monotonic=protected,
        redis_call_started_monotonic=start,
        final_remaining_ms=900_000,
        merged_from_shared_stronger=False,
    )
    assert result == pytest.approx(protected, abs=0.001)

    # Shared stronger merge may extend
    extended = apply_safe_anchored_deadline(
        protected_deadline_monotonic=protected,
        redis_call_started_monotonic=start,
        final_remaining_ms=900_000,
        merged_from_shared_stronger=True,
    )
    assert extended >= protected


def test_redis_call_timing_on_read_snapshot() -> None:
    timing = RedisCallTiming(started_at_monotonic=1.0, completed_at_monotonic=1.5)
    snapshot = ReconcileReadSnapshot(shared_snapshot=None, timing=timing)
    assert snapshot.timing is not None
    assert snapshot.timing.started_at_monotonic == 1.0


def test_unit_remaining_ms_tolerance_constant() -> None:
    assert UNIT_REMAINING_MS_TOLERANCE == 50


def test_pending_shared_operation_lineage_fields() -> None:
    now = time.monotonic()
    root = new_operation_id()
    op = PendingSharedOperation(
        operation_id=new_operation_id(),
        root_operation_id=root,
        operation_type="publish",
        scope=_scope(),
        local_revision=0,
        intent_revision=1,
        expected_shared_revision=0,
        expected_value_digest=None,
        reconcile_attempts=2,
        created_at_monotonic=now,
        next_retry_at_monotonic=now,
        operation_deadline_monotonic=now + 300,
        protected_state_expires_at_monotonic=now + 900,
    )
    assert op.root_operation_id == root
    assert op.reconcile_attempts == 2
