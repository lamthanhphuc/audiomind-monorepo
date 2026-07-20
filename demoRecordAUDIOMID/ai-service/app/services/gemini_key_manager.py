import json
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

ALIAS_PATTERN = re.compile(r"^[a-z0-9_-]+$")
MAX_VALIDATION_REFRESH_ATTEMPTS = 2
PENDING_CLEAR_TTL_SECONDS = 300.0
PENDING_CLEAR_INITIAL_BACKOFF_SECONDS = 1.0
PENDING_CLEAR_MAX_BACKOFF_SECONDS = 30.0
TTL_SYNC_TOLERANCE_SECONDS = 1.0


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

    def _sync_alias_from_shared_locked(
        self,
        shared: SharedAliasSnapshot,
        *,
        model_name: str,
        now: float,
    ) -> None:
        alias = shared.alias
        alias_changed = False
        if alias not in self._pending_cooldown_clears:
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
            if cache_key not in self._pending_model_clears:
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
    ) -> None:
        for alias, pending in cooldown_pending.items():
            if self._pending_cooldown_clears.get(alias) is pending:
                self._pending_cooldown_clears.pop(alias, None)
                self._increment_alias_generation_locked(alias)
        for cache_key, pending in model_pending.items():
            if self._pending_model_clears.get(cache_key) is pending:
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
                self._increment_alias_generation_locked(alias)
        for cache_key, pending in model_pending.items():
            current = self._pending_model_clears.get(cache_key)
            if current is pending:
                updated = self._schedule_pending_clear_retry(
                    pending, now=now, error_type=error_type
                )
                self._pending_model_clears[cache_key] = updated
                self._increment_model_generation_locked(
                    cache_key[0], cache_key[2]
                )

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
            with self._lock:
                now = self._clock()
                self._cleanup_expired_locked(now)
                captured_revision = self._capture_revision_locked(alias, model_name)
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
                            captured_revision, alias, model_name
                        ):
                            self._sync_alias_from_shared_locked(
                                shared, model_name=model_name, now=decision_now
                            )
                        return False

                    if not self._revision_changed_locked(
                        captured_revision, alias, model_name
                    ):
                        self._process_pending_clear_success_locked(
                            cooldown_pending=cooldown_pending,
                            model_pending=model_pending,
                            model_name=model_name,
                        )
                        self._sync_alias_from_shared_locked(
                            shared, model_name=model_name, now=decision_now
                        )
                        return True
                    continue

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
    ) -> bool:
        attempted = self._normalize_attempted_aliases(attempted_aliases)
        entries = tuple(self._entries)
        snapshots, _generation, _shared_fresh = self._refresh_pool(
            entries, model_name=self.normalize_model_name(model)
        )
        return any(
            entry.alias not in attempted
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
        cache_key = self._model_cache_key(normalized_alias, model_name)
        expires_at = self._clock() + float(self._model_unsupported_ttl_seconds)
        with self._lock:
            self._pending_model_clears.pop(cache_key, None)
            self._unsupported_expires_monotonic[cache_key] = expires_at
            self._increment_model_generation_locked(normalized_alias, model_name)
        if self._cooldown_store is not None:
            self._cooldown_store.mark_model_unsupported(
                scope, model_name, now_ms=self._now_ms()
            )

    def clear_model_unsupported(self, alias: str, model: str) -> None:
        normalized_alias = str(alias or "").strip()
        model_name = self.normalize_model_name(model)
        if normalized_alias not in self._states or not model_name:
            return
        scope = self._scope_for(normalized_alias)
        cache_key = self._model_cache_key(normalized_alias, model_name)
        store = self._cooldown_store
        now = self._clock()
        with self._lock:
            self._unsupported_expires_monotonic.pop(cache_key, None)
            if store is not None:
                self._pending_model_clears[cache_key] = self._new_pending_clear_state(
                    now
                )
            self._increment_model_generation_locked(normalized_alias, model_name)
        if store is None:
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
                self._increment_model_generation_locked(normalized_alias, model_name)

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
        cooldown_seconds = max(0.0, float(seconds or 0.0))
        normalized_reason = str(reason or "unknown").strip() or "unknown"
        expires_at = self._clock() + cooldown_seconds
        with self._lock:
            state = self._states.get(alias)
            if state is None:
                return
            self._pending_cooldown_clears.pop(alias, None)
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
            self._increment_alias_generation_locked(alias)
        if self._cooldown_store is not None:
            self._cooldown_store.apply_cooldown(
                scope,
                seconds=cooldown_seconds,
                reason=normalized_reason,
                cooldown_type=cooldown_type,
                now_ms=self._now_ms(),
            )

    def clear_cooldown(self, alias: str) -> None:
        scope = self._scope_for(alias)
        store = self._cooldown_store
        now = self._clock()
        with self._lock:
            state = self._states.get(alias)
            if state is None:
                return
            state.disabled_until_monotonic = 0.0
            state.last_error_code = None
            state.last_retry_after_seconds = 0
            self._local_cooldown.pop(alias, None)
            if store is not None:
                self._pending_cooldown_clears[alias] = self._new_pending_clear_state(now)
            self._increment_alias_generation_locked(alias)
        if store is None:
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
                self._increment_alias_generation_locked(alias)

    def _cooldown_remaining(self, alias: str, *, now: float) -> float:
        with self._lock:
            self._cleanup_expired_locked(now)
            state = self._local_cooldown_as_state_locked(alias, now=now)
            return state.remaining_seconds if state is not None else 0.0
