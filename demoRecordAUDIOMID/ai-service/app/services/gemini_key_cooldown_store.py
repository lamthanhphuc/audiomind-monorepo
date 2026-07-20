from __future__ import annotations

import hashlib
import inspect
import json
import threading
import time
from dataclasses import dataclass
from math import ceil
from typing import Any, Callable, Protocol

from loguru import logger

from app.services.gemini_cooldown_merge import (
    COOLDOWN_PAYLOAD_VERSION,
    CooldownMetadata,
    merge_cooldown_states,
    normalize_cooldown_type,
    normalize_reason,
)

DEFAULT_SHARED_STATE_NAMESPACE = "local:ai-service"
DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS = 21600


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
        return explicit
    env = str(app_env or "local").strip().lower() or "local"
    service = str(service_name or "ai-service").strip().lower() or "ai-service"
    return f"{env}:{service}"


def normalize_model_name(model: str | None) -> str:
    raw = str(model or "").strip().lower()
    if not raw:
        return ""
    if raw.startswith("models/"):
        raw = raw[len("models/") :]
    if ":" in raw:
        raw = raw.split(":", 1)[0]
    return raw.strip()


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
    raw: str | None, *, now_ms: int
) -> CooldownMetadata | None:
    if not raw:
        return None
    if raw == "1":
        return CooldownMetadata(reason="cooldown", cooldown_type="soft", expires_at_ms=0)
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    expires_at_ms = int(parsed.get("expires_at_ms") or 0)
    if expires_at_ms and expires_at_ms <= int(now_ms):
        return None
    return CooldownMetadata(
        reason=normalize_reason(parsed.get("reason")),
        cooldown_type=normalize_cooldown_type(
            parsed.get("cooldown_type") or parsed.get("type")
        ),
        expires_at_ms=expires_at_ms,
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

    def clear_cooldown(self, scope: GeminiKeyScope) -> None: ...

    def mark_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> None: ...

    def is_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> bool: ...

    def clear_model_unsupported(self, scope: GeminiKeyScope, model: str) -> None: ...


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

    def clear_cooldown(self, scope: GeminiKeyScope) -> None:
        if hasattr(self._legacy, "clear_cooldown"):
            self._legacy.clear_cooldown(scope.alias)

    def mark_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> None:
        del scope, model, now_ms

    def is_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> bool:
        del scope, model, now_ms
        return False

    def clear_model_unsupported(self, scope: GeminiKeyScope, model: str) -> None:
        del scope, model


class InMemoryGeminiKeyCooldownStore:
    supports_cooldown_metadata = True

    def __init__(
        self,
        *,
        clock: Callable[[], float] | None = None,
        wall_clock_ms: Callable[[], int] | None = None,
        namespace: str = DEFAULT_SHARED_STATE_NAMESPACE,
        model_unsupported_ttl_seconds: int = DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS,
    ) -> None:
        self._clock = clock or time.monotonic
        if wall_clock_ms is not None:
            self._wall_clock_ms = wall_clock_ms
        elif clock is not None:
            self._wall_clock_ms = lambda: int(self._clock() * 1000)
        else:
            self._wall_clock_ms = lambda: int(time.time() * 1000)
        self.namespace = namespace
        self.model_unsupported_ttl_seconds = max(
            1, int(model_unsupported_ttl_seconds or DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS)
        )
        self._lock = threading.RLock()
        self._cooldown_by_scope: dict[str, CooldownMetadata] = {}
        self._unsupported_until_ms: dict[str, int] = {}

    def _scope_key(self, scope: GeminiKeyScope) -> str:
        return f"{self.namespace}:{scope.alias}:{scope.fingerprint}"

    def _model_key(self, scope: GeminiKeyScope, model: str) -> str:
        model_name = normalize_model_name(model)
        return f"{self.namespace}:model:{scope.alias}:{scope.fingerprint}:{model_name}"

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

    def clear_cooldown(self, scope: GeminiKeyScope) -> None:
        with self._lock:
            self._cooldown_by_scope.pop(self._scope_key(scope), None)

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
            "GEMINI_MODEL_UNSUPPORTED_MARKED namespace={} alias={} fingerprint={} model={} ttlSeconds={}",
            self.namespace,
            scope.alias,
            scope.fingerprint,
            model_name,
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
                        "GEMINI_MODEL_UNSUPPORTED_EXPIRED namespace={} alias={} fingerprint={} model={}",
                        self.namespace,
                        scope.alias,
                        scope.fingerprint,
                        model_name,
                    )
                return False
            return True

    def clear_model_unsupported(self, scope: GeminiKeyScope, model: str) -> None:
        model_name = normalize_model_name(model)
        if not model_name:
            return
        with self._lock:
            self._unsupported_until_ms.pop(self._model_key(scope, model_name), None)


REDIS_MERGE_COOLDOWN_SCRIPT = """
local key = KEYS[1]
local incoming_json = ARGV[1]
local incoming_ttl_ms = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])

local function decode_payload(raw)
  if not raw or raw == "1" then
    return {reason="cooldown", cooldown_type="soft", expires_at_ms=0}
  end
  local ok, parsed = pcall(cjson.decode, raw)
  if not ok or type(parsed) ~= "table" then
    return {reason="cooldown", cooldown_type="soft", expires_at_ms=0}
  end
  return {
    reason=parsed.reason,
    cooldown_type=parsed.cooldown_type or parsed.type,
    expires_at_ms=tonumber(parsed.expires_at_ms) or 0
  }
end

local tier_map = {
  billing_credits_depleted=3,
  free_tier_token_quota_exhausted=3,
  free_tier_quota_exhausted=3,
  model_unavailable=3,
  invalid_key=3,
  auth_error=3,
  region_blocked=3,
  invalid_request=3,
  hard_cooldown=3,
  terminal_unknown=3,
  rate_limit=2,
  transient_rate_limit=2,
  transient_network=2,
  network_error=2,
  timeout=2,
  server_error=2,
  transient_provider_error=2,
  soft_cooldown=2,
  cooldown=1
}
local type_rank = {hard=2, soft=1}

local function score(meta)
  local reason = meta.reason or "cooldown"
  local tier = tier_map[reason] or 1
  local tr = type_rank[meta.cooldown_type or "soft"] or 0
  return tier * 100 + tr * 10
end

local current_raw = redis.call("GET", key)
local current = decode_payload(current_raw)
local current_pttl = redis.call("PTTL", key)
if current_pttl and current_pttl > 0 then
  current.expires_at_ms = now_ms + current_pttl
end

local incoming = decode_payload(incoming_json)
incoming.expires_at_ms = now_ms + incoming_ttl_ms

local merged_expires = incoming.expires_at_ms
if current.expires_at_ms and current.expires_at_ms > now_ms then
  if current.expires_at_ms > merged_expires then
    merged_expires = current.expires_at_ms
  end
end

local winner = incoming
if current.expires_at_ms and current.expires_at_ms > now_ms then
  if score(current) > score(incoming) then
    winner = current
  elseif score(current) == score(incoming) then
    winner = incoming
    if incoming.reason == nil or incoming.reason == "" then
      winner.reason = current.reason
    end
    if (incoming.cooldown_type or "") ~= "hard" and (current.cooldown_type or "") == "hard" then
      winner.cooldown_type = "hard"
    end
  end
end

winner.expires_at_ms = merged_expires
local ttl_ms = merged_expires - now_ms
if ttl_ms < 1 then
  ttl_ms = incoming_ttl_ms
end
local payload = cjson.encode({
  version=2,
  expires_at_ms=winner.expires_at_ms,
  reason=winner.reason,
  cooldown_type=winner.cooldown_type
})
redis.call("PSETEX", key, ttl_ms, payload)
return payload
"""


class RedisGeminiKeyCooldownStore:
    supports_cooldown_metadata = True

    def __init__(
        self,
        redis_client,
        *,
        namespace: str = DEFAULT_SHARED_STATE_NAMESPACE,
        model_unsupported_ttl_seconds: int = DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS,
        wall_clock_ms: Callable[[], int] | None = None,
    ) -> None:
        self._redis = redis_client
        self.namespace = namespace
        self.model_unsupported_ttl_seconds = max(
            1, int(model_unsupported_ttl_seconds or DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS)
        )
        self._wall_clock_ms = wall_clock_ms or (lambda: int(time.time() * 1000))
        self._merge_script = self._register_merge_script()
        logger.info(
            "GEMINI_KEY_STATE_NAMESPACE namespace={} modelUnsupportedTtlSeconds={}",
            self.namespace,
            self.model_unsupported_ttl_seconds,
        )

    def _register_merge_script(self):
        if hasattr(self._redis, "register_script"):
            return self._redis.register_script(REDIS_MERGE_COOLDOWN_SCRIPT)
        return None

    def _cooldown_key(self, scope: GeminiKeyScope) -> str:
        return (
            f"gemini:{self.namespace}:cooldown:"
            f"{scope.alias}:{scope.fingerprint}"
        )

    def _model_key(self, scope: GeminiKeyScope, model: str) -> str:
        model_name = normalize_model_name(model)
        return (
            f"gemini:{self.namespace}:model-unsupported:"
            f"{scope.alias}:{scope.fingerprint}:{model_name}"
        )

    def _now_ms(self, now_ms: int | None) -> int:
        return int(now_ms if now_ms is not None else self._wall_clock_ms())

    def _safe_redis(self, operation: str, fn: Callable[[], Any]) -> Any:
        try:
            return fn()
        except Exception as exc:
            exc_name = type(exc).__name__
            module_name = type(exc).__module__ or ""
            if "redis" not in module_name and exc_name not in {
                "ConnectionError",
                "TimeoutError",
                "OSError",
            }:
                raise
            logger.warning(
                "GEMINI_SHARED_STATE_{}_FAILED namespace={} errorType={} error={}",
                operation.upper(),
                self.namespace,
                exc_name,
                str(exc)[:160],
            )
            return None

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
        key = self._cooldown_key(scope)

        def _read() -> GeminiCooldownState | None:
            raw = self._redis.get(key)
            metadata = decode_cooldown_payload(raw, now_ms=current_ms)
            if metadata is None and raw:
                ttl = int(self._redis.pttl(key))
                if ttl > 0:
                    metadata = CooldownMetadata(
                        reason="cooldown",
                        cooldown_type="soft",
                        expires_at_ms=current_ms + ttl,
                    )
            if metadata is None:
                return None
            remaining_ms = int(metadata.expires_at_ms) - current_ms
            if remaining_ms <= 0:
                self._redis.delete(key)
                return None
            return GeminiCooldownState(
                remaining_seconds=remaining_ms / 1000.0,
                reason=metadata.reason,
                cooldown_type=metadata.cooldown_type,
            )

        return self._safe_redis("read", _read)

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

        def _write() -> None:
            if self._merge_script is not None:
                self._merge_script(
                    keys=[key],
                    args=[payload, ttl_ms, current_ms],
                )
            else:
                self._redis.eval(
                    REDIS_MERGE_COOLDOWN_SCRIPT,
                    1,
                    key,
                    payload,
                    ttl_ms,
                    current_ms,
                )
            logger.debug(
                "GEMINI_COOLDOWN_STATE_MERGED namespace={} alias={} fingerprint={} reason={} cooldownType={}",
                self.namespace,
                scope.alias,
                scope.fingerprint,
                incoming.reason,
                incoming.cooldown_type,
            )

        if self._safe_redis("write", _write) is None:
            logger.warning(
                "GEMINI_SHARED_STATE_WRITE_FAILED namespace={} alias={} fingerprint={}",
                self.namespace,
                scope.alias,
                scope.fingerprint,
            )

    def clear_cooldown(self, scope: GeminiKeyScope) -> None:
        def _delete() -> None:
            self._redis.delete(self._cooldown_key(scope))

        self._safe_redis("write", _delete)

    def mark_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> None:
        del now_ms
        model_name = normalize_model_name(model)
        if not model_name:
            return
        key = self._model_key(scope, model_name)

        def _mark() -> None:
            self._redis.setex(key, self.model_unsupported_ttl_seconds, "1")

        if self._safe_redis("write", _mark) is None:
            logger.warning(
                "GEMINI_SHARED_STATE_WRITE_FAILED namespace={} alias={} fingerprint={} model={}",
                self.namespace,
                scope.alias,
                scope.fingerprint,
                model_name,
            )
            return
        logger.info(
            "GEMINI_MODEL_UNSUPPORTED_MARKED namespace={} alias={} fingerprint={} model={} ttlSeconds={}",
            self.namespace,
            scope.alias,
            scope.fingerprint,
            model_name,
            self.model_unsupported_ttl_seconds,
        )

    def is_model_unsupported(
        self, scope: GeminiKeyScope, model: str, *, now_ms: int | None = None
    ) -> bool:
        del now_ms
        model_name = normalize_model_name(model)
        if not model_name:
            return False
        key = self._model_key(scope, model_name)

        def _exists() -> bool:
            return bool(self._redis.exists(key))

        result = self._safe_redis("read", _exists)
        return bool(result)

    def clear_model_unsupported(self, scope: GeminiKeyScope, model: str) -> None:
        model_name = normalize_model_name(model)
        if not model_name:
            return

        def _delete() -> None:
            self._redis.delete(self._model_key(scope, model_name))

        self._safe_redis("write", _delete)


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
        service_name=getattr(settings, "service_name", None)
        or getattr(settings, "app_component", None),
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
