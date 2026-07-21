import json
import math
import re
import threading
import time
from dataclasses import dataclass, field
from math import ceil
from typing import Callable

from loguru import logger

from app.services.gemini_key_cooldown_store import (
    DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS,
    GeminiCooldownState,
    GeminiKeyCooldownStore,
    GeminiKeyScope,
    SharedAliasSnapshot,
    key_fingerprint,
    store_supports_cooldown_metadata,
)
from app.services.gemini_shared_state_contracts import (
    DesiredIntent,
    PendingClearStateV2,
    PendingOperationResult,
    PendingOperationStatus,
    PendingPublishState,
    PendingSharedOperation,
    ReconcilePlan,
    RedisCallTiming,
    SharedStateScope,
    build_reconcile_plan_locked,
    scope_from_gemini,
)
from app.services.gemini_shared_state_reconcile import (
    ReconcilePlanCapture,
    apply_reconcile_business_locked,
    build_clear_operation_locked,
    build_publish_operation_locked,
    execute_reconcile_reads_unlocked,
    handle_operation_result,
)
from app.services.gemini_shared_state_store import (
    InMemoryV2GeminiKeyCooldownStore,
    RedisV2GeminiKeyCooldownStore,
)

ALIAS_PATTERN = re.compile(r"^[a-z0-9_-]+$")
MAX_VALIDATION_REFRESH_ATTEMPTS = 2
PENDING_CLEAR_TTL_SECONDS = 300.0
PENDING_CLEAR_INITIAL_BACKOFF_SECONDS = 1.0
PENDING_CLEAR_MAX_BACKOFF_SECONDS = 30.0
TTL_SYNC_TOLERANCE_SECONDS = 1.0


def _needs_refresh(operation_result: PendingOperationResult) -> bool:
    write = operation_result.write_result
    if write is None:
        return False
    return write.status in (
        PendingOperationStatus.SUPERSEDED,
        PendingOperationStatus.REJECTED,
    )


class GeminiKeyConfigError(ValueError):
    """Raised when Gemini key configuration is invalid without exposing secrets."""


@dataclass(frozen=True)
class GeminiKeyEntry:
    alias: str
    secret: str = field(repr=False)

    def __repr__(self) -> str:
        return f"GeminiKeyEntry(alias={self.alias!r}, secret=<redacted>)"


_TERMINAL_UNAVAILABLE_REASONS = frozenset(
    {
        "billing_credits_depleted",
        "free_tier_token_quota_exhausted",
        "free_tier_quota_exhausted",
        "model_unavailable",
        "invalid_key",
        "auth_error",
        "region_blocked",
        "invalid_request",
    }
)


@dataclass(frozen=True)
class LocalStateRevision:
    alias_generation: int
    model_generation: int


@dataclass(frozen=True)
class GeminiKeySelection:
    available: bool
    entry: GeminiKeyEntry | None = None
    retry_after_seconds: int = 0
    cooldown_active: int = 0
    unavailable_reasons: dict[str, str] = field(default_factory=dict)
    all_terminal: bool = False
    all_model_unsupported: bool = False
    has_unattempted_eligible: bool = False
    reason: str | None = None
    selection_revision: LocalStateRevision | None = None

    @property
    def snapshot_generation(self) -> int:
        """Backward-compatible debug view of alias generation at selection time."""
        if self.selection_revision is None:
            return 0
        return self.selection_revision.alias_generation

    @property
    def alias(self) -> str | None:
        return self.entry.alias if self.entry is not None else None

    @property
    def key(self) -> str | None:
        return self.entry.secret if self.entry is not None else None


@dataclass
class _KeyState:
    disabled_until_monotonic: float = 0.0
    last_error_code: str | None = None
    last_retry_after_seconds: int = 0
    consecutive_failures: int = 0


@dataclass
class PendingClearState:
    attempts: int
    created_at_monotonic: float
    next_retry_at_monotonic: float
    expires_at_monotonic: float
    last_error_type: str | None = None


@dataclass(frozen=True)
class LocalCooldownState:
    reason: str | None
    cooldown_type: str | None
    expires_at_monotonic: float


@dataclass(frozen=True)
class GeminiAliasStateSnapshot:
    alias: str
    model_name: str
    cooldown_state: GeminiCooldownState | None
    model_unsupported: bool


def _safe_config_error(message: str) -> GeminiKeyConfigError:
    return GeminiKeyConfigError(f"Invalid GEMINI_API_KEYS configuration: {message}")


def _validate_alias(alias: str) -> str:
    normalized = str(alias or "").strip()
    if not normalized:
        raise _safe_config_error("alias is required")
    if not ALIAS_PATTERN.fullmatch(normalized):
        raise _safe_config_error("alias must match ^[a-z0-9_-]+$")
    return normalized


def _validate_key(value: str) -> str:
    secret = str(value or "").strip()
    if not secret:
        raise _safe_config_error("key must not be empty")
    # Accept both Standard keys (AIza...) and Auth keys (AQ....) from AI Studio.
    return secret


def _validate_entries(entries: list[GeminiKeyEntry]) -> list[GeminiKeyEntry]:
    aliases: set[str] = set()
    secrets: set[str] = set()
    validated: list[GeminiKeyEntry] = []
    for entry in entries:
        alias = _validate_alias(entry.alias)
        secret = _validate_key(entry.secret)
        if alias in aliases:
            raise _safe_config_error("duplicate alias")
        if secret in secrets:
            raise _safe_config_error("duplicate key")
        aliases.add(alias)
        secrets.add(secret)
        validated.append(GeminiKeyEntry(alias=alias, secret=secret))
    if not validated:
        raise _safe_config_error("at least one key is required")
    return validated


def parse_gemini_api_keys(raw_value: str) -> list[GeminiKeyEntry]:
    raw = str(raw_value or "").strip()
    if not raw:
        return []
    try:
        if raw.startswith("["):
            parsed = json.loads(raw)
            if not isinstance(parsed, list):
                raise _safe_config_error("JSON value must be an array")
            entries = []
            for item in parsed:
                if not isinstance(item, dict):
                    raise _safe_config_error("JSON entries must be objects")
                entries.append(
                    GeminiKeyEntry(
                        alias=str(item.get("alias") or ""),
                        secret=str(item.get("key") or ""),
                    )
                )
            return _validate_entries(entries)

        entries = []
        for part in raw.split(","):
            piece = part.strip()
            if not piece or ":" not in piece:
                raise _safe_config_error("comma format must use alias:key pairs")
            alias, secret = piece.split(":", 1)
            entries.append(GeminiKeyEntry(alias=alias, secret=secret))
        return _validate_entries(entries)
    except GeminiKeyConfigError:
        raise
    except Exception as exc:
        raise _safe_config_error("could not parse value") from exc


class GeminiKeyManager:
    def __init__(
        self,
        entries: list[GeminiKeyEntry],
        *,
        clock: Callable[[], float] | None = None,
        wall_clock: Callable[[], float] | None = None,
        cooldown_store: GeminiKeyCooldownStore | None = None,
    ):
        self._entries = _validate_entries(entries)
        self._clock = clock or time.monotonic
        self._wall_clock = wall_clock or time.time
        self._cooldown_store = self._normalize_cooldown_store(cooldown_store)
        self._lock = threading.RLock()
        self._states = {entry.alias: _KeyState() for entry in self._entries}
        self._fingerprints = {
            entry.alias: key_fingerprint(entry.secret) for entry in self._entries
        }
        self._selection_ticket = 0
        self._state_generation = 0
        self._alias_generation: dict[str, int] = {}
        self._model_generation: dict[tuple[str, str], int] = {}
        self._local_cooldown: dict[str, LocalCooldownState] = {}
        self._unsupported_expires_monotonic: dict[tuple[str, str, str], float] = {}
        self._pending_cooldown_clears: dict[str, PendingClearState] = {}
        self._pending_model_clears: dict[tuple[str, str, str], PendingClearState] = {}
        self._pending_cooldown_publishes: dict[str, PendingPublishState] = {}
        self._pending_model_publishes: dict[tuple[str, str, str], PendingPublishState] = {}
        self._pending_cooldown_clear_v2: dict[str, PendingClearStateV2] = {}
        self._pending_model_clear_v2: dict[tuple[str, str, str], PendingClearStateV2] = {}
        self._intent_revisions: dict[str, int] = {}
        self._model_intent_revisions: dict[tuple[str, str, str], int] = {}
        self._model_unsupported_ttl_seconds = self._resolve_model_unsupported_ttl()

    @staticmethod
    def _normalize_cooldown_store(
        cooldown_store: GeminiKeyCooldownStore | None,
    ) -> GeminiKeyCooldownStore | None:
        if cooldown_store is None:
            return None
        if store_supports_cooldown_metadata(cooldown_store):
            return cooldown_store
        from app.services.gemini_key_cooldown_store import (
            LegacyGeminiCooldownStoreAdapter,
        )

        return LegacyGeminiCooldownStoreAdapter(cooldown_store)

    def _resolve_model_unsupported_ttl(self) -> int:
        store = self._cooldown_store
        ttl = getattr(store, "model_unsupported_ttl_seconds", None)
        if ttl is not None:
            return max(1, int(ttl))
        return DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS

    def _scope_for(self, alias: str) -> GeminiKeyScope:
        normalized = str(alias or "").strip()
        return GeminiKeyScope(
            alias=normalized,
            fingerprint=self._fingerprints.get(normalized, ""),
        )

    def _now_ms(self) -> int:
        return int(self._wall_clock() * 1000)

    @staticmethod
    def _is_v2_cooldown_store(store) -> bool:
        return isinstance(
            store, (InMemoryV2GeminiKeyCooldownStore, RedisV2GeminiKeyCooldownStore)
        )

    def _v2_store(self):
        store = self._cooldown_store
        if store is not None and self._is_v2_cooldown_store(store):
            return store
        return None

    def _shared_scope(self, alias: str, *, model: str = "") -> SharedStateScope:
        return scope_from_gemini(self._scope_for(alias), model=model)

    def _bump_cooldown_intent_locked(self, alias: str) -> int:
        revision = self._intent_revisions.get(alias, 0) + 1
        self._intent_revisions[alias] = revision
        return revision

    def _bump_model_intent_locked(self, cache_key: tuple[str, str, str]) -> int:
        revision = self._model_intent_revisions.get(cache_key, 0) + 1
        self._model_intent_revisions[cache_key] = revision
        return revision

    def _execute_reconcile_reads_unlocked(self, plan: ReconcilePlan):
        store = self._v2_store()
        if store is None:
            return None
        return execute_reconcile_reads_unlocked(plan, store, self._clock)

    @classmethod
    def from_config(
        cls,
        *,
        gemini_api_key: str,
        gemini_api_keys: str = "",
        multi_key_enabled: bool = False,
        clock: Callable[[], float] | None = None,
        wall_clock: Callable[[], float] | None = None,
        cooldown_store: GeminiKeyCooldownStore | None = None,
    ) -> "GeminiKeyManager":
        if multi_key_enabled:
            parsed_entries = parse_gemini_api_keys(gemini_api_keys)
            if parsed_entries:
                return cls(
                    parsed_entries,
                    clock=clock,
                    wall_clock=wall_clock,
                    cooldown_store=cooldown_store,
                )
        primary = _validate_key(gemini_api_key)
        return cls(
            [GeminiKeyEntry(alias="primary", secret=primary)],
            clock=clock,
            wall_clock=wall_clock,
            cooldown_store=cooldown_store,
        )

    @property
    def entries(self) -> tuple[GeminiKeyEntry, ...]:
        return tuple(self._entries)

    def has_keys(self) -> bool:
        return bool(self._entries)

    @staticmethod
    def normalize_model_name(model: str | None) -> str:
        raw = str(model or "").strip()
        if not raw:
            return ""
        lowered = raw.lower()
        if lowered.startswith("models/"):
            lowered = lowered[len("models/") :]
        if ":" in lowered:
            lowered = lowered.split(":", 1)[0]
        return lowered.strip()

    def _increment_alias_generation_locked(self, alias: str) -> None:
        self._alias_generation[alias] = self._alias_generation.get(alias, 0) + 1
        self._state_generation += 1

    def _increment_model_generation_locked(self, alias: str, model_name: str) -> None:
        if not model_name:
            return
        key = (alias, model_name)
        self._model_generation[key] = self._model_generation.get(key, 0) + 1
        self._state_generation += 1

    def _capture_revision_locked(
        self, alias: str, model_name: str
    ) -> LocalStateRevision:
        return LocalStateRevision(
            alias_generation=self._alias_generation.get(alias, 0),
            model_generation=self._model_generation.get((alias, model_name), 0)
            if model_name
            else 0,
        )

    def _revision_changed_locked(
        self,
        captured: LocalStateRevision,
        alias: str,
        model_name: str,
    ) -> bool:
        return captured != self._capture_revision_locked(alias, model_name)

    def _new_pending_clear_state(self, now: float) -> PendingClearState:
        return PendingClearState(
            attempts=0,
            created_at_monotonic=now,
            next_retry_at_monotonic=now,
            expires_at_monotonic=now + PENDING_CLEAR_TTL_SECONDS,
        )

    def _schedule_pending_clear_retry(
        self, pending: PendingClearState, *, now: float, error_type: str | None
    ) -> PendingClearState:
        attempts = pending.attempts + 1
        backoff = min(
            PENDING_CLEAR_MAX_BACKOFF_SECONDS,
            PENDING_CLEAR_INITIAL_BACKOFF_SECONDS * (2 ** max(0, attempts - 1)),
        )
        return PendingClearState(
            attempts=attempts,
            created_at_monotonic=pending.created_at_monotonic,
            next_retry_at_monotonic=now + backoff,
            expires_at_monotonic=pending.expires_at_monotonic,
            last_error_type=error_type,
        )

    def _expire_pending_clears_locked(self, now: float) -> None:
        for alias, pending in tuple(self._pending_cooldown_clears.items()):
            if now >= pending.expires_at_monotonic:
                self._pending_cooldown_clears.pop(alias, None)
                self._increment_alias_generation_locked(alias)
                logger.warning(
                    "GEMINI_PENDING_COOLDOWN_CLEAR_EXPIRED alias={}",
                    alias,
                )
        for cache_key, pending in tuple(self._pending_model_clears.items()):
            if now >= pending.expires_at_monotonic:
                self._pending_model_clears.pop(cache_key, None)
                self._increment_model_generation_locked(cache_key[0], cache_key[2])
                logger.warning(
                    "GEMINI_PENDING_MODEL_CLEAR_EXPIRED alias={} modelKey={}",
                    cache_key[0],
                    cache_key[2],
                )

    def _reserve_selection_ticket_locked(self) -> int:
        ticket = self._selection_ticket
        self._selection_ticket += 1
        return ticket

    def _cleanup_expired_locked(self, now: float) -> None:
        for alias, local in tuple(self._local_cooldown.items()):
            if local.expires_at_monotonic <= now:
                self._local_cooldown.pop(alias, None)
                state = self._states.get(alias)
                if state is not None:
                    state.disabled_until_monotonic = 0.0
                    state.last_error_code = None
                    state.last_retry_after_seconds = 0
                self._increment_alias_generation_locked(alias)
        for cache_key, expires_at in tuple(
            self._unsupported_expires_monotonic.items()
        ):
            if expires_at <= now:
                self._unsupported_expires_monotonic.pop(cache_key, None)
                self._increment_model_generation_locked(cache_key[0], cache_key[2])
        self._expire_pending_clears_locked(now)

    def _local_cooldown_as_state_locked(
        self, alias: str, *, now: float
    ) -> GeminiCooldownState | None:
        local = self._local_cooldown.get(alias)
        if local is not None:
            remaining = max(0.0, local.expires_at_monotonic - now)
            if remaining > 0:
                return GeminiCooldownState(
                    remaining_seconds=remaining,
                    reason=local.reason,
                    cooldown_type=local.cooldown_type,
                )
        state = self._states.get(alias)
        if state is None:
            return None
        remaining = max(0.0, state.disabled_until_monotonic - now)
        if remaining <= 0:
            return None
        return GeminiCooldownState(
            remaining_seconds=remaining,
            reason=state.last_error_code,
            cooldown_type="soft",
        )

    def _model_cache_key(self, alias: str, model_name: str) -> tuple[str, str, str]:
        return alias, self._fingerprints.get(alias, ""), model_name

    def _local_snapshots_locked(
        self,
        entries: tuple[GeminiKeyEntry, ...],
        *,
        model_name: str,
        now: float,
    ) -> dict[str, GeminiAliasStateSnapshot]:
        snapshots: dict[str, GeminiAliasStateSnapshot] = {}
        for entry in entries:
            expires_at = self._unsupported_expires_monotonic.get(
                self._model_cache_key(entry.alias, model_name), 0.0
            )
            snapshots[entry.alias] = GeminiAliasStateSnapshot(
                alias=entry.alias,
                model_name=model_name,
                cooldown_state=self._local_cooldown_as_state_locked(
                    entry.alias, now=now
                ),
                model_unsupported=bool(model_name and expires_at > now),
            )
        return snapshots

    def _cooldown_logical_changed_locked(
        self,
        alias: str,
        *,
        incoming_active: bool,
        incoming_reason: str | None,
        incoming_type: str | None,
        incoming_remaining: float,
        now: float,
    ) -> bool:
        existing = self._local_cooldown.get(alias)
        existing_active = existing is not None and existing.expires_at_monotonic > now
        if existing_active != incoming_active:
            return True
        if not incoming_active:
            return False
        if existing is None:
            return True
        if (existing.reason or "") != (incoming_reason or ""):
            return True
        if (existing.cooldown_type or "") != (incoming_type or ""):
            return True
        existing_remaining = max(0.0, existing.expires_at_monotonic - now)
        if abs(existing_remaining - incoming_remaining) > TTL_SYNC_TOLERANCE_SECONDS:
            if incoming_remaining > existing_remaining + TTL_SYNC_TOLERANCE_SECONDS:
                return True
            if (
                existing_remaining
                > incoming_remaining + TTL_SYNC_TOLERANCE_SECONDS
            ):
                return True
        return False

    def _model_unsupported_logical_changed_locked(
        self,
        cache_key: tuple[str, str, str],
        *,
        incoming_active: bool,
        incoming_remaining: float,
        now: float,
    ) -> bool:
        existing_expires = self._unsupported_expires_monotonic.get(cache_key, 0.0)
        existing_active = existing_expires > now
        if existing_active != incoming_active:
            return True
        if not incoming_active:
            return False
        existing_remaining = max(0.0, existing_expires - now)
        return (
            abs(existing_remaining - incoming_remaining)
            > TTL_SYNC_TOLERANCE_SECONDS
        )

    def _sync_alias_from_v2_snapshot_locked(
        self,
        alias: str,
        shared,
        *,
        model_name: str,
        now: float,
    ) -> None:
        if alias in self._pending_cooldown_publishes or alias in self._pending_cooldown_clear_v2:
            return
        pseudo = SharedAliasSnapshot(
            alias=alias,
            cooldown_state=shared.cooldown_state,
            cooldown_pttl_ms=shared.cooldown_pttl_ms,
            model_unsupported=shared.model_unsupported,
            model_pttl_ms=shared.model_pttl_ms,
        )
        self._sync_alias_from_shared_locked(
            pseudo, model_name=model_name, now=now
        )

    def _v2_alias_snapshot(
        self, shared, *, model_name: str
    ) -> GeminiAliasStateSnapshot:
        return GeminiAliasStateSnapshot(
            alias=shared.scope.alias,
            model_name=model_name,
            cooldown_state=shared.cooldown_state,
            model_unsupported=shared.model_unsupported,
        )

    def _capture_reconcile_plan_locked(
        self,
        *,
        scope: SharedStateScope,
        desired_intent: DesiredIntent,
        pending: PendingSharedOperation | None,
        protected_deadline_monotonic: float,
        needs_redis_refresh: bool,
    ) -> ReconcilePlanCapture:
        intent_revision = (
            pending.intent_revision
            if pending is not None
            else self._intent_revisions.get(scope.alias, 0)
        )
        if scope.is_model:
            cache_key = self._model_cache_key(scope.alias, scope.model)
            intent_revision = (
                pending.intent_revision
                if pending is not None
                else self._model_intent_revisions.get(cache_key, 0)
            )
        plan = build_reconcile_plan_locked(
            scope=scope,
            current_pending=pending,
            desired_intent=desired_intent,
            intent_revision=intent_revision,
            protected_deadline_monotonic=protected_deadline_monotonic,
            needs_redis_refresh=needs_redis_refresh,
        )
        current_operation_id = pending.operation_id if pending else None
        return ReconcilePlanCapture(
            plan=plan,
            current_intent_revision=intent_revision,
            current_operation_id=current_operation_id,
        )

    def _apply_reconcile_locked(
        self,
        plan: ReconcilePlan,
        read_snapshot,
        operation_result: PendingOperationResult | None,
        *,
        pending: PendingSharedOperation | None,
        desired_intent: DesiredIntent,
        publish_reason: str | None = None,
        publish_cooldown_type: str | None = None,
    ):
        intent_revision = plan.captured_intent_revision
        if plan.scope.is_model:
            cache_key = self._model_cache_key(plan.scope.alias, plan.scope.model)
            intent_revision = self._model_intent_revisions.get(cache_key, intent_revision)
        else:
            intent_revision = self._intent_revisions.get(
                plan.scope.alias, intent_revision
            )
        return apply_reconcile_business_locked(
            plan,
            read_snapshot,
            operation_result,
            current_intent_revision=intent_revision,
            current_operation_id=(
                pending.operation_id if pending is not None else plan.captured_operation_id or None
            ),
            current_pending=pending,
            desired_intent=desired_intent,
            clock=self._clock,
            publish_reason=publish_reason,
            publish_cooldown_type=publish_cooldown_type,
        )

    def _route_v2_operation_result(
        self,
        *,
        scope: SharedStateScope,
        operation_result: PendingOperationResult,
        desired_intent: DesiredIntent,
        pending: PendingSharedOperation | None,
        protected_deadline: float,
        publish_reason: str | None = None,
        publish_cooldown_type: str | None = None,
        on_converged: Callable[[], None] | None = None,
    ) -> None:
        store = self._v2_store()
        if store is None:
            return

        def capture_plan_locked() -> ReconcilePlanCapture | None:
            with self._lock:
                return self._capture_reconcile_plan_locked(
                    scope=scope,
                    desired_intent=desired_intent,
                    pending=pending,
                    protected_deadline_monotonic=protected_deadline,
                    needs_redis_refresh=_needs_refresh(operation_result),
                )

        def apply_locked(plan, read_snapshot, op_result):
            with self._lock:
                outcome, updated_pending, convergence = self._apply_reconcile_locked(
                    plan,
                    read_snapshot,
                    op_result,
                    pending=pending,
                    desired_intent=desired_intent,
                    publish_reason=publish_reason,
                    publish_cooldown_type=publish_cooldown_type,
                )
                alias = scope.alias
                if scope.is_model:
                    cache_key = self._model_cache_key(alias, scope.model)
                    if outcome.status.value in ("converged", "terminal_failure"):
                        self._pending_model_publishes.pop(cache_key, None)
                        self._pending_model_clear_v2.pop(cache_key, None)
                    elif updated_pending is not None:
                        if updated_pending.operation_type == "publish":
                            self._pending_model_publishes[cache_key] = PendingPublishState(
                                operation=updated_pending
                            )
                        else:
                            self._pending_model_clear_v2[cache_key] = PendingClearStateV2(
                                operation=updated_pending
                            )
                else:
                    if outcome.status.value in ("converged", "terminal_failure"):
                        self._pending_cooldown_publishes.pop(alias, None)
                        self._pending_cooldown_clear_v2.pop(alias, None)
                        if on_converged is not None:
                            on_converged()
                    elif updated_pending is not None:
                        if updated_pending.operation_type == "publish":
                            self._pending_cooldown_publishes[alias] = PendingPublishState(
                                operation=updated_pending,
                                reason=publish_reason,
                                cooldown_type=publish_cooldown_type,
                            )
                        else:
                            self._pending_cooldown_clear_v2[alias] = PendingClearStateV2(
                                operation=updated_pending
                            )
                if convergence is not None and op_result is None:
                    del convergence
                return outcome, updated_pending, convergence

        handle_operation_result(
            scope=scope,
            store=store,
            clock=self._clock,
            operation_result=operation_result,
            capture_plan_locked=capture_plan_locked,
            apply_locked=apply_locked,
        )


    def _sync_alias_from_shared_locked(
        self,
        shared: SharedAliasSnapshot,
        *,
        model_name: str,
        now: float,
    ) -> None:
        alias = shared.alias
        alias_changed = False
        if (
            alias not in self._pending_cooldown_clears
            and alias not in self._pending_cooldown_publishes
        ):
            incoming_active = (
                shared.cooldown_state is not None and shared.cooldown_pttl_ms > 0
            )
            incoming_remaining = (
                max(0.0, shared.cooldown_pttl_ms / 1000.0)
                if incoming_active
                else 0.0
            )
            incoming_reason = (
                shared.cooldown_state.reason if shared.cooldown_state else None
            )
            incoming_type = (
                shared.cooldown_state.cooldown_type
                if shared.cooldown_state
                else None
            )
            if self._cooldown_logical_changed_locked(
                alias,
                incoming_active=incoming_active,
                incoming_reason=incoming_reason,
                incoming_type=incoming_type,
                incoming_remaining=incoming_remaining,
                now=now,
            ):
                alias_changed = True
                if incoming_active and shared.cooldown_state is not None:
                    self._local_cooldown[alias] = LocalCooldownState(
                        reason=shared.cooldown_state.reason,
                        cooldown_type=shared.cooldown_state.cooldown_type,
                        expires_at_monotonic=now + incoming_remaining,
                    )
                    local_state = self._states.get(alias)
                    if local_state is not None:
                        local_state.last_error_code = shared.cooldown_state.reason
                        local_state.last_retry_after_seconds = int(
                            ceil(incoming_remaining)
                        )
                else:
                    self._local_cooldown.pop(alias, None)
                    local_state = self._states.get(alias)
                    if local_state is not None:
                        local_state.disabled_until_monotonic = 0.0
                        local_state.last_error_code = None
                        local_state.last_retry_after_seconds = 0

        model_changed = False
        if model_name:
            cache_key = self._model_cache_key(alias, model_name)
            if (
                cache_key not in self._pending_model_clears
                and cache_key not in self._pending_model_publishes
            ):
                incoming_active = (
                    shared.model_unsupported and shared.model_pttl_ms > 0
                )
                incoming_remaining = (
                    max(0.0, shared.model_pttl_ms / 1000.0)
                    if incoming_active
                    else 0.0
                )
                if self._model_unsupported_logical_changed_locked(
                    cache_key,
                    incoming_active=incoming_active,
                    incoming_remaining=incoming_remaining,
                    now=now,
                ):
                    model_changed = True
                    if incoming_active:
                        self._unsupported_expires_monotonic[cache_key] = (
                            now + incoming_remaining
                        )
                    else:
                        self._unsupported_expires_monotonic.pop(cache_key, None)

        if alias_changed:
            self._increment_alias_generation_locked(alias)
        if model_changed:
            self._increment_model_generation_locked(alias, model_name)

    def _pending_clear_capture_locked(
        self, model_name: str, now: float
    ) -> tuple[dict[str, PendingClearState], dict[tuple[str, str, str], PendingClearState]]:
        self._expire_pending_clears_locked(now)
        cooldown = {
            alias: pending
            for alias, pending in self._pending_cooldown_clears.items()
            if now >= pending.next_retry_at_monotonic
        }
        model = {
            cache_key: pending
            for cache_key, pending in self._pending_model_clears.items()
            if cache_key[2] == model_name and now >= pending.next_retry_at_monotonic
        }
        return cooldown, model

    def _process_pending_clear_success_locked(
        self,
        *,
        cooldown_pending: dict[str, PendingClearState],
        model_pending: dict[tuple[str, str, str], PendingClearState],
        model_name: str,
        succeeded_operation_ids: frozenset[str] | None = None,
    ) -> None:
        succeeded = succeeded_operation_ids or frozenset()
        for alias, pending in cooldown_pending.items():
            v2_pending = self._pending_cooldown_clear_v2.get(alias)
            if v2_pending is not None:
                if (
                    succeeded
                    and v2_pending.operation.operation_id not in succeeded
                ):
                    continue
                self._pending_cooldown_clear_v2.pop(alias, None)
                self._pending_cooldown_clears.pop(alias, None)
                self._increment_alias_generation_locked(alias)
                continue
            if self._pending_cooldown_clears.get(alias) is pending:
                if succeeded:
                    continue
                self._pending_cooldown_clears.pop(alias, None)
                self._increment_alias_generation_locked(alias)
        for cache_key, pending in model_pending.items():
            v2_pending = self._pending_model_clear_v2.get(cache_key)
            if v2_pending is not None:
                if (
                    succeeded
                    and v2_pending.operation.operation_id not in succeeded
                ):
                    continue
                self._pending_model_clear_v2.pop(cache_key, None)
                self._pending_model_clears.pop(cache_key, None)
                self._increment_model_generation_locked(cache_key[0], cache_key[2])
                continue
            if self._pending_model_clears.get(cache_key) is pending:
                if succeeded:
                    continue
                self._pending_model_clears.pop(cache_key, None)
                self._increment_model_generation_locked(cache_key[0], cache_key[2])

    def _process_pending_clear_failure_locked(
        self,
        *,
        cooldown_pending: dict[str, PendingClearState],
        model_pending: dict[tuple[str, str, str], PendingClearState],
        now: float,
        error_type: str | None,
    ) -> None:
        for alias, pending in cooldown_pending.items():
            current = self._pending_cooldown_clears.get(alias)
            if current is pending:
                updated = self._schedule_pending_clear_retry(
                    pending, now=now, error_type=error_type
                )
                self._pending_cooldown_clears[alias] = updated
        for cache_key, pending in model_pending.items():
            current = self._pending_model_clears.get(cache_key)
            if current is pending:
                updated = self._schedule_pending_clear_retry(
                    pending, now=now, error_type=error_type
                )
                self._pending_model_clears[cache_key] = updated

    def _refresh_pool_v2(
        self,
        entries: tuple[GeminiKeyEntry, ...],
        *,
        model_name: str,
        captured_alias_generations: dict[str, int],
        captured_model_generations: dict[tuple[str, str], int],
        cooldown_pending: dict[str, PendingClearState],
        model_pending: dict[tuple[str, str, str], PendingClearState],
        v2_cooldown_clears: dict[str, PendingClearStateV2],
    ) -> tuple[dict[str, GeminiAliasStateSnapshot], int, bool]:
        v2_store = self._v2_store()
        assert v2_store is not None
        succeeded_operation_ids: set[str] = set()
        shared_by_alias: dict[str, object] = {}
        entry_aliases = {entry.alias for entry in entries}

        for alias, v2_clear in v2_cooldown_clears.items():
            if alias not in entry_aliases:
                continue
            if alias in cooldown_pending or alias in self._pending_cooldown_clears:
                pass
            scope = self._shared_scope(alias)
            snapshot = v2_store.read_scope_snapshot(scope)
            started = self._clock()
            write = v2_store.clear_cooldown_cas(
                scope,
                expected_revision=snapshot.cooldown_revision,
                expected_digest=snapshot.cooldown_digest,
            )
            completed = self._clock()
            if write.success:
                succeeded_operation_ids.add(v2_clear.operation.operation_id)
            self._route_v2_operation_result(
                scope=scope,
                operation_result=PendingOperationResult(
                    operation_id=v2_clear.operation.operation_id,
                    status=write.status,
                    write_result=write,
                    timing=RedisCallTiming(
                        started_at_monotonic=started,
                        completed_at_monotonic=completed,
                    ),
                ),
                desired_intent=DesiredIntent.CLEAR,
                pending=v2_clear.operation,
                protected_deadline=v2_clear.operation.operation_deadline_monotonic,
            )

        for entry in entries:
            scope = self._shared_scope(entry.alias)
            shared_by_alias[entry.alias] = v2_store.read_scope_snapshot(
                scope, model=model_name
            )

        decision_now = self._clock()
        with self._lock:
            if succeeded_operation_ids:
                self._process_pending_clear_success_locked(
                    cooldown_pending=cooldown_pending,
                    model_pending=model_pending,
                    model_name=model_name,
                    succeeded_operation_ids=frozenset(succeeded_operation_ids),
                )
            snapshots: dict[str, GeminiAliasStateSnapshot] = {}
            for entry in entries:
                alias = entry.alias
                if self._alias_generation.get(alias, 0) != captured_alias_generations.get(
                    alias, 0
                ):
                    snapshots[alias] = self._local_snapshots_locked(
                        (entry,), model_name=model_name, now=decision_now
                    )[alias]
                    continue
                if model_name and self._model_generation.get(
                    (alias, model_name), 0
                ) != captured_model_generations.get((alias, model_name), 0):
                    snapshots[alias] = self._local_snapshots_locked(
                        (entry,), model_name=model_name, now=decision_now
                    )[alias]
                    continue
                shared = shared_by_alias[alias]
                self._sync_alias_from_v2_snapshot_locked(
                    alias, shared, model_name=model_name, now=decision_now
                )
                snapshots[alias] = self._v2_alias_snapshot(
                    shared, model_name=model_name
                )
            self._cleanup_expired_locked(decision_now)
            return snapshots, self._state_generation, True

    def _refresh_pool(
        self,
        entries: tuple[GeminiKeyEntry, ...],
        *,
        model_name: str,
    ) -> tuple[dict[str, GeminiAliasStateSnapshot], int, bool]:
        capture_now = self._clock()
        with self._lock:
            self._cleanup_expired_locked(capture_now)
            captured_alias_generations = {
                entry.alias: self._alias_generation.get(entry.alias, 0)
                for entry in entries
            }
            captured_model_generations = {
                (entry.alias, model_name): self._model_generation.get(
                    (entry.alias, model_name), 0
                )
                for entry in entries
            }
            cooldown_pending, model_pending = self._pending_clear_capture_locked(
                model_name, capture_now
            )
            v2_cooldown_clears = dict(self._pending_cooldown_clear_v2)
            scopes = tuple(self._scope_for(entry.alias) for entry in entries)

        store = self._cooldown_store
        if store is None:
            decision_now = self._clock()
            with self._lock:
                self._cleanup_expired_locked(decision_now)
                return (
                    self._local_snapshots_locked(
                        entries, model_name=model_name, now=decision_now
                    ),
                    self._state_generation,
                    True,
                )

        if self._v2_store() is not None:
            return self._refresh_pool_v2(
                entries,
                model_name=model_name,
                captured_alias_generations=captured_alias_generations,
                captured_model_generations=captured_model_generations,
                cooldown_pending=cooldown_pending,
                model_pending=model_pending,
                v2_cooldown_clears=v2_cooldown_clears,
            )

        shared_snapshot = store.read_pool_snapshot(
            scopes,
            model_name,
            now_ms=self._now_ms(),
            clear_cooldown_aliases=frozenset(cooldown_pending),
            clear_model_aliases=frozenset(key[0] for key in model_pending),
        )

        decision_now = self._clock()
        error_type = (
            type(shared_snapshot.error).__name__
            if shared_snapshot.error is not None
            else None
        )
        with self._lock:
            if shared_snapshot.success:
                self._process_pending_clear_success_locked(
                    cooldown_pending=cooldown_pending,
                    model_pending=model_pending,
                    model_name=model_name,
                )
                for shared in shared_snapshot.aliases:
                    alias = shared.alias
                    if self._alias_generation.get(alias, 0) != captured_alias_generations.get(
                        alias, 0
                    ):
                        continue
                    if model_name and self._model_generation.get(
                        (alias, model_name), 0
                    ) != captured_model_generations.get((alias, model_name), 0):
                        continue
                    self._sync_alias_from_shared_locked(
                        shared, model_name=model_name, now=decision_now
                    )
            else:
                self._process_pending_clear_failure_locked(
                    cooldown_pending=cooldown_pending,
                    model_pending=model_pending,
                    now=decision_now,
                    error_type=error_type,
                )
            self._cleanup_expired_locked(decision_now)
            return (
                self._local_snapshots_locked(
                    entries, model_name=model_name, now=decision_now
                ),
                self._state_generation,
                shared_snapshot.success,
            )

    @staticmethod
    def _eligible_from_snapshot(snapshot: GeminiAliasStateSnapshot) -> bool:
        return snapshot.cooldown_state is None and not snapshot.model_unsupported

    @staticmethod
    def _normalize_attempted_aliases(
        attempted_aliases: set[str] | frozenset[str] | None,
    ) -> frozenset[str]:
        return frozenset(
            str(alias or "").strip()
            for alias in (attempted_aliases or set())
            if str(alias or "").strip()
        )

    def _selection_for_entry(
        self,
        entry: GeminiKeyEntry,
        snapshots: dict[str, GeminiAliasStateSnapshot],
        entries: tuple[GeminiKeyEntry, ...],
        attempted: frozenset[str],
        revision: LocalStateRevision,
    ) -> GeminiKeySelection:
        has_other = any(
            candidate.alias != entry.alias
            and candidate.alias not in attempted
            and self._eligible_from_snapshot(snapshots[candidate.alias])
            for candidate in entries
        )
        return GeminiKeySelection(
            available=True,
            entry=entry,
            has_unattempted_eligible=has_other,
            selection_revision=revision,
        )

    def _unavailable_selection(
        self,
        snapshots: dict[str, GeminiAliasStateSnapshot],
        entries: tuple[GeminiKeyEntry, ...],
        *,
        model_name: str,
        attempted: frozenset[str],
        revision: LocalStateRevision,
    ) -> GeminiKeySelection:
        reasons: dict[str, str] = {}
        remaining_values: list[float] = []
        for entry in entries:
            snapshot = snapshots[entry.alias]
            if snapshot.model_unsupported:
                reasons[entry.alias] = "model_unavailable"
                continue
            if snapshot.cooldown_state is not None:
                state = snapshot.cooldown_state
                reasons[entry.alias] = state.reason or "cooldown"
                remaining_values.append(max(0.0, state.remaining_seconds))
        all_model_unsupported = bool(
            model_name
            and entries
            and all(snapshots[entry.alias].model_unsupported for entry in entries)
        )
        reason_values = set(reasons.values())
        all_terminal = bool(reasons) and reason_values <= _TERMINAL_UNAVAILABLE_REASONS
        retry_after = (
            int(ceil(min(remaining_values))) if remaining_values else 0
        )
        eligible_unattempted = any(
            entry.alias not in attempted
            and self._eligible_from_snapshot(snapshots[entry.alias])
            for entry in entries
        )
        common_reason = next(iter(reason_values)) if len(reason_values) == 1 else None
        return GeminiKeySelection(
            available=False,
            retry_after_seconds=retry_after,
            cooldown_active=len(remaining_values),
            unavailable_reasons=reasons,
            all_terminal=all_terminal,
            all_model_unsupported=all_model_unsupported,
            has_unattempted_eligible=eligible_unattempted,
            reason=common_reason,
            selection_revision=revision,
        )

    def select_key(
        self,
        preferred_alias: str | None = None,
        model: str | None = None,
        *,
        attempted_aliases: set[str] | frozenset[str] | None = None,
        exclude_aliases: set[str] | frozenset[str] | None = None,
        allow_preferred_reuse: bool = False,
    ) -> GeminiKeySelection:
        preferred = str(preferred_alias or "").strip()
        model_name = self.normalize_model_name(model)
        attempted = self._normalize_attempted_aliases(attempted_aliases)
        excluded = self._normalize_attempted_aliases(exclude_aliases)
        entries = tuple(self._entries)

        ticket: int | None = None
        if not preferred:
            with self._lock:
                ticket = self._reserve_selection_ticket_locked()

        snapshots, _generation, _shared_fresh = self._refresh_pool(
            entries, model_name=model_name
        )

        if preferred and preferred not in excluded:
            may_reuse_preferred = (
                preferred not in attempted
                or (
                    allow_preferred_reuse
                    and preferred not in excluded
                )
            )
            if may_reuse_preferred:
                for entry in entries:
                    if entry.alias == preferred:
                        if self._eligible_from_snapshot(snapshots[entry.alias]):
                            with self._lock:
                                revision = self._capture_revision_locked(
                                    entry.alias, model_name
                                )
                            return self._selection_for_entry(
                                entry,
                                snapshots,
                                entries,
                                attempted,
                                revision,
                            )
                        break

        eligible_unattempted = [
            entry
            for entry in entries
            if entry.alias not in attempted
            and entry.alias not in excluded
            and self._eligible_from_snapshot(snapshots[entry.alias])
        ]
        if not eligible_unattempted:
            with self._lock:
                revision = LocalStateRevision(
                    alias_generation=self._state_generation,
                    model_generation=0,
                )
            return self._unavailable_selection(
                snapshots,
                entries,
                model_name=model_name,
                attempted=attempted,
                revision=revision,
            )

        if ticket is None:
            with self._lock:
                ticket = self._reserve_selection_ticket_locked()
        size = len(entries)
        start_index = ticket % size
        for offset in range(size):
            entry = entries[(start_index + offset) % size]
            if entry.alias in excluded:
                continue
            if entry.alias in attempted:
                continue
            if self._eligible_from_snapshot(snapshots[entry.alias]):
                if offset:
                    with self._lock:
                        self._selection_ticket = max(
                            self._selection_ticket, ticket + offset + 1
                        )
                with self._lock:
                    revision = self._capture_revision_locked(
                        entry.alias, model_name
                    )
                return self._selection_for_entry(
                    entry, snapshots, entries, attempted, revision
                )
        with self._lock:
            revision = LocalStateRevision(
                alias_generation=self._state_generation,
                model_generation=0,
            )
        return self._unavailable_selection(
            snapshots,
            entries,
            model_name=model_name,
            attempted=attempted,
            revision=revision,
        )

    def _shared_alias_blocked(
        self, shared: SharedAliasSnapshot, *, model_name: str
    ) -> bool:
        if shared.cooldown_state is not None and shared.cooldown_pttl_ms > 0:
            return True
        return bool(
            model_name and shared.model_unsupported and shared.model_pttl_ms > 0
        )

    def validate_selection(
        self, selection: GeminiKeySelection, *, model: str | None = None
    ) -> bool:
        entry = selection.entry
        if not selection.available or entry is None:
            return False
        alias = entry.alias
        model_name = self.normalize_model_name(model)
        store = self._cooldown_store

        for _attempt in range(MAX_VALIDATION_REFRESH_ATTEMPTS + 1):
            baseline_revision = selection.selection_revision
            with self._lock:
                now = self._clock()
                self._cleanup_expired_locked(now)
                if baseline_revision is None:
                    baseline_revision = self._capture_revision_locked(alias, model_name)
                cooldown_pending, model_pending = self._pending_clear_capture_locked(
                    model_name, now
                )
                scope = self._scope_for(alias)

            if store is None:
                with self._lock:
                    snapshots = self._local_snapshots_locked(
                        (entry,), model_name=model_name, now=self._clock()
                    )
                    return self._eligible_from_snapshot(snapshots[alias])

            shared_snapshot = store.read_pool_snapshot(
                (scope,),
                model_name,
                now_ms=self._now_ms(),
                clear_cooldown_aliases=frozenset(cooldown_pending),
                clear_model_aliases=frozenset(key[0] for key in model_pending),
            )
            decision_now = self._clock()
            error_type = (
                type(shared_snapshot.error).__name__
                if shared_snapshot.error is not None
                else None
            )

            with self._lock:
                if shared_snapshot.success:
                    shared = next(
                        (item for item in shared_snapshot.aliases if item.alias == alias),
                        None,
                    )
                    if shared is None:
                        snapshots = self._local_snapshots_locked(
                            (entry,), model_name=model_name, now=decision_now
                        )
                        return self._eligible_from_snapshot(snapshots[alias])

                    if self._shared_alias_blocked(shared, model_name=model_name):
                        if not self._revision_changed_locked(
                            baseline_revision, alias, model_name
                        ):
                            self._sync_alias_from_shared_locked(
                                shared, model_name=model_name, now=decision_now
                            )
                        return False

                    if self._revision_changed_locked(
                        baseline_revision, alias, model_name
                    ):
                        continue

                    self._process_pending_clear_success_locked(
                        cooldown_pending=cooldown_pending,
                        model_pending=model_pending,
                        model_name=model_name,
                    )
                    self._sync_alias_from_shared_locked(
                        shared, model_name=model_name, now=decision_now
                    )
                    return True

                self._process_pending_clear_failure_locked(
                    cooldown_pending=cooldown_pending,
                    model_pending=model_pending,
                    now=decision_now,
                    error_type=error_type,
                )
                snapshots = self._local_snapshots_locked(
                    (entry,), model_name=model_name, now=decision_now
                )
                return self._eligible_from_snapshot(snapshots[alias])

        return False

    def is_model_unsupported(self, alias: str, model: str | None) -> bool:
        model_name = self.normalize_model_name(model)
        entry = next((item for item in self._entries if item.alias == alias), None)
        if not model_name or entry is None:
            return False
        snapshots, _generation, _shared_fresh = self._refresh_pool(
            (entry,), model_name=model_name
        )
        return snapshots[entry.alias].model_unsupported

    def all_keys_unsupported_for_model(self, model: str | None) -> bool:
        model_name = self.normalize_model_name(model)
        entries = tuple(self._entries)
        if not model_name or not entries:
            return False
        snapshots, _generation, _shared_fresh = self._refresh_pool(
            entries, model_name=model_name
        )
        return all(snapshots[entry.alias].model_unsupported for entry in entries)

    def has_eligible_key(
        self,
        model: str | None = None,
        *,
        exclude_alias: str | None = None,
    ) -> bool:
        excluded = str(exclude_alias or "").strip()
        entries = tuple(self._entries)
        snapshots, _generation, _shared_fresh = self._refresh_pool(
            entries, model_name=self.normalize_model_name(model)
        )
        return any(
            (not excluded or entry.alias != excluded)
            and self._eligible_from_snapshot(snapshots[entry.alias])
            for entry in entries
        )

    def has_unattempted_eligible_key(
        self,
        model: str | None,
        attempted_aliases: set[str] | frozenset[str],
        *,
        exclude_aliases: set[str] | frozenset[str] | None = None,
    ) -> bool:
        attempted = self._normalize_attempted_aliases(attempted_aliases)
        excluded = self._normalize_attempted_aliases(exclude_aliases)
        entries = tuple(self._entries)
        snapshots, _generation, _shared_fresh = self._refresh_pool(
            entries, model_name=self.normalize_model_name(model)
        )
        return any(
            entry.alias not in attempted
            and entry.alias not in excluded
            and self._eligible_from_snapshot(snapshots[entry.alias])
            for entry in entries
        )

    def cooldown_remaining(self, alias: str) -> float:
        entry = next((item for item in self._entries if item.alias == alias), None)
        if entry is None:
            return 0.0
        snapshots, _generation, _shared_fresh = self._refresh_pool(
            (entry,), model_name=""
        )
        state = snapshots[entry.alias].cooldown_state
        return max(0.0, state.remaining_seconds) if state is not None else 0.0

    def mark_model_unsupported(self, alias: str, model: str) -> None:
        normalized_alias = str(alias or "").strip()
        model_name = self.normalize_model_name(model)
        if normalized_alias not in self._states or not model_name:
            return
        scope = self._scope_for(normalized_alias)
        shared_scope = self._shared_scope(normalized_alias, model=model_name)
        cache_key = self._model_cache_key(normalized_alias, model_name)
        expires_at = self._clock() + float(self._model_unsupported_ttl_seconds)
        pending_op: PendingSharedOperation | None = None
        v2_store = self._v2_store()
        with self._lock:
            self._pending_model_clears.pop(cache_key, None)
            self._pending_model_clear_v2.pop(cache_key, None)
            self._unsupported_expires_monotonic[cache_key] = expires_at
            if v2_store is not None:
                intent_revision = self._bump_model_intent_locked(cache_key)
                pending_op = build_publish_operation_locked(
                    scope=shared_scope,
                    intent_revision=intent_revision,
                    protected_deadline_monotonic=expires_at,
                    expected_shared_revision=0,
                    expected_value_digest=None,
                    current_pending=(
                        self._pending_model_publishes[cache_key].operation
                        if cache_key in self._pending_model_publishes
                        else None
                    ),
                    clock=self._clock,
                )
                self._pending_model_publishes[cache_key] = PendingPublishState(
                    operation=pending_op
                )
            self._increment_model_generation_locked(normalized_alias, model_name)
        if v2_store is not None and pending_op is not None:
            snapshot = v2_store.read_scope_snapshot(shared_scope, model=model_name)
            pending_op.expected_shared_revision = snapshot.model_revision
            pending_op.expected_value_digest = snapshot.model_digest
            started = self._clock()
            write = v2_store.mark_model_unsupported_cas(
                shared_scope,
                expected_revision=snapshot.model_revision,
                expected_digest=snapshot.model_digest,
            )
            completed = self._clock()
            self._route_v2_operation_result(
                scope=shared_scope,
                operation_result=PendingOperationResult(
                    operation_id=pending_op.operation_id,
                    status=write.status,
                    write_result=write,
                    timing=RedisCallTiming(
                        started_at_monotonic=started,
                        completed_at_monotonic=completed,
                    ),
                ),
                desired_intent=DesiredIntent.PUBLISH,
                pending=pending_op,
                protected_deadline=expires_at,
            )
        elif self._cooldown_store is not None:
            self._cooldown_store.mark_model_unsupported(
                scope, model_name, now_ms=self._now_ms()
            )

    def clear_model_unsupported(self, alias: str, model: str) -> None:
        normalized_alias = str(alias or "").strip()
        model_name = self.normalize_model_name(model)
        if normalized_alias not in self._states or not model_name:
            return
        scope = self._scope_for(normalized_alias)
        shared_scope = self._shared_scope(normalized_alias, model=model_name)
        cache_key = self._model_cache_key(normalized_alias, model_name)
        store = self._cooldown_store
        v2_store = self._v2_store()
        now = self._clock()
        pending_op: PendingSharedOperation | None = None
        with self._lock:
            self._unsupported_expires_monotonic.pop(cache_key, None)
            self._pending_model_publishes.pop(cache_key, None)
            if store is not None:
                self._pending_model_clears[cache_key] = self._new_pending_clear_state(
                    now
                )
                if v2_store is not None:
                    intent_revision = self._bump_model_intent_locked(cache_key)
                    pending_op = build_clear_operation_locked(
                        scope=shared_scope,
                        intent_revision=intent_revision,
                        expected_shared_revision=0,
                        expected_value_digest=None,
                        current_pending=(
                            self._pending_model_clear_v2[cache_key].operation
                            if cache_key in self._pending_model_clear_v2
                            else None
                        ),
                        clock=self._clock,
                    )
                    self._pending_model_clear_v2[cache_key] = PendingClearStateV2(
                        operation=pending_op
                    )
            self._increment_model_generation_locked(normalized_alias, model_name)
        if store is None:
            return
        if v2_store is not None and pending_op is not None:
            snapshot = v2_store.read_scope_snapshot(shared_scope, model=model_name)
            pending_op.expected_shared_revision = snapshot.model_revision
            pending_op.expected_value_digest = snapshot.model_digest
            started = self._clock()
            write = v2_store.clear_model_unsupported_cas(
                shared_scope,
                expected_revision=snapshot.model_revision,
                expected_digest=snapshot.model_digest,
            )
            completed = self._clock()
            self._route_v2_operation_result(
                scope=shared_scope,
                operation_result=PendingOperationResult(
                    operation_id=pending_op.operation_id,
                    status=write.status,
                    write_result=write,
                    timing=RedisCallTiming(
                        started_at_monotonic=started,
                        completed_at_monotonic=completed,
                    ),
                ),
                desired_intent=DesiredIntent.CLEAR,
                pending=pending_op,
                protected_deadline=pending_op.operation_deadline_monotonic,
            )
            return
        success = bool(store.clear_model_unsupported(scope, model_name))
        with self._lock:
            pending = self._pending_model_clears.get(cache_key)
            if success and pending is not None:
                self._pending_model_clears.pop(cache_key, None)
                self._increment_model_generation_locked(normalized_alias, model_name)
            elif not success and pending is not None:
                self._pending_model_clears[cache_key] = self._schedule_pending_clear_retry(
                    pending,
                    now=self._clock(),
                    error_type="clear_failed",
                )

    def cooldown_key(self, alias: str, *, seconds: float, reason: str) -> None:
        self._set_cooldown(
            alias, seconds=seconds, reason=reason, cooldown_type="soft"
        )

    def hard_cooldown_key(self, alias: str, *, seconds: float, reason: str) -> None:
        self._set_cooldown(
            alias, seconds=seconds, reason=reason, cooldown_type="hard"
        )

    def _set_cooldown(
        self,
        alias: str,
        *,
        seconds: float,
        reason: str,
        cooldown_type: str,
    ) -> None:
        scope = self._scope_for(alias)
        shared_scope = self._shared_scope(alias)
        cooldown_seconds = max(0.0, float(seconds or 0.0))
        normalized_reason = str(reason or "unknown").strip() or "unknown"
        expires_at = self._clock() + cooldown_seconds
        pending_op: PendingSharedOperation | None = None
        v2_store = self._v2_store()
        with self._lock:
            state = self._states.get(alias)
            if state is None:
                return
            self._pending_cooldown_clears.pop(alias, None)
            self._pending_cooldown_clear_v2.pop(alias, None)
            self._local_cooldown[alias] = LocalCooldownState(
                reason=normalized_reason,
                cooldown_type=cooldown_type,
                expires_at_monotonic=expires_at,
            )
            state.disabled_until_monotonic = max(
                state.disabled_until_monotonic, expires_at
            )
            state.last_error_code = normalized_reason
            state.last_retry_after_seconds = int(ceil(cooldown_seconds))
            state.consecutive_failures += 1
            if v2_store is not None:
                intent_revision = self._bump_cooldown_intent_locked(alias)
                pending_op = build_publish_operation_locked(
                    scope=shared_scope,
                    intent_revision=intent_revision,
                    protected_deadline_monotonic=expires_at,
                    expected_shared_revision=0,
                    expected_value_digest=None,
                    current_pending=self._pending_cooldown_publishes.get(
                        alias
                    ).operation
                    if alias in self._pending_cooldown_publishes
                    else None,
                    clock=self._clock,
                    reason=normalized_reason,
                    cooldown_type=cooldown_type,
                )
                self._pending_cooldown_publishes[alias] = PendingPublishState(
                    operation=pending_op,
                    reason=normalized_reason,
                    cooldown_type=cooldown_type,
                )
            self._increment_alias_generation_locked(alias)

        if v2_store is not None and pending_op is not None:
            snapshot = v2_store.read_scope_snapshot(shared_scope)
            pending_op.expected_shared_revision = snapshot.cooldown_revision
            pending_op.expected_value_digest = snapshot.cooldown_digest
            remaining_ms = max(1, math.floor((expires_at - self._clock()) * 1000))
            started = self._clock()
            write = v2_store.apply_cooldown_cas(
                shared_scope,
                expected_revision=snapshot.cooldown_revision,
                remaining_ms=remaining_ms,
                reason=normalized_reason,
                cooldown_type=cooldown_type,
                expected_digest=snapshot.cooldown_digest,
            )
            completed = self._clock()
            self._route_v2_operation_result(
                scope=shared_scope,
                operation_result=PendingOperationResult(
                    operation_id=pending_op.operation_id,
                    status=write.status,
                    write_result=write,
                    timing=RedisCallTiming(
                        started_at_monotonic=started,
                        completed_at_monotonic=completed,
                    ),
                ),
                desired_intent=DesiredIntent.PUBLISH,
                pending=pending_op,
                protected_deadline=expires_at,
                publish_reason=normalized_reason,
                publish_cooldown_type=cooldown_type,
            )
        elif self._cooldown_store is not None:
            self._cooldown_store.apply_cooldown(
                scope,
                seconds=cooldown_seconds,
                reason=normalized_reason,
                cooldown_type=cooldown_type,
                now_ms=self._now_ms(),
            )

    def clear_cooldown(self, alias: str) -> None:
        scope = self._scope_for(alias)
        shared_scope = self._shared_scope(alias)
        store = self._cooldown_store
        v2_store = self._v2_store()
        now = self._clock()
        pending_op: PendingSharedOperation | None = None
        with self._lock:
            state = self._states.get(alias)
            if state is None:
                return
            state.disabled_until_monotonic = 0.0
            state.last_error_code = None
            state.last_retry_after_seconds = 0
            self._local_cooldown.pop(alias, None)
            self._pending_cooldown_publishes.pop(alias, None)
            if store is not None:
                self._pending_cooldown_clears[alias] = self._new_pending_clear_state(now)
                if v2_store is not None:
                    intent_revision = self._bump_cooldown_intent_locked(alias)
                    pending_op = build_clear_operation_locked(
                        scope=shared_scope,
                        intent_revision=intent_revision,
                        expected_shared_revision=0,
                        expected_value_digest=None,
                        current_pending=(
                            self._pending_cooldown_clear_v2[alias].operation
                            if alias in self._pending_cooldown_clear_v2
                            else None
                        ),
                        clock=self._clock,
                    )
                    self._pending_cooldown_clear_v2[alias] = PendingClearStateV2(
                        operation=pending_op
                    )
            self._increment_alias_generation_locked(alias)
        if store is None:
            return
        if v2_store is not None and pending_op is not None:
            snapshot = v2_store.read_scope_snapshot(shared_scope)
            pending_op.expected_shared_revision = snapshot.cooldown_revision
            pending_op.expected_value_digest = snapshot.cooldown_digest
            started = self._clock()
            write = v2_store.clear_cooldown_cas(
                shared_scope,
                expected_revision=snapshot.cooldown_revision,
                expected_digest=snapshot.cooldown_digest,
            )
            completed = self._clock()
            self._route_v2_operation_result(
                scope=shared_scope,
                operation_result=PendingOperationResult(
                    operation_id=pending_op.operation_id,
                    status=write.status,
                    write_result=write,
                    timing=RedisCallTiming(
                        started_at_monotonic=started,
                        completed_at_monotonic=completed,
                    ),
                ),
                desired_intent=DesiredIntent.CLEAR,
                pending=pending_op,
                protected_deadline=pending_op.operation_deadline_monotonic,
            )
            return
        success = bool(store.clear_cooldown(scope))
        with self._lock:
            pending = self._pending_cooldown_clears.get(alias)
            if success and pending is not None:
                self._pending_cooldown_clears.pop(alias, None)
                self._increment_alias_generation_locked(alias)
            elif not success and pending is not None:
                self._pending_cooldown_clears[alias] = self._schedule_pending_clear_retry(
                    pending,
                    now=self._clock(),
                    error_type="clear_failed",
                )

    def _cooldown_remaining(self, alias: str, *, now: float) -> float:
        with self._lock:
            self._cleanup_expired_locked(now)
            state = self._local_cooldown_as_state_locked(alias, now=now)
            return state.remaining_seconds if state is not None else 0.0
