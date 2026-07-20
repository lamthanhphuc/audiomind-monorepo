import json
import re
import threading
import time
from dataclasses import dataclass, field
from math import ceil
from typing import Callable

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
_MAX_PENDING_CLEAR_ATTEMPTS = 3


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
    snapshot_generation: int = 0

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
        self._local_cooldown: dict[str, LocalCooldownState] = {}
        self._unsupported_expires_monotonic: dict[tuple[str, str, str], float] = {}
        self._pending_cooldown_clears: dict[str, int] = {}
        self._pending_model_clears: dict[tuple[str, str, str], int] = {}
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

    def _increment_generation_locked(self) -> None:
        self._state_generation += 1

    def _reserve_selection_ticket_locked(self) -> int:
        ticket = self._selection_ticket
        self._selection_ticket += 1
        return ticket

    def _cleanup_expired_locked(self, now: float) -> None:
        changed = False
        for alias, local in tuple(self._local_cooldown.items()):
            if local.expires_at_monotonic <= now:
                self._local_cooldown.pop(alias, None)
                state = self._states.get(alias)
                if state is not None:
                    state.disabled_until_monotonic = 0.0
                    state.last_error_code = None
                    state.last_retry_after_seconds = 0
                changed = True
        for cache_key, expires_at in tuple(
            self._unsupported_expires_monotonic.items()
        ):
            if expires_at <= now:
                self._unsupported_expires_monotonic.pop(cache_key, None)
                changed = True
        if changed:
            self._increment_generation_locked()

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

    def _sync_alias_from_shared_locked(
        self,
        shared: SharedAliasSnapshot,
        *,
        model_name: str,
        now: float,
    ) -> None:
        alias = shared.alias
        if alias not in self._pending_cooldown_clears:
            state = shared.cooldown_state
            if state is not None and shared.cooldown_pttl_ms > 0:
                self._local_cooldown[alias] = LocalCooldownState(
                    reason=state.reason,
                    cooldown_type=state.cooldown_type,
                    expires_at_monotonic=now + shared.cooldown_pttl_ms / 1000.0,
                )
                local_state = self._states.get(alias)
                if local_state is not None:
                    local_state.last_error_code = state.reason
                    local_state.last_retry_after_seconds = int(
                        ceil(shared.cooldown_pttl_ms / 1000.0)
                    )
            else:
                self._local_cooldown.pop(alias, None)
                local_state = self._states.get(alias)
                if local_state is not None:
                    local_state.disabled_until_monotonic = 0.0
                    local_state.last_error_code = None
                    local_state.last_retry_after_seconds = 0

        if model_name:
            cache_key = self._model_cache_key(alias, model_name)
            if cache_key not in self._pending_model_clears:
                if shared.model_unsupported and shared.model_pttl_ms > 0:
                    self._unsupported_expires_monotonic[cache_key] = (
                        now + shared.model_pttl_ms / 1000.0
                    )
                else:
                    self._unsupported_expires_monotonic.pop(cache_key, None)
        self._increment_generation_locked()

    def _pending_clear_capture_locked(
        self, model_name: str
    ) -> tuple[dict[str, int], dict[tuple[str, str, str], int]]:
        cooldown = {
            alias: attempts
            for alias, attempts in self._pending_cooldown_clears.items()
            if attempts < _MAX_PENDING_CLEAR_ATTEMPTS
        }
        model = {
            cache_key: attempts
            for cache_key, attempts in self._pending_model_clears.items()
            if cache_key[2] == model_name
            and attempts < _MAX_PENDING_CLEAR_ATTEMPTS
        }
        return cooldown, model

    def _refresh_pool(
        self,
        entries: tuple[GeminiKeyEntry, ...],
        *,
        model_name: str,
    ) -> tuple[dict[str, GeminiAliasStateSnapshot], int, bool]:
        capture_now = self._clock()
        with self._lock:
            self._cleanup_expired_locked(capture_now)
            captured_generation = self._state_generation
            cooldown_pending, model_pending = self._pending_clear_capture_locked(
                model_name
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
        with self._lock:
            snapshot_is_stale = self._state_generation != captured_generation
            if shared_snapshot.success and not snapshot_is_stale:
                for alias, attempts in cooldown_pending.items():
                    if self._pending_cooldown_clears.get(alias) == attempts:
                        self._pending_cooldown_clears.pop(alias, None)
                        self._increment_generation_locked()
                for cache_key, attempts in model_pending.items():
                    if self._pending_model_clears.get(cache_key) == attempts:
                        self._pending_model_clears.pop(cache_key, None)
                        self._increment_generation_locked()
                for shared in shared_snapshot.aliases:
                    self._sync_alias_from_shared_locked(
                        shared, model_name=model_name, now=decision_now
                    )
            elif not shared_snapshot.success and not snapshot_is_stale:
                for alias, attempts in cooldown_pending.items():
                    if self._pending_cooldown_clears.get(alias) == attempts:
                        self._pending_cooldown_clears[alias] = attempts + 1
                        self._increment_generation_locked()
                for cache_key, attempts in model_pending.items():
                    if self._pending_model_clears.get(cache_key) == attempts:
                        self._pending_model_clears[cache_key] = attempts + 1
                        self._increment_generation_locked()
            self._cleanup_expired_locked(decision_now)
            return (
                self._local_snapshots_locked(
                    entries, model_name=model_name, now=decision_now
                ),
                self._state_generation,
                shared_snapshot.success and not snapshot_is_stale,
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
        generation: int,
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
            snapshot_generation=generation,
        )

    def _unavailable_selection(
        self,
        snapshots: dict[str, GeminiAliasStateSnapshot],
        entries: tuple[GeminiKeyEntry, ...],
        *,
        model_name: str,
        attempted: frozenset[str],
        generation: int,
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
            snapshot_generation=generation,
        )

    def select_key(
        self,
        preferred_alias: str | None = None,
        model: str | None = None,
        *,
        attempted_aliases: set[str] | frozenset[str] | None = None,
        exclude_aliases: set[str] | frozenset[str] | None = None,
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

        snapshots, generation, _shared_fresh = self._refresh_pool(
            entries, model_name=model_name
        )

        if preferred and preferred not in excluded:
            for entry in entries:
                if entry.alias == preferred:
                    if self._eligible_from_snapshot(snapshots[entry.alias]):
                        return self._selection_for_entry(
                            entry, snapshots, entries, attempted, generation
                        )
                    break

        if ticket is None:
            with self._lock:
                ticket = self._reserve_selection_ticket_locked()
        size = len(entries)
        start_index = ticket % size
        for offset in range(size):
            entry = entries[(start_index + offset) % size]
            if entry.alias in excluded:
                continue
            if self._eligible_from_snapshot(snapshots[entry.alias]):
                if offset:
                    with self._lock:
                        self._selection_ticket = max(
                            self._selection_ticket, ticket + offset + 1
                        )
                return self._selection_for_entry(
                    entry, snapshots, entries, attempted, generation
                )
        return self._unavailable_selection(
            snapshots,
            entries,
            model_name=model_name,
            attempted=attempted,
            generation=generation,
        )

    def validate_selection(
        self, selection: GeminiKeySelection, *, model: str | None = None
    ) -> bool:
        entry = selection.entry
        if not selection.available or entry is None:
            return False
        model_name = self.normalize_model_name(model)
        snapshots, _generation, _shared_fresh = self._refresh_pool(
            (entry,), model_name=model_name
        )
        snapshot = snapshots.get(entry.alias)
        return snapshot is not None and self._eligible_from_snapshot(snapshot)

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
            self._increment_generation_locked()
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
        with self._lock:
            self._unsupported_expires_monotonic.pop(cache_key, None)
            if store is not None:
                self._pending_model_clears[cache_key] = 0
            self._increment_generation_locked()
        if store is None:
            return
        success = bool(store.clear_model_unsupported(scope, model_name))
        with self._lock:
            if success and cache_key in self._pending_model_clears:
                self._pending_model_clears.pop(cache_key, None)
                self._increment_generation_locked()
            elif not success and self._pending_model_clears.get(cache_key) == 0:
                self._pending_model_clears[cache_key] = 1
                self._increment_generation_locked()

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
            self._increment_generation_locked()
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
        with self._lock:
            state = self._states.get(alias)
            if state is None:
                return
            state.disabled_until_monotonic = 0.0
            state.last_error_code = None
            state.last_retry_after_seconds = 0
            self._local_cooldown.pop(alias, None)
            if store is not None:
                self._pending_cooldown_clears[alias] = 0
            self._increment_generation_locked()
        if store is None:
            return
        success = bool(store.clear_cooldown(scope))
        with self._lock:
            if success and alias in self._pending_cooldown_clears:
                self._pending_cooldown_clears.pop(alias, None)
                self._increment_generation_locked()
            elif not success and self._pending_cooldown_clears.get(alias) == 0:
                self._pending_cooldown_clears[alias] = 1
                self._increment_generation_locked()

    def _cooldown_remaining(self, alias: str, *, now: float) -> float:
        with self._lock:
            self._cleanup_expired_locked(now)
            state = self._local_cooldown_as_state_locked(alias, now=now)
            return state.remaining_seconds if state is not None else 0.0
