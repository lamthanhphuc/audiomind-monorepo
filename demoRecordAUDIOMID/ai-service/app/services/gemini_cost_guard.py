from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from loguru import logger

_NAMESPACE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,47}$")

_RESERVE_SCRIPT = r"""
local operation = redis.call('GET', KEYS[5])
if operation then
  return {0, 'duplicate'}
end

local requests = tonumber(redis.call('GET', KEYS[1]) or '0')
local reanalysis = tonumber(redis.call('GET', KEYS[2]) or '0')
local tokens = tonumber(redis.call('GET', KEYS[3]) or '0')
local active = tonumber(redis.call('GET', KEYS[4]) or '0')

if requests >= tonumber(ARGV[1]) then return {0, 'daily_request_limit'} end
if ARGV[5] == '1' and reanalysis >= tonumber(ARGV[2]) then
  return {0, 'daily_reanalysis_limit'}
end
if tokens + tonumber(ARGV[6]) > tonumber(ARGV[3]) then
  return {0, 'daily_token_limit'}
end
if active >= tonumber(ARGV[4]) then return {0, 'concurrency_limit'} end

local claimed = redis.call('SET', KEYS[5], 'pending', 'EX', tonumber(ARGV[8]), 'NX')
if not claimed then
  return {0, 'duplicate'}
end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[7]))
if ARGV[5] == '1' then
  redis.call('INCR', KEYS[2])
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[7]))
end
redis.call('INCRBY', KEYS[3], tonumber(ARGV[6]))
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[7]))
redis.call('INCR', KEYS[4])
redis.call('EXPIRE', KEYS[4], tonumber(ARGV[9]))
return {1, 'allowed'}
"""

_RELEASE_SCRIPT = r"""
local operation = redis.call('GET', KEYS[2])
if operation ~= 'pending' then
  return tonumber(redis.call('GET', KEYS[1]) or '0')
end
if ARGV[1] == '1' then
  redis.call('SET', KEYS[2], 'completed', 'KEEPTTL', 'XX')
else
  redis.call('DEL', KEYS[2])
end
local active = tonumber(redis.call('GET', KEYS[1]) or '0')
if active <= 1 then
  redis.call('DEL', KEYS[1])
  return 0
end
return redis.call('DECR', KEYS[1])
"""


@dataclass(frozen=True, slots=True)
class GeminiCostReservation:
    allowed: bool
    reason: str
    user_component: str
    operation_component: str
    estimated_tokens: int
    duplicate: bool = False


def _component(value: object) -> str:
    normalized = str(value or "anonymous").strip().lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:20]


def _seconds_until_utc_reset(now: datetime | None = None) -> int:
    current = now or datetime.now(timezone.utc)
    tomorrow = (current + timedelta(days=1)).date()
    boundary = datetime.combine(tomorrow, datetime.min.time(), tzinfo=timezone.utc)
    return max(60, int((boundary - current).total_seconds()) + 60)


class GeminiCostGuard:
    """Atomic, fail-closed distributed request/token/concurrency guard."""

    def __init__(
        self,
        redis_client: Any,
        *,
        namespace: str,
        daily_request_limit_per_user: int,
        daily_reanalysis_limit_per_meeting: int,
        daily_token_limit_per_user: int,
        max_concurrent_requests: int,
        operation_ttl_seconds: int = 86400,
        concurrency_lease_seconds: int = 600,
    ) -> None:
        safe_namespace = str(namespace or "").strip().lower()
        if not _NAMESPACE_RE.fullmatch(safe_namespace):
            raise ValueError("Gemini cost guard namespace is invalid")
        self._redis = redis_client
        self.namespace = safe_namespace
        self.daily_request_limit_per_user = max(
            1, int(daily_request_limit_per_user or 1)
        )
        self.daily_reanalysis_limit_per_meeting = max(
            1, int(daily_reanalysis_limit_per_meeting or 1)
        )
        self.daily_token_limit_per_user = max(1, int(daily_token_limit_per_user or 1))
        self.max_concurrent_requests = max(1, int(max_concurrent_requests or 1))
        self.operation_ttl_seconds = max(60, int(operation_ttl_seconds or 60))
        self.concurrency_lease_seconds = max(30, int(concurrency_lease_seconds or 30))

    def reserve(
        self,
        *,
        user_id: object,
        meeting_id: object,
        operation_id: str,
        estimated_tokens: int,
        is_reanalysis: bool,
    ) -> GeminiCostReservation:
        user = _component(user_id)
        meeting = _component(meeting_id)
        operation = _component(f"{user}:{operation_id}")
        prefix = f"{self.namespace}:gemini-cost"
        keys = (
            f"{prefix}:requests:{user}",
            f"{prefix}:reanalysis:{meeting}",
            f"{prefix}:tokens:{user}",
            f"{prefix}:active",
            f"{prefix}:operation:{operation}",
        )
        estimate = max(0, int(estimated_tokens or 0))
        try:
            raw = self._redis.eval(
                _RESERVE_SCRIPT,
                len(keys),
                *keys,
                self.daily_request_limit_per_user,
                self.daily_reanalysis_limit_per_meeting,
                self.daily_token_limit_per_user,
                self.max_concurrent_requests,
                1 if is_reanalysis else 0,
                estimate,
                _seconds_until_utc_reset(),
                self.operation_ttl_seconds,
                self.concurrency_lease_seconds,
            )
        except Exception as exc:
            logger.warning(
                "GEMINI_COST_GUARD_UNAVAILABLE error_type={} fail_closed=true",
                type(exc).__name__,
            )
            return GeminiCostReservation(
                False, "guard_unavailable", user, operation, estimate
            )

        allowed = bool(int(raw[0])) if isinstance(raw, (list, tuple)) and raw else False
        reason_raw = (
            raw[1] if isinstance(raw, (list, tuple)) and len(raw) > 1 else b"invalid"
        )
        reason = (
            reason_raw.decode("utf-8", errors="replace")
            if isinstance(reason_raw, bytes)
            else str(reason_raw)
        )
        return GeminiCostReservation(
            allowed,
            reason,
            user,
            operation,
            estimate,
            duplicate=reason == "duplicate",
        )

    def release(
        self,
        reservation: GeminiCostReservation | None,
        *,
        success: bool = False,
    ) -> None:
        if reservation is None or not reservation.allowed:
            return
        prefix = f"{self.namespace}:gemini-cost"
        active_key = f"{prefix}:active"
        operation_key = f"{prefix}:operation:{reservation.operation_component}"
        try:
            self._redis.eval(
                _RELEASE_SCRIPT,
                2,
                active_key,
                operation_key,
                1 if success else 0,
            )
        except Exception as exc:
            logger.warning(
                "GEMINI_COST_GUARD_RELEASE_FAILED error_type={}", type(exc).__name__
            )


def reserve_configured_gemini_cost(
    *,
    settings: Any,
    redis_client: Any,
    user_id: object,
    meeting_id: object,
    operation_id: str,
    estimated_tokens: int,
    is_reanalysis: bool = False,
) -> tuple[GeminiCostGuard | None, GeminiCostReservation | None]:
    if not bool(getattr(settings, "gemini_cost_guard_enabled", True)):
        return None, None
    guard = GeminiCostGuard(
        redis_client,
        namespace=getattr(settings, "gemini_cost_guard_namespace", "audiomind"),
        daily_request_limit_per_user=getattr(
            settings, "gemini_daily_request_limit_per_user", 20
        ),
        daily_reanalysis_limit_per_meeting=getattr(
            settings, "gemini_daily_reanalyze_limit_per_meeting", 3
        ),
        daily_token_limit_per_user=getattr(
            settings, "gemini_daily_token_limit_per_user", 100000
        ),
        max_concurrent_requests=getattr(settings, "gemini_max_concurrent_requests", 2),
    )
    reservation = guard.reserve(
        user_id=user_id,
        meeting_id=meeting_id,
        operation_id=operation_id,
        estimated_tokens=estimated_tokens,
        is_reanalysis=is_reanalysis,
    )
    return guard, reservation
