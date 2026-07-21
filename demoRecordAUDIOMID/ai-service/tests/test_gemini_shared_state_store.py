"""V2 shared-state store tests (STORE-01..STORE-14)."""

from __future__ import annotations


from app.services.gemini_key_cooldown_store import key_fingerprint
from app.services.gemini_shared_state_contracts import (
    PendingOperationStatus,
    SharedStateScope,
    SharedStoreErrorType,
)
from app.services.gemini_shared_state_store import InMemoryV2GeminiKeyCooldownStore


class FakeWallClock:
    def __init__(self, start_ms: int = 1_700_000_000_000) -> None:
        self._ms = int(start_ms)

    def now_ms(self) -> int:
        return self._ms

    def advance_ms(self, delta: int) -> None:
        self._ms += int(delta)


def _scope(alias: str = "primary") -> SharedStateScope:
    return SharedStateScope(
        alias=alias,
        fingerprint=key_fingerprint("fake-primary-key"),
    )


def _store(
    *, aliases: frozenset[str] | None = None
) -> InMemoryV2GeminiKeyCooldownStore:
    clock = FakeWallClock()
    return InMemoryV2GeminiKeyCooldownStore(
        namespace="offline-test:ai-service",
        allowed_aliases=aliases or frozenset({"primary", "backup1"}),
        wall_clock_ms=clock.now_ms,
    )


def test_store_01_apply_cooldown_cas_applied() -> None:
    store = _store()
    scope = _scope()
    result = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=30_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert result.status is PendingOperationStatus.APPLIED
    assert result.success is True
    assert result.revision == 1
    snapshot = store.read_scope_snapshot(scope)
    assert snapshot.cooldown_state is not None
    assert snapshot.cooldown_revision == 1


def test_store_02_wrong_expected_revision_rejected() -> None:
    store = _store()
    scope = _scope()
    store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=30_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    result = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=30_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert result.status is PendingOperationStatus.REJECTED
    assert result.success is False


def test_store_03_clear_cooldown_writes_tombstone() -> None:
    store = _store()
    scope = _scope()
    applied = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=30_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    cleared = store.clear_cooldown_cas(
        scope,
        expected_revision=int(applied.revision or 0),
    )
    assert cleared.status is PendingOperationStatus.APPLIED
    snapshot = store.read_scope_snapshot(scope)
    assert snapshot.cooldown_state is None
    assert snapshot.cooldown_revision == 2


def test_store_04_mark_model_unsupported_cas() -> None:
    store = _store()
    scope = SharedStateScope(
        alias="primary",
        fingerprint=key_fingerprint("fake-primary-key"),
        model="gemini-2.5-flash",
    )
    result = store.mark_model_unsupported_cas(scope, expected_revision=0)
    assert result.status is PendingOperationStatus.APPLIED
    snapshot = store.read_scope_snapshot(scope, model="gemini-2.5-flash")
    assert snapshot.model_unsupported is True
    assert snapshot.model_revision == 1


def test_store_05_clear_model_unsupported_cas() -> None:
    store = _store()
    scope = SharedStateScope(
        alias="primary",
        fingerprint=key_fingerprint("fake-primary-key"),
        model="gemini-2.5-flash",
    )
    marked = store.mark_model_unsupported_cas(scope, expected_revision=0)
    cleared = store.clear_model_unsupported_cas(
        scope, expected_revision=int(marked.revision or 0)
    )
    assert cleared.status is PendingOperationStatus.APPLIED
    snapshot = store.read_scope_snapshot(scope, model="gemini-2.5-flash")
    assert snapshot.model_unsupported is False


def test_store_06_merge_from_shared_stronger() -> None:
    store = _store()
    scope = _scope()
    store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=120_000,
        reason="billing_credits_depleted",
        cooldown_type="hard",
    )
    result = store.apply_cooldown_cas(
        scope,
        expected_revision=1,
        remaining_ms=30_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert result.status is PendingOperationStatus.APPLIED
    assert result.merged_from_shared_stronger is True
    assert result.final_remaining_ms is not None
    assert result.final_remaining_ms > 30_000


def test_store_07_invalid_scope_rejected() -> None:
    store = _store(aliases=frozenset({"primary"}))
    scope = SharedStateScope(
        alias="unknown",
        fingerprint=key_fingerprint("fake-unknown-key"),
    )
    result = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=30_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert result.status is PendingOperationStatus.REJECTED
    assert result.error_type is SharedStoreErrorType.INVALID_SCOPE


def test_store_08_negative_remaining_rejected() -> None:
    store = _store()
    scope = _scope()
    result = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=-1,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert result.status is PendingOperationStatus.REJECTED
    assert result.error_type is SharedStoreErrorType.INVALID_ARGUMENT


def test_store_09_read_scope_snapshot() -> None:
    store = _store()
    scope = _scope()
    store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=45_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    snapshot = store.read_scope_snapshot(scope)
    assert snapshot.cooldown_revision == 1
    assert snapshot.cooldown_digest is not None
    assert snapshot.cooldown_state is not None


def test_store_10_success_only_on_applied() -> None:
    store = _store()
    scope = _scope()
    store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=30_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    rejected = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=30_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert rejected.success is False
    assert rejected.status is PendingOperationStatus.REJECTED


def test_store_11_status_only_contract() -> None:
    store = _store()
    scope = _scope()
    result = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=30_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    assert hasattr(result, "status")
    assert result.success == (result.status is PendingOperationStatus.APPLIED)


def test_store_12_invalid_scope_does_not_create_keys() -> None:
    store = _store(aliases=frozenset({"primary"}))
    scope = SharedStateScope(
        alias="rogue",
        fingerprint=key_fingerprint("fake-rogue-key"),
    )
    store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=30_000,
        reason="rate_limit",
        cooldown_type="soft",
    )
    snapshot = store.read_scope_snapshot(scope)
    assert snapshot.cooldown_revision == 0
    assert snapshot.cooldown_state is None


def test_store_13_expected_digest_with_missing_state_superseded() -> None:
    store = _store()
    scope = _scope()
    result = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=30_000,
        reason="rate_limit",
        cooldown_type="soft",
        expected_digest="deadbeef" * 5,
    )
    assert result.status is PendingOperationStatus.SUPERSEDED
    assert result.success is False


def test_store_14_missing_state_without_digest_allowed_on_ledger_match() -> None:
    store = _store()
    scope = _scope()
    result = store.apply_cooldown_cas(
        scope,
        expected_revision=0,
        remaining_ms=30_000,
        reason="rate_limit",
        cooldown_type="soft",
        expected_digest=None,
    )
    assert result.status is PendingOperationStatus.APPLIED
    assert result.revision == 1
