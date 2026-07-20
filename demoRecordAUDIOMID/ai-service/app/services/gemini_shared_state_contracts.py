"""Gemini shared-state operation contracts (v2 namespace, ledger CAS, reconciliation)."""

from __future__ import annotations

import hashlib
import re
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Literal

from app.services.gemini_key_cooldown_store import (
    GeminiCooldownState,
    GeminiKeyScope,
    normalize_model_name,
    safe_model_key_component,
)

CLEAR_TOMBSTONE_TTL_MS = 300_000
PENDING_CLEAR_MAX_LIFETIME_SECONDS = 300.0
UNIT_REMAINING_MS_TOLERANCE = 50
INTEGRATION_REMAINING_MS_TOLERANCE = 1000
MAX_RECONCILE_ATTEMPTS = 5
MAX_STALE_RESELECTIONS = 2
SHARED_STATE_V2_PREFIX = "gemini:v2"


class PendingOperationStatus(str, Enum):
    APPLIED = "applied"
    SUPERSEDED = "superseded"
    REJECTED = "rejected"
    FAILED = "failed"


class SharedStoreErrorType(str, Enum):
    REDIS_UNAVAILABLE = "redis_unavailable"
    INVALID_SCOPE = "invalid_scope"
    INVALID_ARGUMENT = "invalid_argument"
    PARSE_ERROR = "parse_error"
    TRANSPORT_ERROR = "transport_error"


class DesiredIntent(str, Enum):
    PUBLISH = "publish"
    CLEAR = "clear"
    NONE = "none"


class SynchronizationState(str, Enum):
    SYNCED = "synced"
    PENDING_PUBLISH = "pending_publish"
    PENDING_CLEAR = "pending_clear"


class BlockedReason(str, Enum):
    COOLDOWN = "cooldown"
    MODEL_UNSUPPORTED = "model_unsupported"


class ApplyReconcileStatus(str, Enum):
    CONVERGED = "converged"
    OPERATION_ENQUEUED = "operation_enqueued"
    REPLAN_REQUIRED = "replan_required"
    TERMINAL_FAILURE = "terminal_failure"


class SelectionValidationStatus(str, Enum):
    VALID = "valid"
    STALE = "stale"
    STALE_RESELECT = "stale_reselect"
    REDIS_UNAVAILABLE = "redis_unavailable"
    INVALID_SNAPSHOT = "invalid_snapshot"
    BLOCKED = "blocked"


class AliasReusePolicy(str, Enum):
    UNATTEMPTED_FIRST = "unattempted_first"
    BOUNDED_SAME_ALIAS_TRANSIENT = "bounded_same_alias_transient"


@dataclass(frozen=True)
class SharedWriteResult:
    status: PendingOperationStatus
    state: GeminiCooldownState | None = None
    revision: int | None = None
    final_remaining_ms: int | None = None
    digest: str | None = None
    merged_from_shared_stronger: bool = False
    error_type: SharedStoreErrorType | None = None

    @property
    def success(self) -> bool:
        return self.status is PendingOperationStatus.APPLIED


@dataclass(frozen=True)
class RedisCallTiming:
    started_at_monotonic: float
    completed_at_monotonic: float


@dataclass(frozen=True)
class SharedStateScope:
    alias: str
    fingerprint: str
    model: str = ""

    @property
    def is_cooldown(self) -> bool:
        return not self.model

    @property
    def is_model(self) -> bool:
        return bool(self.model)

    def to_key_scope(self) -> GeminiKeyScope:
        return GeminiKeyScope(alias=self.alias, fingerprint=self.fingerprint)


@dataclass(frozen=True)
class SharedScopeSnapshot:
    scope: SharedStateScope
    cooldown_state: GeminiCooldownState | None = None
    cooldown_pttl_ms: int = -2
    cooldown_revision: int = 0
    model_unsupported: bool = False
    model_pttl_ms: int = -2
    model_revision: int = 0
    cooldown_digest: str | None = None
    model_digest: str | None = None


@dataclass(frozen=True)
class ReconcileReadSnapshot:
    shared_snapshot: SharedScopeSnapshot | None
    timing: RedisCallTiming | None = None
    error_type: SharedStoreErrorType | None = None


@dataclass(frozen=True)
class ApplyReconcileOutcome:
    status: ApplyReconcileStatus
    reason: str | None = None


@dataclass
class PendingSharedOperation:
    operation_id: str
    root_operation_id: str
    operation_type: Literal["publish", "clear"]
    scope: SharedStateScope
    local_revision: int
    intent_revision: int
    expected_shared_revision: int
    expected_value_digest: str | None
    reconcile_attempts: int
    created_at_monotonic: float
    next_retry_at_monotonic: float
    operation_deadline_monotonic: float
    protected_state_expires_at_monotonic: float | None = None
    last_error_type: str | None = None


@dataclass(frozen=True)
class PendingOperationResult:
    operation_id: str
    status: PendingOperationStatus
    write_result: SharedWriteResult | None = None
    timing: RedisCallTiming | None = None


@dataclass(frozen=True)
class ReconcilePlan:
    scope: SharedStateScope
    captured_operation_id: str
    captured_intent_revision: int
    desired_intent: DesiredIntent
    needs_redis_refresh: bool
    protected_deadline_monotonic: float
    root_operation_id: str
    reconcile_attempts: int


@dataclass(frozen=True)
class AliasDecisionSnapshot:
    alias: str
    model: str
    cooldown_sync_state: SynchronizationState
    model_sync_state: SynchronizationState
    cooldown_revision: int
    model_revision: int
    blocked_reasons: frozenset[BlockedReason] = frozenset()
    cooldown_state: GeminiCooldownState | None = None
    model_unsupported: bool = False


@dataclass(frozen=True)
class SelectionValidationResult:
    status: SelectionValidationStatus
    alias: str | None = None
    reason: str | None = None
    stale_reselections: int = 0


@dataclass
class PendingPublishState:
    operation: PendingSharedOperation
    reason: str | None = None
    cooldown_type: str | None = None


@dataclass
class PendingClearStateV2:
    operation: PendingSharedOperation


@dataclass(frozen=True)
class PoolDecisionSnapshot:
    generation: int
    selection_revision_alias: int
    selection_revision_model: int
    aliases: tuple[AliasDecisionSnapshot, ...] = ()


def new_operation_id() -> str:
    return uuid.uuid4().hex


def digest_for_raw(raw: str | None) -> str | None:
    if not raw:
        return None
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _sanitize_v2_namespace(namespace: str) -> str:
    cleaned = str(namespace or "").strip().lower()
    if not cleaned:
        return "local:ai-service"
    safe = re.sub(r"[^a-z0-9:._-]+", "-", cleaned).strip("-")
    return safe or "local:ai-service"


def build_v2_cooldown_state_key(namespace: str, scope: GeminiKeyScope) -> str:
    env = _sanitize_v2_namespace(namespace)
    return f"{SHARED_STATE_V2_PREFIX}:{env}:cooldown:{scope.alias}"


def build_v2_cooldown_revision_key(namespace: str, scope: GeminiKeyScope) -> str:
    return f"{build_v2_cooldown_state_key(namespace, scope)}:revision"


def build_v2_model_state_key(namespace: str, scope: GeminiKeyScope, model: str) -> str:
    env = _sanitize_v2_namespace(namespace)
    model_component = safe_model_key_component(model)
    return f"{SHARED_STATE_V2_PREFIX}:{env}:model:{scope.alias}:{model_component}"


def build_v2_model_revision_key(namespace: str, scope: GeminiKeyScope, model: str) -> str:
    return f"{build_v2_model_state_key(namespace, scope, model)}:revision"


def scope_from_gemini(scope: GeminiKeyScope, model: str = "") -> SharedStateScope:
    return SharedStateScope(
        alias=scope.alias,
        fingerprint=scope.fingerprint,
        model=normalize_model_name(model),
    )


def build_reconcile_plan_locked(
    *,
    scope: SharedStateScope,
    current_pending: PendingSharedOperation | None,
    desired_intent: DesiredIntent,
    intent_revision: int,
    protected_deadline_monotonic: float,
    needs_redis_refresh: bool,
) -> ReconcilePlan:
    """PHASE A — pure capture/decision under lock. No Redis."""
    operation_id = current_pending.operation_id if current_pending else ""
    root_id = (
        current_pending.root_operation_id if current_pending else new_operation_id()
    )
    attempts = current_pending.reconcile_attempts if current_pending else 0
    return ReconcilePlan(
        scope=scope,
        captured_operation_id=operation_id,
        captured_intent_revision=intent_revision,
        desired_intent=desired_intent,
        needs_redis_refresh=needs_redis_refresh,
        protected_deadline_monotonic=protected_deadline_monotonic,
        root_operation_id=root_id,
        reconcile_attempts=attempts,
    )


def apply_reconcile_plan_locked(
    plan: ReconcilePlan,
    read_snapshot: ReconcileReadSnapshot | None,
    operation_result: PendingOperationResult | None,
    *,
    current_intent_revision: int,
    current_operation_id: str | None,
) -> ApplyReconcileOutcome:
    """PHASE C — pure apply under lock. No Redis. No recurse."""
    del read_snapshot, operation_result
    if current_intent_revision != plan.captured_intent_revision:
        return ApplyReconcileOutcome(
            status=ApplyReconcileStatus.REPLAN_REQUIRED,
            reason="intent_revision_changed",
        )
    if (
        plan.captured_operation_id
        and current_operation_id
        and current_operation_id != plan.captured_operation_id
    ):
        return ApplyReconcileOutcome(
            status=ApplyReconcileStatus.REPLAN_REQUIRED,
            reason="operation_id_replaced",
        )
    return ApplyReconcileOutcome(status=ApplyReconcileStatus.CONVERGED)


def apply_safe_anchored_deadline(
    *,
    protected_deadline_monotonic: float,
    redis_call_started_monotonic: float,
    final_remaining_ms: int,
    merged_from_shared_stronger: bool,
) -> float:
    """Compute protected local deadline from Redis call start, not receive time."""
    anchored = redis_call_started_monotonic + final_remaining_ms / 1000.0
    if merged_from_shared_stronger:
        return max(protected_deadline_monotonic, anchored)
    return min(protected_deadline_monotonic, anchored)
