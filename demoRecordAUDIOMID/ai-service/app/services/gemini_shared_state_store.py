"""Gemini shared-state v2 store (ledger-backed CAS, tombstone clears, snapshot reads)."""

from __future__ import annotations

import json
import threading
import time
from typing import Any, Callable

from loguru import logger

from app.services.gemini_cooldown_merge import (
    COOLDOWN_PAYLOAD_VERSION,
    CooldownMetadata,
    LEGACY_COOLDOWN_PAYLOAD,
    REASON_SPECIFICITY,
    SCORE_TIER_MULTIPLIER,
    SCORE_TYPE_MULTIPLIER,
    DEFAULT_REASON_SPECIFICITY,
    build_reason_tier_map,
    merge_cooldown_states_lua_semantics,
    normalize_cooldown_type,
    normalize_reason,
)
from app.services.gemini_key_cooldown_store import (
    DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS,
    DEFAULT_SHARED_SERVICE_NAME,
    GeminiCooldownState,
    GeminiKeyScope,
    _is_tombstone_payload,
    _normalize_redis_raw,
    _redis_errors,
    decode_cooldown_payload,
    encode_cooldown_payload,
    normalize_model_name,
    parse_redis_cooldown_metadata,
    resolve_shared_state_namespace,
)
from app.services.gemini_shared_state_contracts import (
    CLEAR_TOMBSTONE_TTL_MS,
    PendingOperationStatus,
    SharedScopeSnapshot,
    SharedStateScope,
    SharedStoreErrorType,
    SharedWriteResult,
    build_v2_cooldown_revision_key,
    build_v2_cooldown_state_key,
    build_v2_model_revision_key,
    build_v2_model_state_key,
    digest_for_raw,
)


def _lua_table(mapping: dict[str, int]) -> str:
    lines = [f"  {key}={value}," for key, value in sorted(mapping.items())]
    return "\n".join(lines)


def _build_cas_digest_guard_lua() -> str:
    return """
local expected_digest = ARGV[2]
if expected_digest ~= nil and expected_digest ~= "" then
  local raw = redis.call("GET", KEYS[1])
  local pttl = redis.call("PTTL", KEYS[1])
  local cleared = false
  if raw and raw ~= "" then
    local ok, parsed = pcall(cjson.decode, raw)
    if ok and type(parsed) == "table" and parsed.cleared == true then
      cleared = true
    end
  end
  if not raw or raw == "" or pttl <= 0 or cleared then
    return cjson.encode({
      status="superseded",
      revision=current_revision,
      final_remaining_ms=0,
      merged_from_shared_stronger=false,
      payload=""
    })
  end
end
"""


def build_v2_cas_publish_lua_script() -> str:
    tier_map = build_reason_tier_map()
    return f"""
local state_key = KEYS[1]
local revision_key = KEYS[2]
local expected_revision = tonumber(ARGV[1])
local incoming_reason = ARGV[3]
local incoming_cooldown_type = ARGV[4]
local incoming_remaining_ms = tonumber(ARGV[5])
local now_ms = tonumber(ARGV[6])

local TIER_MULTIPLIER = {SCORE_TIER_MULTIPLIER}
local TYPE_MULTIPLIER = {SCORE_TYPE_MULTIPLIER}
local DEFAULT_SPECIFICITY = {DEFAULT_REASON_SPECIFICITY}

local current_revision = tonumber(redis.call("GET", revision_key) or "0")
if current_revision ~= expected_revision then
  return cjson.encode({{
    status="rejected",
    revision=current_revision,
    final_remaining_ms=0,
    merged_from_shared_stronger=false,
    payload=""
  }})
end

{_build_cas_digest_guard_lua().strip()}

local tier_map = {{
{_lua_table(tier_map)}
}}
local specificity_map = {{
{_lua_table(REASON_SPECIFICITY)}
}}
local type_rank = {{hard=2, soft=1}}

local function decode_payload(raw)
  if not raw or raw == "1" then
    return {{reason="cooldown", cooldown_type="soft", expires_at_ms=0, cleared=false}}
  end
  local ok, parsed = pcall(cjson.decode, raw)
  if not ok or type(parsed) ~= "table" then
    return {{reason="cooldown", cooldown_type="soft", expires_at_ms=0, cleared=false}}
  end
  return {{
    reason=parsed.reason,
    cooldown_type=parsed.cooldown_type or parsed.type,
    expires_at_ms=tonumber(parsed.expires_at_ms) or 0,
    cleared=parsed.cleared == true
  }}
end

local function score(meta)
  local reason = meta.reason or "cooldown"
  local tier = tier_map[reason] or 1
  local tr = type_rank[meta.cooldown_type or "soft"] or 0
  local specificity = specificity_map[reason] or DEFAULT_SPECIFICITY
  return tier * TIER_MULTIPLIER + tr * TYPE_MULTIPLIER + specificity
end

local current_raw = redis.call("GET", state_key)
local current = decode_payload(current_raw)
local current_pttl = redis.call("PTTL", state_key)
if current.cleared then
  current.expires_at_ms = 0
elseif current_pttl and current_pttl > 0 then
  current.expires_at_ms = now_ms + current_pttl
end

local incoming = {{
  reason=incoming_reason,
  cooldown_type=incoming_cooldown_type,
  expires_at_ms=now_ms + incoming_remaining_ms,
  cleared=false
}}

local incoming_only_remaining = incoming_remaining_ms
local merged_expires = incoming.expires_at_ms
if current.expires_at_ms and current.expires_at_ms > now_ms then
  if current.expires_at_ms > merged_expires then
    merged_expires = current.expires_at_ms
  end
end

local winner = incoming
local loser = current
if current.expires_at_ms and current.expires_at_ms > now_ms then
  local current_score = score(current)
  local incoming_score = score(incoming)
  if current_score > incoming_score then
    winner = current
    loser = incoming
  else
    winner = incoming
    loser = current
  end
end

if winner.reason == nil or winner.reason == "" then
  winner.reason = loser.reason
end
if (winner.cooldown_type or "") ~= "hard" and (loser.cooldown_type or "") == "hard" then
  winner.cooldown_type = "hard"
end

local final_remaining_ms = incoming_remaining_ms
local merged_from_shared_stronger = false
if current_pttl and current_pttl > 0 and current.expires_at_ms and current.expires_at_ms > now_ms then
  local current_score = score(current)
  local incoming_score = score(incoming)
  if current_score > incoming_score then
    final_remaining_ms = current_pttl
    merged_from_shared_stronger = true
  end
end
if final_remaining_ms < 1 then
  final_remaining_ms = incoming_remaining_ms
end

local merged_expires = now_ms + final_remaining_ms

local payload = cjson.encode({{
  version={COOLDOWN_PAYLOAD_VERSION},
  expires_at_ms=merged_expires,
  reason=winner.reason,
  cooldown_type=winner.cooldown_type,
  cleared=false
}})
redis.call("PSETEX", state_key, final_remaining_ms, payload)
local new_revision = current_revision + 1
redis.call("SET", revision_key, tostring(new_revision))
return cjson.encode({{
  status="applied",
  revision=new_revision,
  final_remaining_ms=final_remaining_ms,
  merged_from_shared_stronger=merged_from_shared_stronger,
  payload=payload
}})
""".strip()


def build_v2_cas_clear_lua_script() -> str:
    return f"""
local state_key = KEYS[1]
local revision_key = KEYS[2]
local expected_revision = tonumber(ARGV[1])
local tombstone_ttl_ms = tonumber(ARGV[3])

local current_revision = tonumber(redis.call("GET", revision_key) or "0")
if current_revision ~= expected_revision then
  return cjson.encode({{
    status="rejected",
    revision=current_revision,
    final_remaining_ms=0,
    merged_from_shared_stronger=false,
    payload=""
  }})
end

{_build_cas_digest_guard_lua().strip()}

local payload = cjson.encode({{version=2, cleared=true}})
redis.call("PSETEX", state_key, tombstone_ttl_ms, payload)
local new_revision = current_revision + 1
redis.call("SET", revision_key, tostring(new_revision))
return cjson.encode({{
  status="applied",
  revision=new_revision,
  final_remaining_ms=tombstone_ttl_ms,
  merged_from_shared_stronger=false,
  payload=payload
}})
""".strip()


def build_v2_cas_mark_model_lua_script() -> str:
    return f"""
local state_key = KEYS[1]
local revision_key = KEYS[2]
local expected_revision = tonumber(ARGV[1])
local ttl_ms = tonumber(ARGV[3])

local current_revision = tonumber(redis.call("GET", revision_key) or "0")
if current_revision ~= expected_revision then
  return cjson.encode({{
    status="rejected",
    revision=current_revision,
    final_remaining_ms=0,
    merged_from_shared_stronger=false,
    payload=""
  }})
end

{_build_cas_digest_guard_lua().strip()}

local payload = cjson.encode({{version=2, active=true}})
redis.call("PSETEX", state_key, ttl_ms, payload)
local new_revision = current_revision + 1
redis.call("SET", revision_key, tostring(new_revision))
return cjson.encode({{
  status="applied",
  revision=new_revision,
  final_remaining_ms=ttl_ms,
  merged_from_shared_stronger=false,
  payload=payload
}})
""".strip()


REDIS_V2_SCOPE_SNAPSHOT_SCRIPT = """
local cooldown_raw = redis.call("GET", KEYS[1])
local cooldown_pttl = redis.call("PTTL", KEYS[1])
local cooldown_revision = tonumber(redis.call("GET", KEYS[2]) or "0")
local model_raw = redis.call("GET", KEYS[3])
local model_pttl = redis.call("PTTL", KEYS[3])
local model_revision = tonumber(redis.call("GET", KEYS[4]) or "0")
return {
  cooldown_raw or "",
  cooldown_pttl,
  cooldown_revision,
  model_raw or "",
  model_pttl,
  model_revision
}
"""


def _parse_cas_json(raw: Any) -> dict[str, Any]:
    normalized = _normalize_redis_raw(raw)
    if not normalized:
        return {}
    try:
        parsed = json.loads(normalized)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _cas_status(raw_status: Any) -> PendingOperationStatus:
    normalized = str(raw_status or "").strip().lower()
    if normalized == PendingOperationStatus.APPLIED.value:
        return PendingOperationStatus.APPLIED
    if normalized == PendingOperationStatus.SUPERSEDED.value:
        return PendingOperationStatus.SUPERSEDED
    if normalized == PendingOperationStatus.REJECTED.value:
        return PendingOperationStatus.REJECTED
    return PendingOperationStatus.FAILED


def _write_result_from_cas(parsed: dict[str, Any]) -> SharedWriteResult:
    status = _cas_status(parsed.get("status"))
    revision_raw = parsed.get("revision")
    revision = int(revision_raw) if revision_raw is not None else None
    final_remaining_raw = parsed.get("final_remaining_ms")
    final_remaining_ms = (
        int(final_remaining_raw) if final_remaining_raw is not None else None
    )
    digest_raw = parsed.get("digest")
    payload_raw = parsed.get("payload")
    if payload_raw not in (None, ""):
        digest = digest_for_raw(_normalize_redis_raw(payload_raw))
    else:
        digest = str(digest_raw) if digest_raw not in (None, "null", "") else None
    merged = bool(parsed.get("merged_from_shared_stronger"))
    return SharedWriteResult(
        status=status,
        revision=revision,
        final_remaining_ms=final_remaining_ms,
        digest=digest,
        merged_from_shared_stronger=merged,
    )


def _cooldown_state_from_raw(
    raw: Any, *, pttl_ms: int, now_ms: int
) -> GeminiCooldownState | None:
    pttl = int(pttl_ms)
    if pttl <= 0:
        return None
    normalized = _normalize_redis_raw(raw)
    if not normalized or _is_tombstone_payload(normalized):
        return None
    metadata = decode_cooldown_payload(normalized, now_ms=now_ms, pttl_ms=pttl)
    if metadata is None:
        reason, cooldown_type = parse_redis_cooldown_metadata(normalized)
        return GeminiCooldownState(
            remaining_seconds=pttl / 1000.0,
            reason=reason,
            cooldown_type=cooldown_type,
        )
    remaining_ms = max(0, int(metadata.expires_at_ms) - int(now_ms))
    if remaining_ms <= 0:
        return None
    return GeminiCooldownState(
        remaining_seconds=remaining_ms / 1000.0,
        reason=metadata.reason,
        cooldown_type=metadata.cooldown_type,
    )


def _model_marker_active(raw: Any, pttl_ms: int) -> bool:
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


class _V2StoreBase:
    supports_cooldown_metadata = True

    def __init__(
        self,
        *,
        namespace: str,
        allowed_aliases: frozenset[str],
        model_unsupported_ttl_seconds: int = DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS,
        wall_clock_ms: Callable[[], int] | None = None,
    ) -> None:
        self.namespace = namespace
        self.allowed_aliases = frozenset(
            str(alias).strip().lower() for alias in allowed_aliases if str(alias).strip()
        )
        self.model_unsupported_ttl_seconds = max(
            1, int(model_unsupported_ttl_seconds or DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS)
        )
        self._wall_clock_ms = wall_clock_ms or (lambda: int(time.time() * 1000))

    def _now_ms(self, now_ms: int | None = None) -> int:
        return int(now_ms if now_ms is not None else self._wall_clock_ms())

    def _reject_invalid_scope(self, alias: str) -> SharedWriteResult | None:
        normalized = str(alias or "").strip().lower()
        if normalized not in self.allowed_aliases:
            logger.warning(
                "GEMINI_V2_SHARED_STATE_REJECTED alias={} namespace={} reason=invalid_scope",
                normalized,
                self.namespace,
            )
            return SharedWriteResult(
                status=PendingOperationStatus.REJECTED,
                error_type=SharedStoreErrorType.INVALID_SCOPE,
            )
        return None

    def _key_scope(self, scope: SharedStateScope) -> GeminiKeyScope:
        return scope.to_key_scope()

    def _cooldown_keys(self, scope: SharedStateScope) -> tuple[str, str]:
        key_scope = self._key_scope(scope)
        return (
            build_v2_cooldown_state_key(self.namespace, key_scope),
            build_v2_cooldown_revision_key(self.namespace, key_scope),
        )

    def _model_keys(self, scope: SharedStateScope) -> tuple[str, str]:
        key_scope = self._key_scope(scope)
        model = normalize_model_name(scope.model)
        return (
            build_v2_model_state_key(self.namespace, key_scope, model),
            build_v2_model_revision_key(self.namespace, key_scope, model),
        )

    @staticmethod
    def _reject_invalid_argument(reason: str) -> SharedWriteResult:
        return SharedWriteResult(
            status=PendingOperationStatus.REJECTED,
            error_type=SharedStoreErrorType.INVALID_ARGUMENT,
        )


class RedisV2GeminiKeyCooldownStore(_V2StoreBase):
    """Redis-backed v2 shared state with ledger revision CAS."""

    def __init__(
        self,
        redis_client,
        *,
        namespace: str,
        allowed_aliases: frozenset[str],
        model_unsupported_ttl_seconds: int = DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS,
        wall_clock_ms: Callable[[], int] | None = None,
    ) -> None:
        super().__init__(
            namespace=namespace,
            allowed_aliases=allowed_aliases,
            model_unsupported_ttl_seconds=model_unsupported_ttl_seconds,
            wall_clock_ms=wall_clock_ms,
        )
        self._redis = redis_client
        self._publish_script_src = build_v2_cas_publish_lua_script()
        self._clear_script_src = build_v2_cas_clear_lua_script()
        self._mark_model_script_src = build_v2_cas_mark_model_lua_script()
        self._publish_script = self._register_script(self._publish_script_src)
        self._clear_script = self._register_script(self._clear_script_src)
        self._mark_model_script = self._register_script(self._mark_model_script_src)
        self._snapshot_script = self._register_script(REDIS_V2_SCOPE_SNAPSHOT_SCRIPT)
        logger.info(
            "GEMINI_V2_KEY_STATE_NAMESPACE namespace={} allowedAliases={} modelUnsupportedTtlSeconds={}",
            self.namespace,
            len(self.allowed_aliases),
            self.model_unsupported_ttl_seconds,
        )

    def _register_script(self, script: str):
        if hasattr(self._redis, "register_script"):
            return self._redis.register_script(script)
        return None

    def _safe_redis(self, operation: str, fn: Callable[[], Any]) -> tuple[bool, Any, Exception | None]:
        del operation
        try:
            return True, fn(), None
        except _redis_errors() as exc:
            return False, None, exc

    def _log_redis_failure(
        self,
        operation: str,
        exc: Exception | None,
        *,
        alias: str | None = None,
        model: str | None = None,
    ) -> None:
        if exc is None:
            return
        logger.warning(
            "GEMINI_V2_SHARED_STATE_{}_FAILED operation={} errorType={} alias={} namespace={} model={}",
            operation.upper(),
            operation,
            type(exc).__name__,
            alias or "",
            self.namespace,
            normalize_model_name(model) if model else "",
        )

    def _execute_script(
        self, script, script_src: str, *, keys: list[str], args: list[Any]
    ) -> Any:
        if script is not None:
            return script(keys=keys, args=args)
        return self._redis.eval(script_src, len(keys), *keys, *args)

    def _run_cas(
        self,
        *,
        operation: str,
        script,
        script_src: str,
        state_key: str,
        revision_key: str,
        args: list[Any],
        alias: str,
        model: str = "",
    ) -> SharedWriteResult:
        ok, raw, exc = self._safe_redis(
            operation,
            lambda: self._execute_script(
                script,
                script_src,
                keys=[state_key, revision_key],
                args=args,
            ),
        )
        if not ok:
            self._log_redis_failure(operation, exc, alias=alias, model=model)
            return SharedWriteResult(
                status=PendingOperationStatus.FAILED,
                error_type=SharedStoreErrorType.REDIS_UNAVAILABLE,
            )
        parsed = _parse_cas_json(raw)
        if not parsed:
            return SharedWriteResult(
                status=PendingOperationStatus.FAILED,
                error_type=SharedStoreErrorType.PARSE_ERROR,
            )
        return _write_result_from_cas(parsed)

    def apply_cooldown_cas(
        self,
        scope: SharedStateScope,
        *,
        expected_revision: int,
        remaining_ms: int,
        reason: str | None,
        cooldown_type: str | None,
        expected_digest: str | None = None,
    ) -> SharedWriteResult:
        rejected = self._reject_invalid_scope(scope.alias)
        if rejected is not None:
            return rejected
        if int(remaining_ms) < 0:
            return self._reject_invalid_argument("negative_remaining_ms")

        state_key, revision_key = self._cooldown_keys(scope)
        now_ms = self._now_ms()
        ttl_ms = max(1, int(remaining_ms))
        args = [
            int(expected_revision),
            expected_digest or "",
            normalize_reason(reason) or "cooldown",
            normalize_cooldown_type(cooldown_type) or "soft",
            ttl_ms,
            now_ms,
        ]
        result = self._run_cas(
            operation="publish",
            script=self._publish_script,
            script_src=self._publish_script_src,
            state_key=state_key,
            revision_key=revision_key,
            args=args,
            alias=scope.alias,
        )
        if result.success:
            logger.debug(
                "GEMINI_V2_COOLDOWN_CAS_APPLIED namespace={} alias={} revision={} remainingMs={} mergedFromShared={}",
                self.namespace,
                scope.alias,
                result.revision,
                result.final_remaining_ms,
                result.merged_from_shared_stronger,
            )
        return result

    def clear_cooldown_cas(
        self,
        scope: SharedStateScope,
        *,
        expected_revision: int,
        expected_digest: str | None = None,
    ) -> SharedWriteResult:
        rejected = self._reject_invalid_scope(scope.alias)
        if rejected is not None:
            return rejected

        state_key, revision_key = self._cooldown_keys(scope)
        args = [
            int(expected_revision),
            expected_digest or "",
            CLEAR_TOMBSTONE_TTL_MS,
        ]
        return self._run_cas(
            operation="clear",
            script=self._clear_script,
            script_src=self._clear_script_src,
            state_key=state_key,
            revision_key=revision_key,
            args=args,
            alias=scope.alias,
        )

    def mark_model_unsupported_cas(
        self,
        scope: SharedStateScope,
        *,
        expected_revision: int,
        expected_digest: str | None = None,
    ) -> SharedWriteResult:
        rejected = self._reject_invalid_scope(scope.alias)
        if rejected is not None:
            return rejected
        model = normalize_model_name(scope.model)
        if not model:
            return self._reject_invalid_argument("missing_model")

        state_key, revision_key = self._model_keys(scope)
        ttl_ms = self.model_unsupported_ttl_seconds * 1000
        args = [int(expected_revision), expected_digest or "", ttl_ms]
        result = self._run_cas(
            operation="mark_model",
            script=self._mark_model_script,
            script_src=self._mark_model_script_src,
            state_key=state_key,
            revision_key=revision_key,
            args=args,
            alias=scope.alias,
            model=model,
        )
        if result.success:
            logger.info(
                "GEMINI_V2_MODEL_UNSUPPORTED_CAS_APPLIED namespace={} alias={} model={} revision={}",
                self.namespace,
                scope.alias,
                model,
                result.revision,
            )
        return result

    def clear_model_unsupported_cas(
        self,
        scope: SharedStateScope,
        *,
        expected_revision: int,
        expected_digest: str | None = None,
    ) -> SharedWriteResult:
        rejected = self._reject_invalid_scope(scope.alias)
        if rejected is not None:
            return rejected
        model = normalize_model_name(scope.model)
        if not model:
            return self._reject_invalid_argument("missing_model")

        state_key, revision_key = self._model_keys(scope)
        args = [
            int(expected_revision),
            expected_digest or "",
            CLEAR_TOMBSTONE_TTL_MS,
        ]
        return self._run_cas(
            operation="clear_model",
            script=self._clear_script,
            script_src=self._clear_script_src,
            state_key=state_key,
            revision_key=revision_key,
            args=args,
            alias=scope.alias,
            model=model,
        )

    def _execute_scope_snapshot(
        self, scope: SharedStateScope, model: str
    ) -> tuple[str, int, int, str, int, int]:
        cooldown_state_key, cooldown_revision_key = self._cooldown_keys(scope)
        model_name = normalize_model_name(model)
        if model_name:
            model_state_key, model_revision_key = self._model_keys(
                SharedStateScope(
                    alias=scope.alias,
                    fingerprint=scope.fingerprint,
                    model=model_name,
                )
            )
        else:
            model_state_key, model_revision_key = cooldown_state_key, cooldown_revision_key

        if self._snapshot_script is not None:
            raw = self._snapshot_script(
                keys=[
                    cooldown_state_key,
                    cooldown_revision_key,
                    model_state_key,
                    model_revision_key,
                ],
                args=[],
            )
        else:
            raw = self._redis.eval(
                REDIS_V2_SCOPE_SNAPSHOT_SCRIPT,
                4,
                cooldown_state_key,
                cooldown_revision_key,
                model_state_key,
                model_revision_key,
            )
        values = list(raw or [])
        cooldown_raw = _normalize_redis_raw(values[0] if len(values) > 0 else "")
        cooldown_pttl = int(values[1]) if len(values) > 1 else -2
        cooldown_revision = int(values[2]) if len(values) > 2 else 0
        model_raw = _normalize_redis_raw(values[3] if len(values) > 3 else "")
        model_pttl = int(values[4]) if len(values) > 4 else -2
        model_revision = int(values[5]) if len(values) > 5 else 0
        return (
            cooldown_raw or "",
            cooldown_pttl,
            cooldown_revision,
            model_raw or "",
            model_pttl,
            model_revision,
        )

    def read_scope_snapshot(
        self, scope: SharedStateScope, *, model: str = ""
    ) -> SharedScopeSnapshot:
        if self._reject_invalid_scope(scope.alias) is not None:
            return SharedScopeSnapshot(scope=scope)
        now_ms = self._now_ms()
        ok, values, exc = self._safe_redis(
            "snapshot",
            lambda: self._execute_scope_snapshot(scope, model),
        )
        if not ok:
            self._log_redis_failure("snapshot", exc, alias=scope.alias, model=model)
            return SharedScopeSnapshot(scope=scope)

        (
            cooldown_raw,
            cooldown_pttl,
            cooldown_revision,
            model_raw,
            model_pttl,
            model_revision,
        ) = values
        cooldown_state = _cooldown_state_from_raw(
            cooldown_raw, pttl_ms=cooldown_pttl, now_ms=now_ms
        )
        model_name = normalize_model_name(model)
        model_unsupported = bool(
            model_name and _model_marker_active(model_raw, model_pttl)
        )
        return SharedScopeSnapshot(
            scope=scope,
            cooldown_state=cooldown_state,
            cooldown_pttl_ms=int(cooldown_pttl),
            cooldown_revision=int(cooldown_revision),
            model_unsupported=model_unsupported,
            model_pttl_ms=int(model_pttl) if model_name else -2,
            model_revision=int(model_revision) if model_name else 0,
            cooldown_digest=digest_for_raw(cooldown_raw),
            model_digest=digest_for_raw(model_raw) if model_name else None,
        )


class InMemoryV2GeminiKeyCooldownStore(_V2StoreBase):
    """In-memory v2 store mirroring Redis CAS semantics for unit tests."""

    def __init__(
        self,
        *,
        namespace: str,
        allowed_aliases: frozenset[str],
        model_unsupported_ttl_seconds: int = DEFAULT_MODEL_UNSUPPORTED_TTL_SECONDS,
        wall_clock_ms: Callable[[], int] | None = None,
    ) -> None:
        super().__init__(
            namespace=namespace,
            allowed_aliases=allowed_aliases,
            model_unsupported_ttl_seconds=model_unsupported_ttl_seconds,
            wall_clock_ms=wall_clock_ms,
        )
        self._lock = threading.RLock()
        self._state_raw: dict[str, str] = {}
        self._state_expires_ms: dict[str, int] = {}
        self._revisions: dict[str, int] = {}

    def _slot(self, key: str) -> str:
        return key

    def _read_slot(self, state_key: str, revision_key: str) -> tuple[str | None, int, int]:
        with self._lock:
            revision = int(self._revisions.get(revision_key, 0))
            now_ms = self._now_ms()
            expires_at = int(self._state_expires_ms.get(state_key, 0))
            if expires_at <= now_ms:
                self._state_raw.pop(state_key, None)
                self._state_expires_ms.pop(state_key, None)
                return None, -2, revision
            raw = self._state_raw.get(state_key)
            pttl = max(0, expires_at - now_ms)
            return raw, pttl, revision

    def _digest_guard(
        self,
        *,
        raw: str | None,
        pttl: int,
        expected_digest: str | None,
        revision: int,
    ) -> SharedWriteResult | None:
        if not expected_digest:
            return None
        missing = raw is None or int(pttl) <= 0 or _is_tombstone_payload(raw)
        if missing:
            return SharedWriteResult(
                status=PendingOperationStatus.SUPERSEDED,
                revision=revision,
            )
        if digest_for_raw(raw) != expected_digest:
            return SharedWriteResult(
                status=PendingOperationStatus.SUPERSEDED,
                revision=revision,
            )
        return None

    def _write_state(
        self,
        *,
        state_key: str,
        revision_key: str,
        payload: str,
        ttl_ms: int,
        revision: int,
    ) -> SharedWriteResult:
        now_ms = self._now_ms()
        expires_at = now_ms + max(1, int(ttl_ms))
        new_revision = revision + 1
        with self._lock:
            self._state_raw[state_key] = payload
            self._state_expires_ms[state_key] = expires_at
            self._revisions[revision_key] = new_revision
        return SharedWriteResult(
            status=PendingOperationStatus.APPLIED,
            revision=new_revision,
            final_remaining_ms=max(1, int(ttl_ms)),
            digest=digest_for_raw(payload),
        )

    def apply_cooldown_cas(
        self,
        scope: SharedStateScope,
        *,
        expected_revision: int,
        remaining_ms: int,
        reason: str | None,
        cooldown_type: str | None,
        expected_digest: str | None = None,
    ) -> SharedWriteResult:
        rejected = self._reject_invalid_scope(scope.alias)
        if rejected is not None:
            return rejected
        if int(remaining_ms) < 0:
            return self._reject_invalid_argument("negative_remaining_ms")

        state_key, revision_key = self._cooldown_keys(scope)
        raw, pttl, revision = self._read_slot(state_key, revision_key)
        if revision != int(expected_revision):
            return SharedWriteResult(
                status=PendingOperationStatus.REJECTED,
                revision=revision,
            )
        superseded = self._digest_guard(
            raw=raw, pttl=pttl, expected_digest=expected_digest, revision=revision
        )
        if superseded is not None:
            return superseded

        now_ms = self._now_ms()
        incoming = CooldownMetadata(
            reason=normalize_reason(reason),
            cooldown_type=normalize_cooldown_type(cooldown_type),
            expires_at_ms=now_ms + max(1, int(remaining_ms)),
        )
        existing = None
        if raw and int(pttl) > 0 and not _is_tombstone_payload(raw):
            existing = decode_cooldown_payload(raw, now_ms=now_ms, pttl_ms=pttl)
        merged = merge_cooldown_states_lua_semantics(existing, incoming, now_ms=now_ms)
        incoming_only = max(1, int(remaining_ms))
        final_remaining_ms = max(1, int(merged.expires_at_ms) - now_ms)
        merged_from_shared = final_remaining_ms > incoming_only
        payload = encode_cooldown_payload(merged)
        result = self._write_state(
            state_key=state_key,
            revision_key=revision_key,
            payload=payload,
            ttl_ms=final_remaining_ms,
            revision=revision,
        )
        return SharedWriteResult(
            status=result.status,
            revision=result.revision,
            final_remaining_ms=final_remaining_ms,
            digest=result.digest,
            merged_from_shared_stronger=merged_from_shared,
        )

    def clear_cooldown_cas(
        self,
        scope: SharedStateScope,
        *,
        expected_revision: int,
        expected_digest: str | None = None,
    ) -> SharedWriteResult:
        rejected = self._reject_invalid_scope(scope.alias)
        if rejected is not None:
            return rejected
        state_key, revision_key = self._cooldown_keys(scope)
        raw, pttl, revision = self._read_slot(state_key, revision_key)
        if revision != int(expected_revision):
            return SharedWriteResult(
                status=PendingOperationStatus.REJECTED,
                revision=revision,
            )
        superseded = self._digest_guard(
            raw=raw, pttl=pttl, expected_digest=expected_digest, revision=revision
        )
        if superseded is not None:
            return superseded
        payload = json.dumps({"version": 2, "cleared": True}, separators=(",", ":"))
        return self._write_state(
            state_key=state_key,
            revision_key=revision_key,
            payload=payload,
            ttl_ms=CLEAR_TOMBSTONE_TTL_MS,
            revision=revision,
        )

    def mark_model_unsupported_cas(
        self,
        scope: SharedStateScope,
        *,
        expected_revision: int,
        expected_digest: str | None = None,
    ) -> SharedWriteResult:
        rejected = self._reject_invalid_scope(scope.alias)
        if rejected is not None:
            return rejected
        if not normalize_model_name(scope.model):
            return self._reject_invalid_argument("missing_model")
        return self._publish_marker_cas(
            scope,
            expected_revision=expected_revision,
            expected_digest=expected_digest,
            active=True,
        )

    def clear_model_unsupported_cas(
        self,
        scope: SharedStateScope,
        *,
        expected_revision: int,
        expected_digest: str | None = None,
    ) -> SharedWriteResult:
        rejected = self._reject_invalid_scope(scope.alias)
        if rejected is not None:
            return rejected
        if not normalize_model_name(scope.model):
            return self._reject_invalid_argument("missing_model")
        return self._clear_model_cas(
            scope, expected_revision=expected_revision, expected_digest=expected_digest
        )

    def _clear_model_cas(
        self,
        scope: SharedStateScope,
        *,
        expected_revision: int,
        expected_digest: str | None,
    ) -> SharedWriteResult:
        state_key, revision_key = self._model_keys(scope)
        raw, pttl, revision = self._read_slot(state_key, revision_key)
        if revision != int(expected_revision):
            return SharedWriteResult(
                status=PendingOperationStatus.REJECTED,
                revision=revision,
            )
        superseded = self._digest_guard(
            raw=raw, pttl=pttl, expected_digest=expected_digest, revision=revision
        )
        if superseded is not None:
            return superseded
        payload = json.dumps({"version": 2, "cleared": True}, separators=(",", ":"))
        return self._write_state(
            state_key=state_key,
            revision_key=revision_key,
            payload=payload,
            ttl_ms=CLEAR_TOMBSTONE_TTL_MS,
            revision=revision,
        )

    def _publish_marker_cas(
        self,
        scope: SharedStateScope,
        *,
        expected_revision: int,
        expected_digest: str | None,
        active: bool,
    ) -> SharedWriteResult:
        state_key, revision_key = self._model_keys(scope)
        raw, pttl, revision = self._read_slot(state_key, revision_key)
        if revision != int(expected_revision):
            return SharedWriteResult(
                status=PendingOperationStatus.REJECTED,
                revision=revision,
            )
        superseded = self._digest_guard(
            raw=raw, pttl=pttl, expected_digest=expected_digest, revision=revision
        )
        if superseded is not None:
            return superseded
        payload = json.dumps({"version": 2, "active": active}, separators=(",", ":"))
        ttl_ms = self.model_unsupported_ttl_seconds * 1000
        return self._write_state(
            state_key=state_key,
            revision_key=revision_key,
            payload=payload,
            ttl_ms=ttl_ms,
            revision=revision,
        )

    def read_scope_snapshot(
        self, scope: SharedStateScope, *, model: str = ""
    ) -> SharedScopeSnapshot:
        if self._reject_invalid_scope(scope.alias) is not None:
            return SharedScopeSnapshot(scope=scope)
        now_ms = self._now_ms()
        cooldown_state_key, cooldown_revision_key = self._cooldown_keys(scope)
        cooldown_raw, cooldown_pttl, cooldown_revision = self._read_slot(
            cooldown_state_key, cooldown_revision_key
        )
        model_name = normalize_model_name(model)
        model_raw: str | None = None
        model_pttl = -2
        model_revision = 0
        if model_name:
            model_scope = SharedStateScope(
                alias=scope.alias,
                fingerprint=scope.fingerprint,
                model=model_name,
            )
            model_state_key, model_revision_key = self._model_keys(model_scope)
            model_raw, model_pttl, model_revision = self._read_slot(
                model_state_key, model_revision_key
            )
        cooldown_state = _cooldown_state_from_raw(
            cooldown_raw, pttl_ms=cooldown_pttl, now_ms=now_ms
        )
        return SharedScopeSnapshot(
            scope=scope,
            cooldown_state=cooldown_state,
            cooldown_pttl_ms=int(cooldown_pttl),
            cooldown_revision=int(cooldown_revision),
            model_unsupported=bool(model_name and _model_marker_active(model_raw, model_pttl)),
            model_pttl_ms=int(model_pttl) if model_name else -2,
            model_revision=int(model_revision) if model_name else 0,
            cooldown_digest=digest_for_raw(cooldown_raw),
            model_digest=digest_for_raw(model_raw) if model_name else None,
        )


def build_v2_redis_gemini_cooldown_store(
    redis_client,
    *,
    allowed_aliases: frozenset[str],
    settings: Any | None = None,
) -> RedisV2GeminiKeyCooldownStore:
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
    return RedisV2GeminiKeyCooldownStore(
        redis_client,
        namespace=namespace,
        allowed_aliases=allowed_aliases,
        model_unsupported_ttl_seconds=ttl_seconds,
    )
