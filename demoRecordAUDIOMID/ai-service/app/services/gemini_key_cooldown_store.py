from __future__ import annotations

import hashlib
import inspect
import json
import re
import threading
import time
from dataclasses import dataclass
from math import ceil
from typing import Any, Callable, Protocol

from loguru import logger

from app.services.gemini_cooldown_merge import (
    COOLDOWN_PAYLOAD_VERSION,
    LEGACY_COOLDOWN_PAYLOAD,
    CooldownMetadata,
    build_redis_merge_lua_script,
    merge_cooldown_states,
    normalize_cooldown_type,
    normalize_reason,
)

DEFAULT_SHARED_STATE_NAMESPACE = "local:ai-service"
DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS = 21600
DEFAULT_SHARED_SERVICE_NAME = "ai-service"
DEFAULT_TOMBSTONE_TTL_SECONDS = 300
_NAMESPACE_PREFIX_LIMIT = 48


@dataclass(frozen=True)
class SafeRedisResult:
    success: bool
    value: Any = None
    error: Exception | None = None


@dataclass(frozen=True)
class RedisCooldownSnapshot:
    raw: str | None
    pttl_ms: int


@dataclass(frozen=True)
class SharedCooldownReadResult:
    success: bool
    state: GeminiCooldownState | None = None
    error: Exception | None = None


@dataclass(frozen=True)
class SharedModelUnsupportedReadResult:
    success: bool
    unsupported: bool = False
    pttl_ms: int = -2
    remaining_seconds: float = 0.0
    error: Exception | None = None


@dataclass(frozen=True)
class SharedAliasSnapshot:
    alias: str
    cooldown_state: GeminiCooldownState | None
    cooldown_pttl_ms: int
    model_unsupported: bool
    model_pttl_ms: int


@dataclass(frozen=True)
class SharedPoolSnapshot:
    success: bool
    aliases: tuple[SharedAliasSnapshot, ...] = ()
    error: Exception | None = None


def _redis_errors() -> tuple[type[BaseException], ...]:
    try:
        import redis.exceptions

        return (
            redis.exceptions.RedisError,
            ConnectionError,
            TimeoutError,
        )
    except ImportError:
        return (ConnectionError, TimeoutError)


def _normalize_redis_raw(raw: Any) -> str | None:
    if raw is None:
        return None
    if isinstance(raw, bytes):
        return raw.decode("utf-8", errors="replace")
    return str(raw)


def parse_redis_cooldown_metadata(raw: Any) -> tuple[str, str | None]:
    """Extract reason/cooldown_type from Redis payload without raising."""
    normalized = _normalize_redis_raw(raw)
    if not normalized:
        return "cooldown", "soft"
    if normalized == LEGACY_COOLDOWN_PAYLOAD:
        return "cooldown", "soft"
    try:
        parsed = json.loads(normalized)
    except json.JSONDecodeError:
        return "cooldown", "soft"
    except (TypeError, ValueError):
        return "cooldown", "soft"
    if not isinstance(parsed, dict):
        return "cooldown", "soft"
    reason_raw = parsed.get("reason")
    if isinstance(reason_raw, str):
        reason = normalize_reason(reason_raw) or "cooldown"
    else:
        reason = "cooldown"
    cooldown_type = normalize_cooldown_type(
        parsed.get("cooldown_type") if isinstance(parsed.get("cooldown_type"), str) else None
    ) or normalize_cooldown_type(
        parsed.get("type") if isinstance(parsed.get("type"), str) else None
    )
    return reason, cooldown_type or "soft"


def _coerce_expires_at_ms(value: Any) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class GeminiCooldownState:
    remaining_seconds: float
    reason: str | None = None
    cooldown_type: str | None = None


@dataclass(frozen=True)
class GeminiKeyScope:
    alias: str
    fingerprint: str


def key_fingerprint(secret: str) -> str:
    digest = hashlib.sha256(str(secret or "").encode("utf-8")).hexdigest()
    return digest[:16]


def resolve_shared_state_namespace(
    *,
    app_env: str | None = None,
    service_name: str | None = None,
    explicit_namespace: str | None = None,
) -> str:
    explicit = str(explicit_namespace or "").strip()
    if explicit:
        return _sanitize_namespace(explicit)
    env = str(app_env or "local").strip().lower() or "local"
    service = str(service_name or DEFAULT_SHARED_SERVICE_NAME).strip().lower()
    service = service or DEFAULT_SHARED_SERVICE_NAME
    return _sanitize_namespace(f"{env}:{service}")


def _sanitize_namespace(namespace: str) -> str:
    cleaned = str(namespace or "").strip().lower()
    if not cleaned:
        return DEFAULT_SHARED_STATE_NAMESPACE
    safe = re.sub(r"[^a-z0-9:._-]+", "-", cleaned).strip("-")
    safe = safe or "namespace"
    if safe == cleaned and len(safe) <= _NAMESPACE_PREFIX_LIMIT:
        return safe
    prefix = safe[:_NAMESPACE_PREFIX_LIMIT].rstrip("-:._") or "namespace"
    digest = hashlib.sha256(cleaned.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}:{digest}"


def normalize_model_name(model: str | None) -> str:
    raw = str(model or "").strip().lower()
    if not raw:
        return ""
    if raw.startswith("models/"):
        raw = raw[len("models/") :]
    if ":" in raw:
        raw = raw.split(":", 1)[0]
    return raw.strip()


def safe_model_key_component(model: str) -> str:
    normalized = normalize_model_name(model)
    if not normalized:
        return ""
    readable = re.sub(r"[^a-z0-9._-]+", "-", normalized.lower())
    prefix = readable[:32].strip("-") or "model"
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}:{digest}"


def _is_tombstone_payload(raw: Any) -> bool:
    normalized = _normalize_redis_raw(raw)
    if not normalized or normalized == LEGACY_COOLDOWN_PAYLOAD:
        return False
    try:
        parsed = json.loads(normalized)
    except (json.JSONDecodeError, TypeError, ValueError):
        return False
    return isinstance(parsed, dict) and parsed.get("cleared") is True


def encode_cooldown_payload(metadata: CooldownMetadata) -> str:
    return json.dumps(
        {
            "version": COOLDOWN_PAYLOAD_VERSION,
            "expires_at_ms": int(metadata.expires_at_ms),
            "reason": normalize_reason(metadata.reason),
            "cooldown_type": normalize_cooldown_type(metadata.cooldown_type),
        },
        separators=(",", ":"),
    )


def decode_cooldown_payload(
    raw: Any,
    *,
    now_ms: int,
    pttl_ms: int | None = None,
) -> CooldownMetadata | None:
    normalized = _normalize_redis_raw(raw)
    if not normalized:
        return None
    if normalized == LEGACY_COOLDOWN_PAYLOAD:
        if pttl_ms is not None and int(pttl_ms) > 0:
            return CooldownMetadata(
                reason="cooldown",
                cooldown_type="soft",
                expires_at_ms=int(now_ms) + int(pttl_ms),
            )
        return None
    try:
        parsed = json.loads(normalized)
    except json.JSONDecodeError:
        return None
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    expires_at_ms = _coerce_expires_at_ms(parsed.get("expires_at_ms"))
    reason = normalize_reason(parsed.get("reason")) or "cooldown"
    cooldown_type = normalize_cooldown_type(
        parsed.get("cooldown_type") or parsed.get("type")
    )
    if pttl_ms is not None and int(pttl_ms) > 0:
        resolved_expires = int(now_ms) + int(pttl_ms)
    elif expires_at_ms is not None and expires_at_ms <= int(now_ms):
        return None
    elif expires_at_ms is not None:
        resolved_expires = expires_at_ms
    else:
        return None
    return CooldownMetadata(
        reason=reason,
        cooldown_type=cooldown_type or "soft",
        expires_at_ms=resolved_expires,
    )


def store_supports_cooldown_metadata(store: Any | None) -> bool:
    if store is None:
        return False
    if hasattr(store, "supports_cooldown_metadata"):
        return bool(getattr(store, "supports_cooldown_metadata"))
    apply_cooldown = getattr(store, "apply_cooldown", None)
    if apply_cooldown is None:
        return False
    try:
        signature = inspect.signature(apply_cooldown)
    except (TypeError, ValueError):
        return False
    return "reason" in signature.parameters


class GeminiKeyCooldownStore(Protocol):
    supports_cooldown_metadata: bool

    def cooldown_remaining(
        self, scope: GeminiKeyScope, *, now: float, now_ms: int | None = None
    ) -> float: ...

    def apply_cooldown(
        self,
        scope: GeminiKeyScope,
        *,
        seconds: float,
        reason: str | None = None,
        cooldown_type: str | None = None,
        now_ms: int | None = None,
    ) -> None: ...

    def get_cooldown_state(
        self, scope: GeminiKeyScope, *, now: float, now_ms: int | None = None
    ) -> GeminiCooldownState | None: ...

    def clear_cooldown(self, scope: GeminiKeyScope) -> bool: ...

    def mark_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> None: ...

    def is_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> bool: ...

    def clear_model_unsupported(self, scope: GeminiKeyScope, model: str) -> bool: ...

    def read_shared_cooldown(
        self, scope: GeminiKeyScope, *, now: float, now_ms: int | None = None
    ) -> SharedCooldownReadResult: ...

    def read_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> SharedModelUnsupportedReadResult: ...

    def read_pool_snapshot(
        self,
        scopes: tuple[GeminiKeyScope, ...],
        model: str,
        *,
        now_ms: int | None = None,
        clear_cooldown_aliases: frozenset[str] = frozenset(),
        clear_model_aliases: frozenset[str] = frozenset(),
    ) -> SharedPoolSnapshot: ...


class LegacyGeminiCooldownStoreAdapter:
    """Adapter for duration-only stores without metadata support."""

    supports_cooldown_metadata = False

    def __init__(self, legacy_store: Any) -> None:
        self._legacy = legacy_store

    def cooldown_remaining(
        self, scope: GeminiKeyScope, *, now: float, now_ms: int | None = None
    ) -> float:
        del now_ms
        return float(self._legacy.cooldown_remaining(scope.alias, now=now))

    def apply_cooldown(
        self,
        scope: GeminiKeyScope,
        *,
        seconds: float,
        reason: str | None = None,
        cooldown_type: str | None = None,
        now_ms: int | None = None,
    ) -> None:
        del reason, cooldown_type, now_ms
        self._legacy.apply_cooldown(scope.alias, seconds=seconds)

    def get_cooldown_state(
        self, scope: GeminiKeyScope, *, now: float, now_ms: int | None = None
    ) -> GeminiCooldownState | None:
        remaining = self.cooldown_remaining(scope, now=now, now_ms=now_ms)
        if remaining <= 0:
            return None
        return GeminiCooldownState(
            remaining_seconds=remaining,
            reason="cooldown",
            cooldown_type="soft",
        )

    def clear_cooldown(self, scope: GeminiKeyScope) -> bool:
        if hasattr(self._legacy, "clear_cooldown"):
            self._legacy.clear_cooldown(scope.alias)
        return True

    def mark_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> None:
        del scope, model, now_ms

    def is_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> bool:
        del scope, model, now_ms
        return False

    def clear_model_unsupported(self, scope: GeminiKeyScope, model: str) -> bool:
        del scope, model
        return True

    def read_shared_cooldown(
        self, scope: GeminiKeyScope, *, now: float, now_ms: int | None = None
    ) -> SharedCooldownReadResult:
        state = self.get_cooldown_state(scope, now=now, now_ms=now_ms)
        return SharedCooldownReadResult(success=True, state=state)

    def read_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> SharedModelUnsupportedReadResult:
        del now_ms
        return SharedModelUnsupportedReadResult(success=True, unsupported=False)

    def read_pool_snapshot(
        self,
        scopes: tuple[GeminiKeyScope, ...],
        model: str,
        *,
        now_ms: int | None = None,
        clear_cooldown_aliases: frozenset[str] = frozenset(),
        clear_model_aliases: frozenset[str] = frozenset(),
    ) -> SharedPoolSnapshot:
        del model, now_ms, clear_model_aliases
        aliases: list[SharedAliasSnapshot] = []
        for scope in scopes:
            if scope.alias in clear_cooldown_aliases:
                self.clear_cooldown(scope)
            state = self.get_cooldown_state(scope, now=0.0)
            aliases.append(
                SharedAliasSnapshot(
                    alias=scope.alias,
                    cooldown_state=state,
                    cooldown_pttl_ms=(
                        max(1, int(state.remaining_seconds * 1000))
                        if state is not None
                        else -2
                    ),
                    model_unsupported=False,
                    model_pttl_ms=-2,
                )
            )
        return SharedPoolSnapshot(success=True, aliases=tuple(aliases))


class InMemoryGeminiKeyCooldownStore:
    supports_cooldown_metadata = True

    def __init__(
        self,
        *,
        wall_clock_ms: Callable[[], int] | None = None,
        namespace: str = DEFAULT_SHARED_STATE_NAMESPACE,
        model_unsupported_ttl_seconds: int = DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS,
    ) -> None:
        self._wall_clock_ms = wall_clock_ms or (lambda: int(time.time() * 1000))
        self.namespace = _sanitize_namespace(namespace)
        self.model_unsupported_ttl_seconds = max(
            1, int(model_unsupported_ttl_seconds or DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS)
        )
        self._lock = threading.RLock()
        self._cooldown_by_scope: dict[str, CooldownMetadata] = {}
        self._unsupported_until_ms: dict[str, int] = {}

    def _scope_key(self, scope: GeminiKeyScope) -> str:
        return f"{self.namespace}:{scope.alias}:{scope.fingerprint}"

    def _model_key(self, scope: GeminiKeyScope, model: str) -> str:
        model_component = safe_model_key_component(model)
        return f"{self.namespace}:model:{scope.alias}:{scope.fingerprint}:{model_component}"

    def _now_ms(self, now_ms: int | None) -> int:
        return int(now_ms if now_ms is not None else self._wall_clock_ms())

    def cooldown_remaining(
        self, scope: GeminiKeyScope, *, now: float, now_ms: int | None = None
    ) -> float:
        del now
        state = self.get_cooldown_state(scope, now=0.0, now_ms=now_ms)
        if state is None:
            return 0.0
        return max(0.0, float(state.remaining_seconds))

    def get_cooldown_state(
        self, scope: GeminiKeyScope, *, now: float, now_ms: int | None = None
    ) -> GeminiCooldownState | None:
        del now
        current_ms = self._now_ms(now_ms)
        with self._lock:
            metadata = self._cooldown_by_scope.get(self._scope_key(scope))
            if metadata is None:
                return None
            remaining_ms = int(metadata.expires_at_ms) - current_ms
            if remaining_ms <= 0:
                self._cooldown_by_scope.pop(self._scope_key(scope), None)
                return None
            return GeminiCooldownState(
                remaining_seconds=remaining_ms / 1000.0,
                reason=metadata.reason,
                cooldown_type=metadata.cooldown_type,
            )

    def apply_cooldown(
        self,
        scope: GeminiKeyScope,
        *,
        seconds: float,
        reason: str | None = None,
        cooldown_type: str | None = None,
        now_ms: int | None = None,
    ) -> None:
        current_ms = self._now_ms(now_ms)
        incoming = CooldownMetadata(
            reason=normalize_reason(reason),
            cooldown_type=normalize_cooldown_type(cooldown_type),
            expires_at_ms=current_ms + int(ceil(max(0.0, float(seconds or 0.0)) * 1000)),
        )
        scope_key = self._scope_key(scope)
        with self._lock:
            existing = self._cooldown_by_scope.get(scope_key)
            merged = merge_cooldown_states(existing, incoming, now_ms=current_ms)
            self._cooldown_by_scope[scope_key] = merged
            logger.debug(
                "GEMINI_COOLDOWN_STATE_MERGED namespace={} alias={} fingerprint={} reason={} cooldownType={} remainingMs={}",
                self.namespace,
                scope.alias,
                scope.fingerprint,
                merged.reason,
                merged.cooldown_type,
                max(0, merged.expires_at_ms - current_ms),
            )

    def clear_cooldown(self, scope: GeminiKeyScope) -> bool:
        with self._lock:
            self._cooldown_by_scope.pop(self._scope_key(scope), None)
        return True

    def mark_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> None:
        model_name = normalize_model_name(model)
        if not model_name:
            return
        current_ms = self._now_ms(now_ms)
        expires_at_ms = current_ms + self.model_unsupported_ttl_seconds * 1000
        with self._lock:
            self._unsupported_until_ms[self._model_key(scope, model_name)] = (
                expires_at_ms
            )
        logger.info(
            "GEMINI_MODEL_UNSUPPORTED_MARKED namespace={} alias={} fingerprint={} modelKey={} ttlSeconds={}",
            self.namespace,
            scope.alias,
            scope.fingerprint,
            safe_model_key_component(model_name),
            self.model_unsupported_ttl_seconds,
        )

    def is_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> bool:
        model_name = normalize_model_name(model)
        if not model_name:
            return False
        current_ms = self._now_ms(now_ms)
        key = self._model_key(scope, model_name)
        with self._lock:
            expires_at_ms = int(self._unsupported_until_ms.get(key) or 0)
            if expires_at_ms <= current_ms:
                if key in self._unsupported_until_ms:
                    self._unsupported_until_ms.pop(key, None)
                    logger.debug(
                        "GEMINI_MODEL_UNSUPPORTED_EXPIRED namespace={} alias={} fingerprint={} modelKey={}",
                        self.namespace,
                        scope.alias,
                        scope.fingerprint,
                        safe_model_key_component(model_name),
                    )
                return False
            return True

    def clear_model_unsupported(self, scope: GeminiKeyScope, model: str) -> bool:
        model_name = normalize_model_name(model)
        if not model_name:
            return True
        with self._lock:
            self._unsupported_until_ms.pop(self._model_key(scope, model_name), None)
        return True

    def read_shared_cooldown(
        self, scope: GeminiKeyScope, *, now: float, now_ms: int | None = None
    ) -> SharedCooldownReadResult:
        state = self.get_cooldown_state(scope, now=now, now_ms=now_ms)
        return SharedCooldownReadResult(success=True, state=state)

    def read_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> SharedModelUnsupportedReadResult:
        model_name = normalize_model_name(model)
        if not model_name:
            return SharedModelUnsupportedReadResult(success=True)
        current_ms = self._now_ms(now_ms)
        key = self._model_key(scope, model_name)
        with self._lock:
            expires_at_ms = int(self._unsupported_until_ms.get(key) or 0)
            remaining_ms = expires_at_ms - current_ms
            if remaining_ms <= 0:
                self._unsupported_until_ms.pop(key, None)
                return SharedModelUnsupportedReadResult(success=True, pttl_ms=-2)
            return SharedModelUnsupportedReadResult(
                success=True,
                unsupported=True,
                pttl_ms=remaining_ms,
                remaining_seconds=remaining_ms / 1000.0,
            )

    def read_pool_snapshot(
        self,
        scopes: tuple[GeminiKeyScope, ...],
        model: str,
        *,
        now_ms: int | None = None,
        clear_cooldown_aliases: frozenset[str] = frozenset(),
        clear_model_aliases: frozenset[str] = frozenset(),
    ) -> SharedPoolSnapshot:
        current_ms = self._now_ms(now_ms)
        model_name = normalize_model_name(model)
        snapshots: list[SharedAliasSnapshot] = []
        with self._lock:
            for scope in scopes:
                if scope.alias in clear_cooldown_aliases:
                    self._cooldown_by_scope.pop(self._scope_key(scope), None)
                if model_name and scope.alias in clear_model_aliases:
                    self._unsupported_until_ms.pop(
                        self._model_key(scope, model_name), None
                    )

                cooldown = self._cooldown_by_scope.get(self._scope_key(scope))
                cooldown_pttl = -2
                cooldown_state = None
                if cooldown is not None:
                    cooldown_pttl = int(cooldown.expires_at_ms) - current_ms
                    if cooldown_pttl > 0:
                        cooldown_state = GeminiCooldownState(
                            remaining_seconds=cooldown_pttl / 1000.0,
                            reason=cooldown.reason,
                            cooldown_type=cooldown.cooldown_type,
                        )
                    else:
                        self._cooldown_by_scope.pop(self._scope_key(scope), None)
                        cooldown_pttl = -2

                model_pttl = -2
                model_unsupported = False
                if model_name:
                    model_key = self._model_key(scope, model_name)
                    expires_at_ms = int(self._unsupported_until_ms.get(model_key) or 0)
                    model_pttl = expires_at_ms - current_ms
                    if model_pttl > 0:
                        model_unsupported = True
                    else:
                        self._unsupported_until_ms.pop(model_key, None)
                        model_pttl = -2

                snapshots.append(
                    SharedAliasSnapshot(
                        alias=scope.alias,
                        cooldown_state=cooldown_state,
                        cooldown_pttl_ms=cooldown_pttl,
                        model_unsupported=model_unsupported,
                        model_pttl_ms=model_pttl,
                    )
                )
        return SharedPoolSnapshot(success=True, aliases=tuple(snapshots))


REDIS_POOL_SNAPSHOT_SCRIPT = """
local tombstone_ttl_ms = tonumber(ARGV[1])
local alias_count = #KEYS / 2
local result = {}

local function next_revision(raw)
  if not raw or raw == "1" then
    return 1
  end
  local ok, parsed = pcall(cjson.decode, raw)
  if not ok or type(parsed) ~= "table" then
    return 1
  end
  return (tonumber(parsed.revision) or 0) + 1
end

local function clear_with_tombstone(key)
  local revision = next_revision(redis.call("GET", key))
  local payload = cjson.encode({version=2, cleared=true, revision=revision})
  redis.call("PSETEX", key, tombstone_ttl_ms, payload)
end

for index = 1, alias_count do
  local cooldown_key = KEYS[(index - 1) * 2 + 1]
  local model_key = KEYS[(index - 1) * 2 + 2]
  if ARGV[1 + index] == "1" then
    clear_with_tombstone(cooldown_key)
  end
  if ARGV[1 + alias_count + index] == "1" then
    clear_with_tombstone(model_key)
  end

  local cooldown_raw = redis.call("GET", cooldown_key)
  local cooldown_pttl = redis.call("PTTL", cooldown_key)
  local model_raw = redis.call("GET", model_key)
  local model_pttl = redis.call("PTTL", model_key)
  table.insert(result, cooldown_raw or "")
  table.insert(result, cooldown_pttl)
  table.insert(result, model_raw or "")
  table.insert(result, model_pttl)
end
return result
"""

REDIS_TOMBSTONE_SCRIPT = """
local raw = redis.call("GET", KEYS[1])
local revision = 1
if raw and raw ~= "1" then
  local ok, parsed = pcall(cjson.decode, raw)
  if ok and type(parsed) == "table" then
    revision = (tonumber(parsed.revision) or 0) + 1
  end
end
local payload = cjson.encode({version=2, cleared=true, revision=revision})
redis.call("PSETEX", KEYS[1], tonumber(ARGV[1]), payload)
return payload
"""

REDIS_MARK_MODEL_SCRIPT = """
local raw = redis.call("GET", KEYS[1])
local revision = 1
if raw and raw ~= "1" then
  local ok, parsed = pcall(cjson.decode, raw)
  if ok and type(parsed) == "table" then
    revision = (tonumber(parsed.revision) or 0) + 1
  end
end
local payload = cjson.encode({version=2, active=true, revision=revision})
redis.call("PSETEX", KEYS[1], tonumber(ARGV[1]), payload)
return payload
"""

REDIS_MERGE_COOLDOWN_SCRIPT = build_redis_merge_lua_script()


class RedisGeminiKeyCooldownStore:
    supports_cooldown_metadata = True

    def __init__(
        self,
        redis_client,
        *,
        namespace: str = DEFAULT_SHARED_STATE_NAMESPACE,
        model_unsupported_ttl_seconds: int = DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS,
        tombstone_ttl_seconds: int = DEFAULT_TOMBSTONE_TTL_SECONDS,
        wall_clock_ms: Callable[[], int] | None = None,
    ) -> None:
        self._redis = redis_client
        self.namespace = _sanitize_namespace(namespace)
        self.model_unsupported_ttl_seconds = max(
            1, int(model_unsupported_ttl_seconds or DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS)
        )
        self._wall_clock_ms = wall_clock_ms or (lambda: int(time.time() * 1000))
        self.tombstone_ttl_seconds = max(1, int(tombstone_ttl_seconds))
        self._merge_script = self._register_script(REDIS_MERGE_COOLDOWN_SCRIPT)
        self._pool_snapshot_script = self._register_script(
            REDIS_POOL_SNAPSHOT_SCRIPT
        )
        self._tombstone_script = self._register_script(REDIS_TOMBSTONE_SCRIPT)
        self._mark_model_script = self._register_script(REDIS_MARK_MODEL_SCRIPT)
        logger.info(
            "GEMINI_KEY_STATE_NAMESPACE namespace={} modelUnsupportedTtlSeconds={}",
            self.namespace,
            self.model_unsupported_ttl_seconds,
        )

    def _register_script(self, script: str):
        if hasattr(self._redis, "register_script"):
            return self._redis.register_script(script)
        return None

    def _cooldown_key(self, scope: GeminiKeyScope) -> str:
        return (
            f"gemini:{self.namespace}:cooldown:"
            f"{scope.alias}:{scope.fingerprint}"
        )

    def _model_key(self, scope: GeminiKeyScope, model: str) -> str:
        model_component = safe_model_key_component(model)
        return (
            f"gemini:{self.namespace}:model-unsupported:"
            f"{scope.alias}:{scope.fingerprint}:{model_component}"
        )

    def _now_ms(self, now_ms: int | None) -> int:
        return int(now_ms if now_ms is not None else self._wall_clock_ms())

    def _safe_redis(self, operation: str, fn: Callable[[], Any]) -> SafeRedisResult:
        del operation
        try:
            return SafeRedisResult(success=True, value=fn())
        except _redis_errors() as exc:
            return SafeRedisResult(success=False, error=exc)

    def _log_redis_failure(
        self,
        operation: str,
        exc: Exception | None,
        *,
        alias: str | None = None,
        fingerprint: str | None = None,
        model: str | None = None,
    ) -> None:
        if exc is None:
            return
        model_key = safe_model_key_component(model) if model else ""
        logger.warning(
            "GEMINI_SHARED_STATE_{}_FAILED operation={} errorType={} alias={} fingerprint={} namespace={} modelKey={}",
            operation.upper(),
            operation,
            type(exc).__name__,
            alias or "",
            fingerprint or "",
            self.namespace,
            model_key,
        )

    def _cooldown_state_from_snapshot(
        self, snapshot: RedisCooldownSnapshot
    ) -> GeminiCooldownState | None:
        pttl = int(snapshot.pttl_ms)
        if pttl <= 0:
            return None
        raw = _normalize_redis_raw(snapshot.raw)
        if not raw or _is_tombstone_payload(raw):
            return None
        reason, cooldown_type = parse_redis_cooldown_metadata(raw)
        return GeminiCooldownState(
            remaining_seconds=pttl / 1000.0,
            reason=reason,
            cooldown_type=cooldown_type,
        )

    @staticmethod
    def _model_marker_from_snapshot(raw: Any, pttl_ms: int) -> bool:
        if int(pttl_ms) <= 0:
            return False
        normalized = _normalize_redis_raw(raw)
        if not normalized or _is_tombstone_payload(normalized):
            return False
        if normalized == LEGACY_COOLDOWN_PAYLOAD:
            return True
        try:
            parsed = json.loads(normalized)
        except (json.JSONDecodeError, TypeError, ValueError):
            return True
        if not isinstance(parsed, dict):
            return True
        return parsed.get("active") is not False and parsed.get("cleared") is not True

    def _execute_pool_snapshot(
        self,
        scopes: tuple[GeminiKeyScope, ...],
        model_name: str,
        *,
        clear_cooldown_aliases: frozenset[str],
        clear_model_aliases: frozenset[str],
    ) -> tuple[SharedAliasSnapshot, ...]:
        keys: list[str] = []
        for scope in scopes:
            keys.extend(
                [
                    self._cooldown_key(scope),
                    self._model_key(scope, model_name or "__none__"),
                ]
            )
        args: list[Any] = [self.tombstone_ttl_seconds * 1000]
        args.extend(
            "1" if scope.alias in clear_cooldown_aliases else "0"
            for scope in scopes
        )
        args.extend(
            "1" if model_name and scope.alias in clear_model_aliases else "0"
            for scope in scopes
        )
        if self._pool_snapshot_script is not None:
            raw_result = self._pool_snapshot_script(keys=keys, args=args)
        else:
            raw_result = self._redis.eval(
                REDIS_POOL_SNAPSHOT_SCRIPT, len(keys), *keys, *args
            )
        values = list(raw_result or [])
        snapshots: list[SharedAliasSnapshot] = []
        for index, scope in enumerate(scopes):
            offset = index * 4
            cooldown_raw = values[offset] if len(values) > offset else ""
            cooldown_pttl = (
                int(values[offset + 1]) if len(values) > offset + 1 else -2
            )
            model_raw = values[offset + 2] if len(values) > offset + 2 else ""
            model_pttl = (
                int(values[offset + 3]) if len(values) > offset + 3 else -2
            )
            cooldown_state = self._cooldown_state_from_snapshot(
                RedisCooldownSnapshot(
                    raw=_normalize_redis_raw(cooldown_raw),
                    pttl_ms=cooldown_pttl,
                )
            )
            model_unsupported = bool(
                model_name
                and self._model_marker_from_snapshot(model_raw, model_pttl)
            )
            snapshots.append(
                SharedAliasSnapshot(
                    alias=scope.alias,
                    cooldown_state=cooldown_state,
                    cooldown_pttl_ms=cooldown_pttl,
                    model_unsupported=model_unsupported,
                    model_pttl_ms=model_pttl,
                )
            )
        return tuple(snapshots)

    def read_pool_snapshot(
        self,
        scopes: tuple[GeminiKeyScope, ...],
        model: str,
        *,
        now_ms: int | None = None,
        clear_cooldown_aliases: frozenset[str] = frozenset(),
        clear_model_aliases: frozenset[str] = frozenset(),
    ) -> SharedPoolSnapshot:
        del now_ms
        if not scopes:
            return SharedPoolSnapshot(success=True)
        model_name = normalize_model_name(model)
        result = self._safe_redis(
            "pool_snapshot",
            lambda: self._execute_pool_snapshot(
                scopes,
                model_name,
                clear_cooldown_aliases=clear_cooldown_aliases,
                clear_model_aliases=clear_model_aliases,
            ),
        )
        if not result.success:
            self._log_redis_failure("read", result.error)
            return SharedPoolSnapshot(success=False, error=result.error)
        return SharedPoolSnapshot(success=True, aliases=tuple(result.value or ()))

    def read_shared_cooldown(
        self, scope: GeminiKeyScope, *, now: float, now_ms: int | None = None
    ) -> SharedCooldownReadResult:
        del now
        result = self.read_pool_snapshot((scope,), "", now_ms=now_ms)
        if not result.success:
            return SharedCooldownReadResult(success=False, error=result.error)
        state = result.aliases[0].cooldown_state if result.aliases else None
        return SharedCooldownReadResult(success=True, state=state)

    def read_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> SharedModelUnsupportedReadResult:
        model_name = normalize_model_name(model)
        if not model_name:
            return SharedModelUnsupportedReadResult(success=True, unsupported=False)
        result = self.read_pool_snapshot((scope,), model_name, now_ms=now_ms)
        if not result.success or not result.aliases:
            return SharedModelUnsupportedReadResult(
                success=False, error=result.error
            )
        snapshot = result.aliases[0]
        return SharedModelUnsupportedReadResult(
            success=True,
            unsupported=snapshot.model_unsupported,
            pttl_ms=snapshot.model_pttl_ms,
            remaining_seconds=(
                snapshot.model_pttl_ms / 1000.0
                if snapshot.model_unsupported and snapshot.model_pttl_ms > 0
                else 0.0
            ),
        )

    def cooldown_remaining(
        self, scope: GeminiKeyScope, *, now: float, now_ms: int | None = None
    ) -> float:
        del now
        read_result = self.read_shared_cooldown(scope, now=0.0, now_ms=now_ms)
        if not read_result.success or read_result.state is None:
            return 0.0
        return max(0.0, float(read_result.state.remaining_seconds))

    def get_cooldown_state(
        self, scope: GeminiKeyScope, *, now: float, now_ms: int | None = None
    ) -> GeminiCooldownState | None:
        read_result = self.read_shared_cooldown(scope, now=now, now_ms=now_ms)
        if not read_result.success:
            return None
        return read_result.state

    def apply_cooldown(
        self,
        scope: GeminiKeyScope,
        *,
        seconds: float,
        reason: str | None = None,
        cooldown_type: str | None = None,
        now_ms: int | None = None,
    ) -> None:
        current_ms = self._now_ms(now_ms)
        ttl_ms = max(1, int(ceil(max(0.0, float(seconds or 0.0)) * 1000)))
        incoming = CooldownMetadata(
            reason=normalize_reason(reason),
            cooldown_type=normalize_cooldown_type(cooldown_type),
            expires_at_ms=current_ms + ttl_ms,
        )
        payload = encode_cooldown_payload(incoming)
        key = self._cooldown_key(scope)

        def _write() -> tuple[str, int]:
            if self._merge_script is not None:
                merged_result = self._merge_script(
                    keys=[key],
                    args=[payload, ttl_ms, current_ms],
                )
            else:
                merged_result = self._redis.eval(
                    REDIS_MERGE_COOLDOWN_SCRIPT,
                    1,
                    key,
                    payload,
                    ttl_ms,
                    current_ms,
                )
            if isinstance(merged_result, (list, tuple)):
                merged_raw = _normalize_redis_raw(merged_result[0]) or payload
                merged_ttl_ms = (
                    int(merged_result[1]) if len(merged_result) > 1 else ttl_ms
                )
            else:
                merged_raw = _normalize_redis_raw(merged_result) or payload
                merged_ttl_ms = ttl_ms
            return merged_raw, merged_ttl_ms

        write_result = self._safe_redis("write", _write)
        if write_result.success:
            merged_raw, merged_ttl_ms = write_result.value
            merged = decode_cooldown_payload(
                merged_raw,
                now_ms=current_ms,
                pttl_ms=max(1, int(merged_ttl_ms)),
            )
            logger.debug(
                "GEMINI_COOLDOWN_STATE_MERGED namespace={} alias={} fingerprint={} reason={} cooldownType={} remainingMs={}",
                self.namespace,
                scope.alias,
                scope.fingerprint,
                merged.reason if merged else "cooldown",
                merged.cooldown_type if merged else "soft",
                max(1, int(merged_ttl_ms)),
            )
        if not write_result.success:
            self._log_redis_failure(
                "write",
                write_result.error,
                alias=scope.alias,
                fingerprint=scope.fingerprint,
            )

    def _write_tombstone(self, key: str) -> SafeRedisResult:
        ttl_ms = self.tombstone_ttl_seconds * 1000

        def _write() -> Any:
            if self._tombstone_script is not None:
                return self._tombstone_script(keys=[key], args=[ttl_ms])
            return self._redis.eval(REDIS_TOMBSTONE_SCRIPT, 1, key, ttl_ms)

        return self._safe_redis("clear", _write)

    def clear_cooldown(self, scope: GeminiKeyScope) -> bool:
        result = self._write_tombstone(self._cooldown_key(scope))
        if not result.success:
            self._log_redis_failure(
                "clear",
                result.error,
                alias=scope.alias,
                fingerprint=scope.fingerprint,
            )
        return result.success

    def mark_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> None:
        del now_ms
        model_name = normalize_model_name(model)
        if not model_name:
            return
        key = self._model_key(scope, model_name)

        ttl_ms = self.model_unsupported_ttl_seconds * 1000

        def _mark() -> Any:
            if self._mark_model_script is not None:
                return self._mark_model_script(keys=[key], args=[ttl_ms])
            return self._redis.eval(REDIS_MARK_MODEL_SCRIPT, 1, key, ttl_ms)

        mark_result = self._safe_redis("write", _mark)
        if not mark_result.success:
            self._log_redis_failure(
                "write",
                mark_result.error,
                alias=scope.alias,
                fingerprint=scope.fingerprint,
                model=model_name,
            )
            return
        logger.info(
            "GEMINI_MODEL_UNSUPPORTED_MARKED namespace={} alias={} fingerprint={} modelKey={} ttlSeconds={}",
            self.namespace,
            scope.alias,
            scope.fingerprint,
            safe_model_key_component(model_name),
            self.model_unsupported_ttl_seconds,
        )

    def is_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> bool:
        read_result = self.read_model_unsupported(scope, model, now_ms=now_ms)
        if not read_result.success:
            return False
        return read_result.unsupported

    def clear_model_unsupported(self, scope: GeminiKeyScope, model: str) -> bool:
        model_name = normalize_model_name(model)
        if not model_name:
            return True
        result = self._write_tombstone(self._model_key(scope, model_name))
        if not result.success:
            self._log_redis_failure(
                "clear",
                result.error,
                alias=scope.alias,
                fingerprint=scope.fingerprint,
                model=model_name,
            )
        return result.success


def create_gemini_redis_client(redis_url: str, *, settings: Any | None = None):
    import redis

    if settings is None:
        from app.config import get_settings

        settings = get_settings()
    connect_timeout = max(
        0.1,
        float(getattr(settings, "gemini_redis_connect_timeout_seconds", 1.0) or 1.0),
    )
    socket_timeout = max(
        0.1,
        float(getattr(settings, "gemini_redis_socket_timeout_seconds", 1.5) or 1.5),
    )
    return redis.Redis.from_url(
        redis_url,
        decode_responses=True,
        socket_connect_timeout=connect_timeout,
        socket_timeout=socket_timeout,
        retry_on_timeout=False,
    )


def build_redis_gemini_cooldown_store(
    redis_client,
    *,
    settings: Any | None = None,
) -> RedisGeminiKeyCooldownStore:
    if settings is None:
        from app.config import get_settings

        settings = get_settings()
    namespace = resolve_shared_state_namespace(
        app_env=getattr(settings, "app_env", None)
        or getattr(settings, "environment", None),
        service_name=DEFAULT_SHARED_SERVICE_NAME,
        explicit_namespace=getattr(settings, "gemini_shared_state_namespace", None),
    )
    ttl_seconds = int(
        getattr(
            settings,
            "gemini_model_unsupported_ttl_seconds",
            DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS,
        )
        or DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS
    )
    return RedisGeminiKeyCooldownStore(
        redis_client,
        namespace=namespace,
        model_unsupported_ttl_seconds=ttl_seconds,
    )
