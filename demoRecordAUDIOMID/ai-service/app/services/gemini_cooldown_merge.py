"""Pure cooldown metadata merge policy shared by in-memory and Redis stores."""

from __future__ import annotations

from dataclasses import dataclass

COOLDOWN_PAYLOAD_VERSION = 2

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


@dataclass(frozen=True)
class CooldownMetadata:
    reason: str | None = None
    cooldown_type: str | None = None
    expires_at_ms: int = 0

    @property
    def remaining_ms(self) -> int:
        return max(0, int(self.expires_at_ms))


def normalize_reason(reason: str | None) -> str | None:
    normalized = str(reason or "").strip().lower()
    return normalized or None


def normalize_cooldown_type(cooldown_type: str | None) -> str | None:
    normalized = str(cooldown_type or "").strip().lower()
    if normalized in COOLDOWN_TYPE_RANK:
        return normalized
    return None


def _reason_tier(reason: str | None) -> int:
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


def _metadata_score(metadata: CooldownMetadata) -> tuple[int, int, int]:
    reason = normalize_reason(metadata.reason)
    cooldown_type = normalize_cooldown_type(metadata.cooldown_type)
    tier = _reason_tier(reason)
    specificity = REASON_SPECIFICITY.get(reason or "", 5)
    type_rank = COOLDOWN_TYPE_RANK.get(cooldown_type or "", 0)
    return tier, type_rank, specificity


def _stronger_cooldown_type(left: str | None, right: str | None) -> str | None:
    left_norm = normalize_cooldown_type(left)
    right_norm = normalize_cooldown_type(right)
    left_rank = COOLDOWN_TYPE_RANK.get(left_norm or "", 0)
    right_rank = COOLDOWN_TYPE_RANK.get(right_norm or "", 0)
    if left_rank >= right_rank:
        return left_norm
    return right_norm


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

    existing_score = _metadata_score(existing)
    incoming_score = _metadata_score(incoming)

    if incoming_score > existing_score:
        winner = incoming
        loser = existing
    elif existing_score > incoming_score:
        winner = existing
        loser = incoming
    else:
        # Same priority tier: prefer incoming specific reason, never downgrade type.
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
