"""Parity tests between Python merge policy and generated Redis Lua policy."""

from __future__ import annotations

import itertools

import pytest

from app.services.gemini_cooldown_merge import (
    COOLDOWN_TYPE_RANK,
    REASON_SPECIFICITY,
    CooldownMetadata,
    build_redis_merge_lua_script,
    merge_cooldown_states,
    merge_cooldown_states_lua_semantics,
    metadata_score_int,
    metadata_score_tuple,
)


def _all_reasons() -> list[str]:
    return sorted(REASON_SPECIFICITY.keys())


def _all_types() -> list[str]:
    return sorted(COOLDOWN_TYPE_RANK.keys())


@pytest.mark.parametrize(
    ("existing_reason", "incoming_reason"),
    itertools.product(
        ["billing_credits_depleted", "terminal_unknown", "rate_limit", "cooldown"],
        ["billing_credits_depleted", "terminal_unknown", "rate_limit", "cooldown"],
    ),
)
def test_python_merge_matches_lua_semantics_for_required_cases(
    existing_reason: str,
    incoming_reason: str,
) -> None:
    now_ms = 1_700_000_000_000
    existing = CooldownMetadata(existing_reason, "hard", now_ms + 900_000)
    incoming = CooldownMetadata(incoming_reason, "hard", now_ms + 90_000)
    python_result = merge_cooldown_states(existing, incoming, now_ms=now_ms)
    lua_result = merge_cooldown_states_lua_semantics(existing, incoming, now_ms=now_ms)
    assert python_result == lua_result


@pytest.mark.parametrize("reason", _all_reasons())
@pytest.mark.parametrize("cooldown_type", _all_types())
def test_python_and_lua_semantics_agree_for_all_reason_type_pairs(
    reason: str,
    cooldown_type: str,
) -> None:
    now_ms = 1_700_000_000_000
    existing = CooldownMetadata("cooldown", "soft", now_ms + 500_000)
    incoming = CooldownMetadata(reason, cooldown_type, now_ms + 100_000)
    python_result = merge_cooldown_states(existing, incoming, now_ms=now_ms)
    lua_result = merge_cooldown_states_lua_semantics(existing, incoming, now_ms=now_ms)
    assert python_result == lua_result


def test_billing_beats_terminal_unknown_on_equal_hard_score() -> None:
    now_ms = 1_700_000_000_000
    existing = CooldownMetadata("billing_credits_depleted", "hard", now_ms + 900_000)
    incoming = CooldownMetadata("terminal_unknown", "hard", now_ms + 900_000)
    merged = merge_cooldown_states(existing, incoming, now_ms=now_ms)
    assert merged.reason == "billing_credits_depleted"
    assert merged.cooldown_type == "hard"
    assert metadata_score_tuple(existing) > metadata_score_tuple(incoming)


def test_rate_limit_beats_cooldown_on_soft_transient_tier() -> None:
    now_ms = 1_700_000_000_000
    existing = CooldownMetadata("cooldown", "soft", now_ms + 900_000)
    incoming = CooldownMetadata("rate_limit", "soft", now_ms + 900_000)
    merged = merge_cooldown_states(existing, incoming, now_ms=now_ms)
    assert merged.reason == "rate_limit"


def test_hard_terminal_wins_over_soft_rate_limit_even_with_shorter_ttl() -> None:
    now_ms = 1_700_000_000_000
    existing = CooldownMetadata("rate_limit", "soft", now_ms + 900_000)
    incoming = CooldownMetadata("billing_credits_depleted", "hard", now_ms + 90_000)
    merged = merge_cooldown_states(existing, incoming, now_ms=now_ms)
    assert merged.reason == "billing_credits_depleted"
    assert merged.cooldown_type == "hard"
    assert merged.expires_at_ms >= existing.expires_at_ms


def test_lua_script_contains_all_reason_specificity_entries() -> None:
    script = build_redis_merge_lua_script()
    for reason in REASON_SPECIFICITY:
        assert f"{reason}=" in script


def test_metadata_score_int_preserves_tuple_ordering() -> None:
    now_ms = 1_700_000_000_000
    pairs = [
        (
            CooldownMetadata("billing_credits_depleted", "hard", now_ms),
            CooldownMetadata("terminal_unknown", "hard", now_ms),
        ),
        (
            CooldownMetadata("rate_limit", "soft", now_ms),
            CooldownMetadata("cooldown", "soft", now_ms),
        ),
    ]
    for left, right in pairs:
        left_tuple = metadata_score_tuple(left)
        right_tuple = metadata_score_tuple(right)
        left_int = metadata_score_int(left)
        right_int = metadata_score_int(right)
        assert (left_tuple > right_tuple) == (left_int > right_int)
