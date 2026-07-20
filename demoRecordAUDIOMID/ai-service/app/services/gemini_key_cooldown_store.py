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


@dataclass(frozen=True)
class SafeRedisResult:
    success: bool
    value: Any = None
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
    safe = []
    for char in cleaned:
        if char.isalnum() or char in {":", "-", "_", "."}:
            safe.append(char)
        else:
            safe.append("-")
    return "".join(safe) or DEFAULT_SHARED_STATE_NAMESPACE


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
    if expires_at_ms is not None and expires_at_ms <= int(now_ms):
        return None
    reason = normalize_reason(parsed.get("reason")) or "cooldown"
    cooldown_type = normalize_cooldown_type(
        parsed.get("cooldown_type") or parsed.get("type")
    )
    resolved_expires = expires_at_ms
    if resolved_expires is None and pttl_ms is not None and int(pttl_ms) > 0:
        resolved_expires = int(now_ms) + int(pttl_ms)
    if resolved_expires is None:
        resolved_expires = 0
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
        wall_clock_ms: Callable[[], int] | None = None,
        namespace: str = DEFAULT_SHARED_STATE_NAMESPACE,
        model_unsupported_ttl_seconds: int = DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS,
    ) -> None:
        self._wall_clock_ms = wall_clock_ms or (lambda: int(time.time() * 1000))
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


REDIS_MERGE_COOLDOWN_SCRIPT = build_redis_merge_lua_script()


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
        logger.warning(
            "GEMINI_SHARED_STATE_{}_FAILED namespace={} alias={} fingerprint={} model={} errorType={} error={}",
            operation.upper(),
            self.namespace,
            alias or "",
            fingerprint or "",
            model or "",
            type(exc).__name__,
            str(exc)[:160],
        )

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
        del now, now_ms
        key = self._cooldown_key(scope)

        def _read() -> GeminiCooldownState | None:
            raw = self._redis.get(key)
            if raw is None:
                return None
            pttl = int(self._redis.pttl(key))
            if pttl == -2:
                return None
            if pttl == -1:
                self._redis.delete(key)
                return None
            if pttl <= 0:
                self._redis.delete(key)
                return None
            reason, cooldown_type = parse_redis_cooldown_metadata(raw)
            return GeminiCooldownState(
                remaining_seconds=pttl / 1000.0,
                reason=reason,
                cooldown_type=cooldown_type,
            )

        result = self._safe_redis("read", _read)
        if not result.success:
            self._log_redis_failure("read", result.error)
            return None
        return result.value

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

        write_result = self._safe_redis("write", _write)
        if not write_result.success:
            self._log_redis_failure(
                "write",
                write_result.error,
                alias=scope.alias,
                fingerprint=scope.fingerprint,
            )

    def clear_cooldown(self, scope: GeminiKeyScope) -> None:
        def _delete() -> None:
            self._redis.delete(self._cooldown_key(scope))

        delete_result = self._safe_redis("write", _delete)
        if not delete_result.success:
            self._log_redis_failure(
                "clear",
                delete_result.error,
                alias=scope.alias,
                fingerprint=scope.fingerprint,
            )

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
        if not result.success:
            self._log_redis_failure("read", result.error, model=model_name)
            return False
        return bool(result.value)

    def clear_model_unsupported(self, scope: GeminiKeyScope, model: str) -> None:
        model_name = normalize_model_name(model)
        if not model_name:
            return

        def _delete() -> None:
            self._redis.delete(self._model_key(scope, model_name))

        delete_result = self._safe_redis("write", _delete)
        if not delete_result.success:
            self._log_redis_failure(
                "clear",
                delete_result.error,
                alias=scope.alias,
                fingerprint=scope.fingerprint,
                model=model_name,
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
