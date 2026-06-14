from concurrent.futures import ThreadPoolExecutor

import pytest

from app.services.gemini_key_manager import (
    GeminiKeyConfigError,
    GeminiKeyManager,
    parse_gemini_api_keys,
)


class FakeClock:
    def __init__(self, now: float = 100.0):
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def test_single_key_backward_compatibility_uses_gemini_api_key():
    manager = GeminiKeyManager.from_config(
        gemini_api_key="single-test-key",
        gemini_api_keys="",
        multi_key_enabled=False,
        clock=FakeClock(),
    )

    selection = manager.select_key()

    assert selection.available
    assert selection.entry.alias == "primary"
    assert selection.entry.secret == "single-test-key"


def test_multi_key_json_parsing():
    entries = parse_gemini_api_keys(
        '[{"alias":"primary","key":"key-a"},{"alias":"backup1","key":"key-b"}]'
    )

    assert [(entry.alias, entry.secret) for entry in entries] == [
        ("primary", "key-a"),
        ("backup1", "key-b"),
    ]


def test_comma_alias_key_parsing():
    entries = parse_gemini_api_keys("primary:key-a,backup1:key-b")

    assert [(entry.alias, entry.secret) for entry in entries] == [
        ("primary", "key-a"),
        ("backup1", "key-b"),
    ]


@pytest.mark.parametrize(
    ("raw", "secret"),
    [
        ("Primary:key-a", "key-a"),
        ("primary:key-a,primary:key-b", "key-b"),
        ("primary:key-a,backup:key-a", "key-a"),
        ("primary:", "primary:"),
        ("not-json", "not-json"),
    ],
)
def test_invalid_parser_inputs_are_rejected_safely(raw, secret):
    with pytest.raises(GeminiKeyConfigError) as exc_info:
        parse_gemini_api_keys(raw)

    rendered = str(exc_info.value)
    assert secret not in rendered
    assert raw not in rendered


def test_key_entry_repr_does_not_expose_secret():
    entry = parse_gemini_api_keys("primary:super-secret-key")[0]

    rendered = repr(entry)

    assert "primary" in rendered
    assert "super-secret-key" not in rendered


def test_round_robin_selection_skips_cooled_down_keys():
    clock = FakeClock()
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
        clock=clock,
    )

    assert manager.select_key().entry.alias == "primary"
    manager.cooldown_key("backup1", seconds=30, reason="rate_limit")
    assert manager.select_key().entry.alias == "primary"


def test_cooldown_expiry_makes_key_eligible_again():
    clock = FakeClock()
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
        clock=clock,
    )

    manager.cooldown_key("primary", seconds=10, reason="rate_limit")
    assert manager.select_key().entry.alias == "backup1"

    clock.advance(11)

    assert manager.select_key().entry.alias == "primary"


def test_hard_cooldown_makes_key_ineligible():
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
        clock=FakeClock(),
    )

    manager.hard_cooldown_key("primary", seconds=900, reason="invalid_key")

    assert manager.select_key().entry.alias == "backup1"


def test_all_keys_exhausted_returns_retry_after_seconds():
    clock = FakeClock()
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b",
        multi_key_enabled=True,
        clock=clock,
    )
    manager.cooldown_key("primary", seconds=20, reason="rate_limit")
    manager.cooldown_key("backup1", seconds=5, reason="rate_limit")

    selection = manager.select_key()

    assert not selection.available
    assert selection.retry_after_seconds == 5
    assert selection.cooldown_active == 2


def test_selection_is_thread_safe():
    manager = GeminiKeyManager.from_config(
        gemini_api_key="",
        gemini_api_keys="primary:key-a,backup1:key-b,backup2:key-c",
        multi_key_enabled=True,
        clock=FakeClock(),
    )

    with ThreadPoolExecutor(max_workers=8) as executor:
        aliases = list(executor.map(lambda _: manager.select_key().entry.alias, range(60)))

    assert set(aliases) == {"primary", "backup1", "backup2"}
