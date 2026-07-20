"""Pure cooldown metadata merge policy shared by in-memory and Redis stores."""

from __future__ import annotations

from dataclasses import dataclass

COOLDOWN_PAYLOAD_VERSION = 2

# Score multipliers must keep tier > type > specificity ordering in integer form.
SCORE_TIER_MULTIPLIER = 1000
SCORE_TYPE_MULTIPLIER = 100
DEFAULT_REASON_SPECIFICITY = 5

TERMINAL_REASONS = frozenset(
    {
        "billing_credits_depleted",
        "free_tier_token_quota_exhausted",
        "free_tier_quota_exhausted",
        "model_unavailable",
        "invalid_key",
        "auth_error",
        "region_blocked",
        "invalid_request",
        "hard_cooldown",
        "terminal_unknown",
    }
)

TRANSIENT_REASONS = frozenset(
    {
        "rate_limit",
        "transient_rate_limit",
        "transient_network",
        "network_error",
        "timeout",
        "server_error",
        "transient_provider_error",
        "soft_cooldown",
    }
)

GENERIC_REASONS = frozenset({"cooldown"})

REASON_SPECIFICITY: dict[str, int] = {
    "billing_credits_depleted": 90,
    "free_tier_token_quota_exhausted": 90,
    "free_tier_quota_exhausted": 90,
    "model_unavailable": 85,
    "invalid_key": 80,
    "auth_error": 80,
    "region_blocked": 80,
    "invalid_request": 80,
    "hard_cooldown": 40,
    "terminal_unknown": 35,
    "rate_limit": 60,
    "transient_rate_limit": 60,
    "transient_network": 55,
    "network_error": 55,
    "timeout": 55,
    "server_error": 50,
    "transient_provider_error": 50,
    "soft_cooldown": 30,
    "cooldown": 10,
}

COOLDOWN_TYPE_RANK = {"hard": 2, "soft": 1}

LEGACY_COOLDOWN_PAYLOAD = "1"


@dataclass(frozen=True)
class CooldownMetadata:
    reason: str | None = None
    cooldown_type: str | None = None
    expires_at_ms: int = 0


def normalize_reason(reason: str | None) -> str | None:
    normalized = str(reason or "").strip().lower()
    return normalized or None


def normalize_cooldown_type(cooldown_type: str | None) -> str | None:
    normalized = str(cooldown_type or "").strip().lower()
    if normalized in COOLDOWN_TYPE_RANK:
        return normalized
    return None


def reason_tier(reason: str | None) -> int:
    normalized = normalize_reason(reason)
    if not normalized:
        return 0
    if normalized in TERMINAL_REASONS:
        return 3
    if normalized in TRANSIENT_REASONS:
        return 2
    if normalized in GENERIC_REASONS:
        return 1
    return 1


def build_reason_tier_map() -> dict[str, int]:
    """Normalized reason -> tier. Mirrors Lua tier_map."""
    tiers: dict[str, int] = {}
    for reason in TERMINAL_REASONS:
        tiers[reason] = 3
    for reason in TRANSIENT_REASONS:
        tiers[reason] = 2
    for reason in GENERIC_REASONS:
        tiers[reason] = 1
    return tiers


def metadata_score_tuple(metadata: CooldownMetadata) -> tuple[int, int, int]:
    reason = normalize_reason(metadata.reason)
    cooldown_type = normalize_cooldown_type(metadata.cooldown_type)
    tier = reason_tier(reason)
    specificity = REASON_SPECIFICITY.get(reason or "", DEFAULT_REASON_SPECIFICITY)
    type_rank = COOLDOWN_TYPE_RANK.get(cooldown_type or "", 0)
    return tier, type_rank, specificity


def metadata_score_int(metadata: CooldownMetadata) -> int:
    tier, type_rank, specificity = metadata_score_tuple(metadata)
    return (
        tier * SCORE_TIER_MULTIPLIER
        + type_rank * SCORE_TYPE_MULTIPLIER
        + specificity
    )


def _stronger_cooldown_type(left: str | None, right: str | None) -> str | None:
    left_norm = normalize_cooldown_type(left)
    right_norm = normalize_cooldown_type(right)
    left_rank = COOLDOWN_TYPE_RANK.get(left_norm or "", 0)
    right_rank = COOLDOWN_TYPE_RANK.get(right_norm or "", 0)
    if left_rank >= right_rank:
        return left_norm
    return right_norm


def select_merge_winner(
    existing: CooldownMetadata,
    incoming: CooldownMetadata,
) -> tuple[CooldownMetadata, CooldownMetadata]:
    """Select metadata winner using shared score + tie-break policy."""
    existing_score = metadata_score_tuple(existing)
    incoming_score = metadata_score_tuple(incoming)
    if incoming_score > existing_score:
        return incoming, existing
    if existing_score > incoming_score:
        return existing, incoming
    # Equal score: incoming wins (same as Redis Lua tie-break).
    return incoming, existing


def merge_cooldown_states(
    existing: CooldownMetadata | None,
    incoming: CooldownMetadata,
    *,
    now_ms: int,
) -> CooldownMetadata:
    """Merge cooldown metadata deterministically; expiry is always max()."""
    incoming_expires = max(int(incoming.expires_at_ms or 0), int(now_ms))
    if existing is None or int(existing.expires_at_ms or 0) <= int(now_ms):
        return CooldownMetadata(
            reason=normalize_reason(incoming.reason),
            cooldown_type=normalize_cooldown_type(incoming.cooldown_type),
            expires_at_ms=incoming_expires,
        )

    existing_expires = max(int(existing.expires_at_ms or 0), int(now_ms))
    merged_expires = max(existing_expires, incoming_expires)

    winner, loser = select_merge_winner(existing, incoming)
    merged_reason = normalize_reason(winner.reason) or normalize_reason(loser.reason)
    merged_type = _stronger_cooldown_type(
        existing.cooldown_type,
        incoming.cooldown_type,
    )
    return CooldownMetadata(
        reason=merged_reason,
        cooldown_type=merged_type,
        expires_at_ms=merged_expires,
    )


def merge_cooldown_states_lua_semantics(
    existing: CooldownMetadata | None,
    incoming: CooldownMetadata,
    *,
    now_ms: int,
) -> CooldownMetadata:
    """Mirror Redis Lua merge semantics for offline parity testing."""
    incoming_expires = max(int(incoming.expires_at_ms or 0), int(now_ms))
    if existing is None or int(existing.expires_at_ms or 0) <= int(now_ms):
        return CooldownMetadata(
            reason=normalize_reason(incoming.reason),
            cooldown_type=normalize_cooldown_type(incoming.cooldown_type),
            expires_at_ms=incoming_expires,
        )

    existing_expires = max(int(existing.expires_at_ms or 0), int(now_ms))
    merged_expires = max(existing_expires, incoming_expires)

    existing_score = metadata_score_int(existing)
    incoming_score = metadata_score_int(incoming)

    if existing_score > incoming_score:
        winner = existing
        loser = incoming
    else:
        winner = incoming
        loser = existing

    merged_reason = normalize_reason(winner.reason) or normalize_reason(loser.reason)
    merged_type = _stronger_cooldown_type(
        existing.cooldown_type,
        incoming.cooldown_type,
    )
    return CooldownMetadata(
        reason=merged_reason,
        cooldown_type=merged_type,
        expires_at_ms=merged_expires,
    )


def _lua_table(mapping: dict[str, int]) -> str:
    lines = [f"  {key}={value}," for key, value in sorted(mapping.items())]
    return "\n".join(lines)


def build_redis_merge_lua_script() -> str:
    """Build Redis Lua script from Python policy constants."""
    tier_map = build_reason_tier_map()
    # Lua map must mirror REASON_SPECIFICITY exactly.
    return f"""
local key = KEYS[1]
local incoming_json = ARGV[1]
local incoming_ttl_ms = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])

local TIER_MULTIPLIER = {SCORE_TIER_MULTIPLIER}
local TYPE_MULTIPLIER = {SCORE_TYPE_MULTIPLIER}
local DEFAULT_SPECIFICITY = {DEFAULT_REASON_SPECIFICITY}

local function decode_payload(raw)
  if not raw or raw == "1" then
    return {{reason="cooldown", cooldown_type="soft", expires_at_ms=0}}
  end
  local ok, parsed = pcall(cjson.decode, raw)
  if not ok or type(parsed) ~= "table" then
    return {{reason="cooldown", cooldown_type="soft", expires_at_ms=0}}
  end
  return {{
    reason=parsed.reason,
    cooldown_type=parsed.cooldown_type or parsed.type,
    expires_at_ms=tonumber(parsed.expires_at_ms) or 0
  }}
end

local tier_map = {{
{_lua_table(tier_map)}
}}
local specificity_map = {{
{_lua_table(REASON_SPECIFICITY)}
}}
local type_rank = {{hard=2, soft=1}}

local function score(meta)
  local reason = meta.reason or "cooldown"
  local tier = tier_map[reason] or 1
  local tr = type_rank[meta.cooldown_type or "soft"] or 0
  local specificity = specificity_map[reason] or DEFAULT_SPECIFICITY
  return tier * TIER_MULTIPLIER + tr * TYPE_MULTIPLIER + specificity
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
local loser = current
if current.expires_at_ms and current.expires_at_ms > now_ms then
  local current_score = score(current)
  local incoming_score = score(incoming)
  if current_score > incoming_score then
    winner = current
    loser = incoming
  elseif current_score == incoming_score then
    winner = incoming
    loser = current
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

winner.expires_at_ms = merged_expires
local ttl_ms = merged_expires - now_ms
if ttl_ms < 1 then
  ttl_ms = incoming_ttl_ms
end
local payload = cjson.encode({{
  version=2,
  expires_at_ms=winner.expires_at_ms,
  reason=winner.reason,
  cooldown_type=winner.cooldown_type
}})
redis.call("PSETEX", key, ttl_ms, payload)
return payload
""".strip()
