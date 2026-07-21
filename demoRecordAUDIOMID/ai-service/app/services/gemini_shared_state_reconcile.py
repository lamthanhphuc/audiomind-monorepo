"""Three-phase Gemini shared-state reconciliation (plan → read → apply)."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Literal, Protocol

from app.services.gemini_shared_state_contracts import (
    MAX_RECONCILE_ATTEMPTS,
    PENDING_CLEAR_MAX_LIFETIME_SECONDS,
    ApplyReconcileOutcome,
    ApplyReconcileStatus,
    DesiredIntent,
    PendingOperationResult,
    PendingOperationStatus,
    PendingSharedOperation,
    ReconcilePlan,
    ReconcileReadSnapshot,
    RedisCallTiming,
    SharedScopeSnapshot,
    SharedStateScope,
    SharedStoreErrorType,
    SharedWriteResult,
    apply_reconcile_plan_locked,
    apply_safe_anchored_deadline,
    new_operation_id,
    scope_from_gemini,
)


class V2SharedStateStore(Protocol):
    def read_scope_snapshot(
        self, scope: SharedStateScope, *, model: str = ""
    ) -> SharedScopeSnapshot: ...

    def apply_cooldown_cas(
        self,
        scope: SharedStateScope,
        *,
        expected_revision: int,
        remaining_ms: int,
        reason: str | None,
        cooldown_type: str | None,
        expected_digest: str | None = None,
    ) -> SharedWriteResult: ...

    def clear_cooldown_cas(
        self,
        scope: SharedStateScope,
        *,
        expected_revision: int,
        expected_digest: str | None = None,
    ) -> SharedWriteResult: ...

    def mark_model_unsupported_cas(
        self,
        scope: SharedStateScope,
        *,
        expected_revision: int,
        expected_digest: str | None = None,
    ) -> SharedWriteResult: ...

    def clear_model_unsupported_cas(
        self,
        scope: SharedStateScope,
        *,
        expected_revision: int,
        expected_digest: str | None = None,
    ) -> SharedWriteResult: ...


@dataclass(frozen=True)
class ReconcilePlanCapture:
    plan: ReconcilePlan
    current_intent_revision: int
    current_operation_id: str | None


@dataclass(frozen=True)
class ConvergenceWriteRequest:
    operation: PendingSharedOperation
    remaining_ms: int
    reason: str | None = None
    cooldown_type: str | None = None


def execute_reconcile_reads_unlocked(
    plan: ReconcilePlan,
    store: V2SharedStateStore,
    clock: Callable[[], float],
) -> ReconcileReadSnapshot:
    """PHASE B — Redis snapshot read outside manager lock."""
    if not plan.needs_redis_refresh:
        return ReconcileReadSnapshot(shared_snapshot=None)

    started = clock()
    try:
        model = plan.scope.model if plan.scope.is_model else ""
        snapshot = store.read_scope_snapshot(plan.scope, model=model)
    except Exception:
        completed = clock()
        return ReconcileReadSnapshot(
            shared_snapshot=None,
            timing=RedisCallTiming(
                started_at_monotonic=started,
                completed_at_monotonic=completed,
            ),
            error_type=SharedStoreErrorType.TRANSPORT_ERROR,
        )
    completed = clock()
    return ReconcileReadSnapshot(
        shared_snapshot=snapshot,
        timing=RedisCallTiming(
            started_at_monotonic=started,
            completed_at_monotonic=completed,
        ),
    )


def apply_applied_publish_locked(
    *,
    protected_deadline_monotonic: float,
    operation_result: PendingOperationResult,
) -> float:
    """Apply safe-anchored deadline from Redis call start (KM-16)."""
    write = operation_result.write_result
    timing = operation_result.timing
    if write is None or timing is None or write.final_remaining_ms is None:
        return protected_deadline_monotonic
    return apply_safe_anchored_deadline(
        protected_deadline_monotonic=protected_deadline_monotonic,
        redis_call_started_monotonic=timing.started_at_monotonic,
        final_remaining_ms=write.final_remaining_ms,
        merged_from_shared_stronger=bool(write.merged_from_shared_stronger),
    )


def _needs_refresh_for_write(write: SharedWriteResult | None) -> bool:
    if write is None:
        return False
    return write.status in (
        PendingOperationStatus.SUPERSEDED,
        PendingOperationStatus.REJECTED,
    )


def _operation_result_from_write(
    operation_id: str,
    write: SharedWriteResult,
    *,
    started: float,
    completed: float,
) -> PendingOperationResult:
    return PendingOperationResult(
        operation_id=operation_id,
        status=write.status,
        write_result=write,
        timing=RedisCallTiming(
            started_at_monotonic=started,
            completed_at_monotonic=completed,
        ),
    )


def apply_reconcile_business_locked(
    plan: ReconcilePlan,
    read_snapshot: ReconcileReadSnapshot | None,
    operation_result: PendingOperationResult | None,
    *,
    current_intent_revision: int,
    current_operation_id: str | None,
    current_pending: PendingSharedOperation | None,
    desired_intent: DesiredIntent,
    clock: Callable[[], float],
    publish_reason: str | None = None,
    publish_cooldown_type: str | None = None,
) -> tuple[
    ApplyReconcileOutcome, PendingSharedOperation | None, ConvergenceWriteRequest | None
]:
    """PHASE C — contract guard plus APPLIED/SUPERSEDED/FAILED routing."""
    base = apply_reconcile_plan_locked(
        plan,
        read_snapshot,
        operation_result,
        current_intent_revision=current_intent_revision,
        current_operation_id=current_operation_id,
    )
    if base.status is ApplyReconcileStatus.REPLAN_REQUIRED:
        return base, current_pending, None

    if operation_result is None:
        return base, current_pending, None

    if (
        plan.captured_operation_id
        and operation_result.operation_id != plan.captured_operation_id
    ):
        return (
            ApplyReconcileOutcome(status=ApplyReconcileStatus.CONVERGED),
            current_pending,
            None,
        )

    write = operation_result.write_result
    if write is None:
        return (
            _handle_failed_locked(plan, current_pending, clock=clock),
            current_pending,
            None,
        )

    if write.status is PendingOperationStatus.APPLIED:
        return _handle_applied_locked(
            plan,
            operation_result,
            current_pending=current_pending,
            desired_intent=desired_intent,
            clock=clock,
            publish_reason=publish_reason,
            publish_cooldown_type=publish_cooldown_type,
        )

    if write.status is PendingOperationStatus.SUPERSEDED:
        return _handle_superseded_locked(
            plan,
            read_snapshot,
            current_pending=current_pending,
            desired_intent=desired_intent,
            clock=clock,
            publish_reason=publish_reason,
            publish_cooldown_type=publish_cooldown_type,
        )

    if write.status is PendingOperationStatus.REJECTED:
        snapshot = read_snapshot.shared_snapshot if read_snapshot else None
        return (
            ApplyReconcileOutcome(
                status=ApplyReconcileStatus.OPERATION_ENQUEUED,
                reason="rejected_retry",
            ),
            current_pending,
            _convergence_write_from_pending(
                plan,
                current_pending,
                clock=clock,
                read_snapshot=snapshot,
                reason=publish_reason,
                cooldown_type=publish_cooldown_type,
            ),
        )

    return (
        _handle_failed_locked(plan, current_pending, clock=clock),
        current_pending,
        None,
    )


def _handle_applied_locked(
    plan: ReconcilePlan,
    operation_result: PendingOperationResult,
    *,
    current_pending: PendingSharedOperation | None,
    desired_intent: DesiredIntent,
    clock: Callable[[], float],
    publish_reason: str | None = None,
    publish_cooldown_type: str | None = None,
) -> tuple[
    ApplyReconcileOutcome, PendingSharedOperation | None, ConvergenceWriteRequest | None
]:
    write = operation_result.write_result
    if write is None:
        return (
            ApplyReconcileOutcome(status=ApplyReconcileStatus.CONVERGED),
            current_pending,
            None,
        )

    if desired_intent is DesiredIntent.CLEAR:
        if (
            current_pending is not None
            and current_pending.operation_type == "publish"
            and write.revision is not None
        ):
            clear_op = PendingSharedOperation(
                operation_id=new_operation_id(),
                root_operation_id=plan.root_operation_id,
                operation_type="clear",
                scope=plan.scope,
                local_revision=current_pending.local_revision,
                intent_revision=current_pending.intent_revision,
                expected_shared_revision=int(write.revision),
                expected_value_digest=write.digest,
                reconcile_attempts=current_pending.reconcile_attempts,
                created_at_monotonic=current_pending.created_at_monotonic,
                next_retry_at_monotonic=clock(),
                operation_deadline_monotonic=current_pending.operation_deadline_monotonic,
                protected_state_expires_at_monotonic=None,
                last_error_type=None,
            )
            return (
                ApplyReconcileOutcome(
                    status=ApplyReconcileStatus.OPERATION_ENQUEUED,
                    reason="publish_applied_desired_clear",
                ),
                None,
                ConvergenceWriteRequest(operation=clear_op, remaining_ms=0),
            )
        return (
            ApplyReconcileOutcome(status=ApplyReconcileStatus.CONVERGED),
            None,
            None,
        )

    if desired_intent is DesiredIntent.PUBLISH:
        if (
            current_pending is not None
            and current_pending.operation_type == "clear"
            and write.revision is not None
        ):
            protected = plan.protected_deadline_monotonic
            remaining_ms = max(0, math.floor((protected - clock()) * 1000))
            publish_op = PendingSharedOperation(
                operation_id=new_operation_id(),
                root_operation_id=plan.root_operation_id,
                operation_type="publish",
                scope=plan.scope,
                local_revision=current_pending.local_revision,
                intent_revision=current_pending.intent_revision,
                expected_shared_revision=int(write.revision),
                expected_value_digest=None,
                reconcile_attempts=current_pending.reconcile_attempts,
                created_at_monotonic=current_pending.created_at_monotonic,
                next_retry_at_monotonic=clock(),
                operation_deadline_monotonic=protected,
                protected_state_expires_at_monotonic=protected,
                last_error_type=None,
            )
            return (
                ApplyReconcileOutcome(
                    status=ApplyReconcileStatus.OPERATION_ENQUEUED,
                    reason="clear_applied_desired_publish",
                ),
                None,
                ConvergenceWriteRequest(
                    operation=publish_op,
                    remaining_ms=remaining_ms,
                    reason=publish_reason or "billing_credits_depleted",
                    cooldown_type=publish_cooldown_type or "hard",
                ),
            )
        if current_pending is not None and current_pending.operation_type == "publish":
            protected = current_pending.protected_state_expires_at_monotonic
            if protected is not None:
                anchored = apply_applied_publish_locked(
                    protected_deadline_monotonic=protected,
                    operation_result=operation_result,
                )
                current_pending.protected_state_expires_at_monotonic = anchored
        return (
            ApplyReconcileOutcome(status=ApplyReconcileStatus.CONVERGED),
            None,
            None,
        )

    return (
        ApplyReconcileOutcome(status=ApplyReconcileStatus.CONVERGED),
        None,
        None,
    )


def _handle_superseded_locked(
    plan: ReconcilePlan,
    read_snapshot: ReconcileReadSnapshot | None,
    *,
    current_pending: PendingSharedOperation | None,
    desired_intent: DesiredIntent,
    clock: Callable[[], float],
    publish_reason: str | None = None,
    publish_cooldown_type: str | None = None,
) -> tuple[
    ApplyReconcileOutcome, PendingSharedOperation | None, ConvergenceWriteRequest | None
]:
    if desired_intent is DesiredIntent.NONE:
        return (
            ApplyReconcileOutcome(status=ApplyReconcileStatus.CONVERGED),
            None,
            None,
        )
    snapshot = read_snapshot.shared_snapshot if read_snapshot else None
    convergence = _convergence_write_from_pending(
        plan,
        current_pending,
        clock=clock,
        read_snapshot=snapshot,
        reason=publish_reason,
        cooldown_type=publish_cooldown_type,
    )
    if convergence is None:
        return (
            ApplyReconcileOutcome(
                status=ApplyReconcileStatus.TERMINAL_FAILURE,
                reason="superseded_no_pending",
            ),
            current_pending,
            None,
        )
    return (
        ApplyReconcileOutcome(
            status=ApplyReconcileStatus.OPERATION_ENQUEUED,
            reason="superseded_converge",
        ),
        current_pending,
        convergence,
    )


def _handle_failed_locked(
    plan: ReconcilePlan,
    current_pending: PendingSharedOperation | None,
    *,
    clock: Callable[[], float],
) -> ApplyReconcileOutcome:
    del clock
    if current_pending is None:
        return ApplyReconcileOutcome(status=ApplyReconcileStatus.CONVERGED)
    if plan.reconcile_attempts + 1 >= MAX_RECONCILE_ATTEMPTS:
        return ApplyReconcileOutcome(
            status=ApplyReconcileStatus.TERMINAL_FAILURE,
            reason="failed_max_attempts",
        )
    return ApplyReconcileOutcome(
        status=ApplyReconcileStatus.OPERATION_ENQUEUED,
        reason="failed_retry",
    )


def _revision_from_snapshot(
    pending: PendingSharedOperation,
    read_snapshot: SharedScopeSnapshot | None,
) -> tuple[int, str | None]:
    expected_revision = pending.expected_shared_revision
    expected_digest = pending.expected_value_digest
    if read_snapshot is None:
        return expected_revision, expected_digest
    if pending.scope.is_model:
        return read_snapshot.model_revision, read_snapshot.model_digest
    return read_snapshot.cooldown_revision, read_snapshot.cooldown_digest


def _convergence_write_from_pending(
    plan: ReconcilePlan,
    pending: PendingSharedOperation | None,
    *,
    clock: Callable[[], float],
    read_snapshot: SharedScopeSnapshot | None = None,
    operation_type: Literal["publish", "clear"] | None = None,
    reason: str | None = None,
    cooldown_type: str | None = None,
) -> ConvergenceWriteRequest | None:
    if pending is None:
        return None
    now = clock()
    op_type = operation_type or pending.operation_type
    protected = pending.protected_state_expires_at_monotonic
    if op_type == "publish" and protected is not None:
        remaining_ms = max(0, math.floor((protected - now) * 1000))
    elif op_type == "clear":
        remaining_ms = 0
    else:
        remaining_ms = max(
            0, math.floor((plan.protected_deadline_monotonic - now) * 1000)
        )
    if op_type == "publish" and remaining_ms <= 0:
        return None
    expected_revision, expected_digest = _revision_from_snapshot(pending, read_snapshot)
    next_op = PendingSharedOperation(
        operation_id=new_operation_id(),
        root_operation_id=pending.root_operation_id,
        operation_type=op_type,
        scope=pending.scope,
        local_revision=pending.local_revision,
        intent_revision=pending.intent_revision,
        expected_shared_revision=expected_revision,
        expected_value_digest=expected_digest,
        reconcile_attempts=pending.reconcile_attempts + 1,
        created_at_monotonic=pending.created_at_monotonic,
        next_retry_at_monotonic=now,
        operation_deadline_monotonic=pending.operation_deadline_monotonic,
        protected_state_expires_at_monotonic=pending.protected_state_expires_at_monotonic,
        last_error_type=pending.last_error_type,
    )
    return ConvergenceWriteRequest(
        operation=next_op,
        remaining_ms=remaining_ms,
        reason=reason,
        cooldown_type=cooldown_type,
    )


def execute_convergence_write_unlocked(
    request: ConvergenceWriteRequest,
    store: V2SharedStateStore,
    clock: Callable[[], float],
    *,
    reason: str | None = None,
    cooldown_type: str | None = None,
) -> PendingOperationResult:
    """Execute a convergence Redis write outside the manager lock."""
    started = clock()
    op = request.operation
    scope = op.scope
    effective_reason = reason or request.reason or "cooldown"
    effective_cooldown_type = cooldown_type or request.cooldown_type or "soft"
    if op.operation_type == "publish":
        if scope.is_model:
            write = store.mark_model_unsupported_cas(
                scope,
                expected_revision=op.expected_shared_revision,
                expected_digest=op.expected_value_digest,
            )
        else:
            write = store.apply_cooldown_cas(
                scope,
                expected_revision=op.expected_shared_revision,
                remaining_ms=request.remaining_ms,
                reason=effective_reason,
                cooldown_type=effective_cooldown_type,
                expected_digest=op.expected_value_digest,
            )
    else:
        if scope.is_model:
            write = store.clear_model_unsupported_cas(
                scope,
                expected_revision=op.expected_shared_revision,
                expected_digest=op.expected_value_digest,
            )
        else:
            write = store.clear_cooldown_cas(
                scope,
                expected_revision=op.expected_shared_revision,
                expected_digest=op.expected_value_digest,
            )
    completed = clock()
    return _operation_result_from_write(
        op.operation_id, write, started=started, completed=completed
    )


def run_reconcile_loop(
    *,
    scope: SharedStateScope,
    store: V2SharedStateStore,
    clock: Callable[[], float],
    capture_plan_locked: Callable[[], ReconcilePlanCapture | None],
    read_shared_revision_unlocked: Callable[[], SharedScopeSnapshot] | None = None,
    apply_locked: Callable[
        [
            ReconcilePlan,
            ReconcileReadSnapshot | None,
            PendingOperationResult | None,
        ],
        tuple[
            ApplyReconcileOutcome,
            PendingSharedOperation | None,
            ConvergenceWriteRequest | None,
        ],
    ],
    initial_operation_result: PendingOperationResult | None = None,
) -> ApplyReconcileOutcome:
    """Outer orchestration: plan (lock) → read (unlock) → apply (lock)."""
    operation_result = initial_operation_result
    attempts = 0

    while attempts < MAX_RECONCILE_ATTEMPTS:
        capture = capture_plan_locked()
        if capture is None:
            return ApplyReconcileOutcome(status=ApplyReconcileStatus.CONVERGED)

        plan = capture.plan
        needs_refresh = plan.needs_redis_refresh or (
            operation_result is not None
            and operation_result.write_result is not None
            and _needs_refresh_for_write(operation_result.write_result)
        )
        if needs_refresh and not plan.needs_redis_refresh:
            plan = ReconcilePlan(
                scope=plan.scope,
                captured_operation_id=plan.captured_operation_id,
                captured_intent_revision=plan.captured_intent_revision,
                desired_intent=plan.desired_intent,
                needs_redis_refresh=True,
                protected_deadline_monotonic=plan.protected_deadline_monotonic,
                root_operation_id=plan.root_operation_id,
                reconcile_attempts=plan.reconcile_attempts,
            )

        read_snapshot = execute_reconcile_reads_unlocked(plan, store, clock)
        if (
            read_snapshot.shared_snapshot is None
            and read_shared_revision_unlocked is not None
        ):
            started = clock()
            try:
                snapshot = read_shared_revision_unlocked()
            except Exception:
                snapshot = None
            completed = clock()
            if snapshot is not None:
                read_snapshot = ReconcileReadSnapshot(
                    shared_snapshot=snapshot,
                    timing=RedisCallTiming(
                        started_at_monotonic=started,
                        completed_at_monotonic=completed,
                    ),
                )

        outcome, _pending, convergence = apply_locked(
            plan, read_snapshot, operation_result
        )
        operation_result = None

        if outcome.status is ApplyReconcileStatus.REPLAN_REQUIRED:
            attempts = plan.reconcile_attempts + 1
            continue

        if (
            outcome.status is ApplyReconcileStatus.OPERATION_ENQUEUED
            and convergence is not None
        ):
            operation_result = execute_convergence_write_unlocked(
                convergence,
                store,
                clock,
            )
            attempts = convergence.operation.reconcile_attempts
            continue

        if outcome.status is ApplyReconcileStatus.OPERATION_ENQUEUED:
            attempts = plan.reconcile_attempts + 1
            continue

        return outcome

    return ApplyReconcileOutcome(
        status=ApplyReconcileStatus.TERMINAL_FAILURE,
        reason="max_reconcile_attempts",
    )


def handle_operation_result(
    *,
    scope: SharedStateScope,
    store: V2SharedStateStore,
    clock: Callable[[], float],
    operation_result: PendingOperationResult,
    capture_plan_locked: Callable[[], ReconcilePlanCapture | None],
    apply_locked: Callable[
        [
            ReconcilePlan,
            ReconcileReadSnapshot | None,
            PendingOperationResult | None,
        ],
        tuple[
            ApplyReconcileOutcome,
            PendingSharedOperation | None,
            ConvergenceWriteRequest | None,
        ],
    ],
    read_shared_revision_unlocked: Callable[[], SharedScopeSnapshot] | None = None,
) -> ApplyReconcileOutcome:
    """Route a completed Redis write through the three-phase reconcile loop."""
    return run_reconcile_loop(
        scope=scope,
        store=store,
        clock=clock,
        capture_plan_locked=capture_plan_locked,
        read_shared_revision_unlocked=read_shared_revision_unlocked,
        apply_locked=apply_locked,
        initial_operation_result=operation_result,
    )


def build_publish_operation_locked(
    *,
    scope: SharedStateScope,
    intent_revision: int,
    protected_deadline_monotonic: float,
    expected_shared_revision: int,
    expected_value_digest: str | None,
    current_pending: PendingSharedOperation | None,
    clock: Callable[[], float],
    reason: str | None = None,
    cooldown_type: str | None = None,
) -> PendingSharedOperation:
    """Create or inherit a pending publish operation under lock."""
    now = clock()
    root_id = (
        current_pending.root_operation_id if current_pending else new_operation_id()
    )
    return PendingSharedOperation(
        operation_id=new_operation_id(),
        root_operation_id=root_id,
        operation_type="publish",
        scope=scope,
        local_revision=0,
        intent_revision=intent_revision,
        expected_shared_revision=expected_shared_revision,
        expected_value_digest=expected_value_digest,
        reconcile_attempts=current_pending.reconcile_attempts if current_pending else 0,
        created_at_monotonic=(
            current_pending.created_at_monotonic if current_pending else now
        ),
        next_retry_at_monotonic=now,
        operation_deadline_monotonic=protected_deadline_monotonic,
        protected_state_expires_at_monotonic=protected_deadline_monotonic,
        last_error_type=None,
    )


def build_clear_operation_locked(
    *,
    scope: SharedStateScope,
    intent_revision: int,
    expected_shared_revision: int,
    expected_value_digest: str | None,
    current_pending: PendingSharedOperation | None,
    clock: Callable[[], float],
) -> PendingSharedOperation:
    """Create or inherit a pending clear operation under lock."""
    now = clock()
    root_id = (
        current_pending.root_operation_id if current_pending else new_operation_id()
    )
    created = current_pending.created_at_monotonic if current_pending else now
    return PendingSharedOperation(
        operation_id=new_operation_id(),
        root_operation_id=root_id,
        operation_type="clear",
        scope=scope,
        local_revision=0,
        intent_revision=intent_revision,
        expected_shared_revision=expected_shared_revision,
        expected_value_digest=expected_value_digest,
        reconcile_attempts=current_pending.reconcile_attempts if current_pending else 0,
        created_at_monotonic=created,
        next_retry_at_monotonic=now,
        operation_deadline_monotonic=created + PENDING_CLEAR_MAX_LIFETIME_SECONDS,
        protected_state_expires_at_monotonic=None,
        last_error_type=None,
    )


def shared_scope_for_key_scope(
    key_scope,
    *,
    model: str = "",
) -> SharedStateScope:
    return scope_from_gemini(key_scope, model=model)
