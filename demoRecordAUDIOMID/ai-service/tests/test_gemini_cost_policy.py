from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import httpx
import pytest

from app.config import Settings
from app.services.ai_analyzer import AIAnalyzer
from app.services.analysis_errors import AnalysisUnavailableError
from app.services.gemini_client import GeminiCallResult, GeminiClient
from app.services.gemini_cost_guard import GeminiCostGuard
from app.services.gemini_key_cooldown_store import (
    SUPPORTED_GEMINI_GENERATION_MODELS,
)
from app.services.gemini_key_manager import GeminiKeyEntry, GeminiKeyManager
from app.services.gemini_policy import (
    GeminiAttemptBudget,
    GeminiWorkload,
    parse_project_groups,
)
from app.services.gemini_shared_state_contracts import (
    PendingOperationStatus,
    SharedScopeSnapshot,
    SharedStateScope,
)
from app.services.gemini_shared_state_store import InMemoryV2GeminiKeyCooldownStore
from app.services import meeting_chat_service


class _AtomicCostRedis:
    def __init__(self, *, fail: bool = False):
        self.fail = fail
        self.values: dict[str, int | str] = {}
        self.lock = threading.Lock()

    def eval(self, script, key_count, *values):
        if self.fail:
            raise TimeoutError("offline")
        keys = values[:key_count]
        args = values[key_count:]
        with self.lock:
            if "daily_request_limit" in script:
                if keys[4] in self.values:
                    return [0, b"duplicate"]
                request_limit, reanalyze_limit, token_limit, active_limit = map(
                    int, args[:4]
                )
                is_reanalysis = int(args[4]) == 1
                estimate = int(args[5])
                if int(self.values.get(keys[0], 0)) >= request_limit:
                    return [0, b"daily_request_limit"]
                if (
                    is_reanalysis
                    and int(self.values.get(keys[1], 0)) >= reanalyze_limit
                ):
                    return [0, b"daily_reanalysis_limit"]
                if int(self.values.get(keys[2], 0)) + estimate > token_limit:
                    return [0, b"daily_token_limit"]
                if int(self.values.get(keys[3], 0)) >= active_limit:
                    return [0, b"concurrency_limit"]
                self.values[keys[4]] = "pending"
                self.values[keys[0]] = int(self.values.get(keys[0], 0)) + 1
                if is_reanalysis:
                    self.values[keys[1]] = int(self.values.get(keys[1], 0)) + 1
                self.values[keys[2]] = int(self.values.get(keys[2], 0)) + estimate
                self.values[keys[3]] = int(self.values.get(keys[3], 0)) + 1
                return [1, b"allowed"]
            success = bool(int(args[0]))
            if self.values.get(keys[1]) != "pending":
                return int(self.values.get(keys[0], 0))
            if success:
                self.values[keys[1]] = "completed"
            else:
                self.values.pop(keys[1], None)
            active = int(self.values.get(keys[0], 0))
            if active <= 1:
                self.values.pop(keys[0], None)
                return 0
            self.values[keys[0]] = active - 1
            return active - 1


def _cost_guard(redis_client, *, requests=20, concurrent=2):
    return GeminiCostGuard(
        redis_client,
        namespace="test",
        daily_request_limit_per_user=requests,
        daily_reanalysis_limit_per_meeting=3,
        daily_token_limit_per_user=100_000,
        max_concurrent_requests=concurrent,
    )


def test_default_model_and_cost_routing_configuration():
    settings = Settings(_env_file=None)

    assert settings.gemini_model == "gemini-3.1-flash-lite"
    assert settings.gemini_analysis_model == "gemini-3.1-flash-lite"
    assert settings.gemini_thinking_level == "low"
    assert settings.gemini_temperature == 0.2
    assert settings.gemini_chat_max_output_tokens == 1200
    assert settings.gemini_structured_analysis_max_output_tokens == 4096
    assert settings.gemini_max_total_attempts == 2
    assert settings.gemini_cross_project_failover_enabled is False
    assert settings.gemini_model_fallback_enabled is False
    assert settings.gemini_pro_fallback_enabled is False
    assert settings.gemini_cost_guard_namespace == "development-audiomind"


def test_flash_lite_is_allowlisted_and_unknown_model_creates_no_v2_state():
    assert "gemini-3.1-flash-lite" in SUPPORTED_GEMINI_GENERATION_MODELS
    store = InMemoryV2GeminiKeyCooldownStore(
        namespace="test", allowed_aliases=frozenset({"primary"})
    )
    scope = SharedStateScope(
        alias="primary", fingerprint="a" * 12, model="unknown/模型"
    )

    result = store.mark_model_unsupported_cas(scope, expected_revision=0)

    assert result.status is PendingOperationStatus.REJECTED
    assert store._state_raw == {}
    assert store._revisions == {}


def test_v2_transport_failure_preserves_local_protected_state():
    class _UnavailableV2Store(InMemoryV2GeminiKeyCooldownStore):
        def read_scope_snapshot(self, scope, *, model=""):
            del model
            return SharedScopeSnapshot(
                scope=scope,
                success=False,
                error=TimeoutError("offline"),
            )

    store = _UnavailableV2Store(
        namespace="failure-fallback-test",
        allowed_aliases=frozenset({"primary"}),
    )
    manager = GeminiKeyManager(
        [GeminiKeyEntry(alias="primary", secret="fake-primary")],
        cooldown_store=store,
    )
    manager.hard_cooldown_key(
        "primary",
        seconds=900,
        reason="billing_credits_depleted",
    )

    assert manager.select_key(model="gemini-3.1-flash-lite").available is False


def test_missing_project_groups_share_one_safe_project_and_validation_is_total():
    assert parse_project_groups("", aliases=["primary", "backup1"]) == {
        "primary": "default-project",
        "backup1": "default-project",
    }
    with pytest.raises(ValueError):
        parse_project_groups("primary:project-a", aliases=["primary", "backup1"])


def test_attempt_budget_is_monotonic_across_all_retry_classes():
    budget = GeminiAttemptBudget(max_total_attempts=2)
    assert budget.reserve() == 1
    assert budget.reserve() == 2
    assert budget.reserve() is None
    assert budget.attempts_used == 2
    assert budget.remaining == 0


def test_cost_guard_atomically_suppresses_duplicate_across_instances():
    redis_client = _AtomicCostRedis()
    guards = [_cost_guard(redis_client, concurrent=10) for _ in range(10)]

    def reserve(index):
        return guards[index].reserve(
            user_id=7,
            meeting_id=42,
            operation_id="same-analysis-root",
            estimated_tokens=100,
            is_reanalysis=True,
        )

    with ThreadPoolExecutor(max_workers=10) as pool:
        results = list(pool.map(reserve, range(10)))

    assert sum(result.allowed for result in results) == 1
    assert sum(result.duplicate for result in results) == 9


def test_cost_guard_scopes_idempotency_per_user_and_limits_concurrency_globally():
    redis_client = _AtomicCostRedis()
    guard = _cost_guard(redis_client, concurrent=1)

    first_user = guard.reserve(
        user_id=1,
        meeting_id=42,
        operation_id="same-client-token",
        estimated_tokens=10,
        is_reanalysis=False,
    )
    second_user_while_active = guard.reserve(
        user_id=2,
        meeting_id=42,
        operation_id="same-client-token",
        estimated_tokens=10,
        is_reanalysis=False,
    )
    guard.release(first_user, success=True)
    second_user_after_release = guard.reserve(
        user_id=2,
        meeting_id=42,
        operation_id="same-client-token",
        estimated_tokens=10,
        is_reanalysis=False,
    )

    assert first_user.allowed is True
    assert second_user_while_active.reason == "concurrency_limit"
    assert second_user_while_active.duplicate is False
    assert second_user_after_release.allowed is True


def test_cost_guard_daily_limit_is_shared_and_redis_failure_fails_closed():
    redis_client = _AtomicCostRedis()
    first = _cost_guard(redis_client, requests=2, concurrent=5)
    second = _cost_guard(redis_client, requests=2, concurrent=5)
    reservations = [
        first.reserve(
            user_id=9,
            meeting_id=meeting,
            operation_id=f"operation-{meeting}",
            estimated_tokens=10,
            is_reanalysis=False,
        )
        for meeting in (1, 2)
    ]
    for reservation in reservations:
        first.release(reservation)
    denied = second.reserve(
        user_id=9,
        meeting_id=3,
        operation_id="operation-3",
        estimated_tokens=10,
        is_reanalysis=False,
    )
    unavailable = _cost_guard(_AtomicCostRedis(fail=True)).reserve(
        user_id=9,
        meeting_id=4,
        operation_id="operation-4",
        estimated_tokens=10,
        is_reanalysis=False,
    )

    assert denied.allowed is False
    assert denied.reason == "daily_request_limit"
    assert unavailable.allowed is False
    assert unavailable.reason == "guard_unavailable"


def test_cost_guard_releases_failed_operation_but_retains_success_marker():
    redis_client = _AtomicCostRedis()
    guard = _cost_guard(redis_client)

    failed = guard.reserve(
        user_id=11,
        meeting_id=1,
        operation_id="retryable-root",
        estimated_tokens=10,
        is_reanalysis=False,
    )
    guard.release(failed, success=False)
    retried = guard.reserve(
        user_id=11,
        meeting_id=1,
        operation_id="retryable-root",
        estimated_tokens=10,
        is_reanalysis=False,
    )
    guard.release(retried, success=True)
    guard.release(retried, success=True)
    duplicate = guard.reserve(
        user_id=11,
        meeting_id=1,
        operation_id="retryable-root",
        estimated_tokens=10,
        is_reanalysis=False,
    )

    assert failed.allowed is True
    assert retried.allowed is True
    assert duplicate.allowed is False
    assert duplicate.duplicate is True


class _Response:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self.body = body
        self.headers = {}

    def json(self):
        return self.body


class _HTTP:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def post(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def _client(outcomes, *, groups=None, cross=False, aliases=("primary", "backup1")):
    manager = GeminiKeyManager(
        [GeminiKeyEntry(alias=alias, secret=f"fake-{alias}") for alias in aliases],
        project_groups=groups,
    )
    http = _HTTP(outcomes)
    client = GeminiClient(
        manager,
        max_attempts=2,
        cross_project_failover_enabled=cross,
        backoff_base_ms=0,
        backoff_max_ms=0,
        backoff_jitter=False,
        fail_fast_seconds=0,
        http_client_factory=lambda **_: http,
        sleep=lambda _: None,
    )
    return client, http


def test_billing_machine_reason_is_one_attempt_and_blocks_same_project():
    billing = _Response(
        429,
        {
            "error": {
                "status": "RESOURCE_EXHAUSTED",
                "message": "Project cannot serve this request",
                "details": [
                    {
                        "reason": "BILLING_CREDITS_DEPLETED",
                        "quotaMetric": "billing_credits",
                    }
                ],
            }
        },
    )
    client, http = _client([billing, _Response(200, {})])

    with pytest.raises(AnalysisUnavailableError) as caught:
        client.post_json(
            url="https://example.test/v1beta/models/gemini-3.1-flash-lite:generateContent",
            payload={},
            timeout_seconds=10,
            model="gemini-3.1-flash-lite",
        )

    assert caught.value.error_code == "GEMINI_BILLING_CREDITS_DEPLETED"
    assert caught.value.retryable is False
    assert len(http.calls) == 1


def test_cross_project_failover_is_disabled_by_default():
    billing = _Response(
        429,
        {"error": {"message": "prepayment credits are depleted"}},
    )
    client, http = _client(
        [billing, _Response(200, {})],
        groups={"primary": "project-a", "backup1": "project-b"},
    )

    with pytest.raises(AnalysisUnavailableError):
        client.post_json(
            url="https://example.test/v1beta/models/gemini-3.1-flash-lite:generateContent",
            payload={},
            timeout_seconds=10,
        )
    assert len(http.calls) == 1


def test_single_key_timeout_retries_same_alias_within_global_budget():
    client, http = _client(
        [httpx.ReadTimeout("timeout"), _Response(200, {"ok": True})],
        aliases=("primary",),
    )
    result = client.post_json(
        url="https://example.test/v1beta/models/gemini-3.1-flash-lite:generateContent",
        payload={},
        timeout_seconds=10,
    )

    assert result.key_alias == "primary"
    assert result.network_attempts == 2
    assert len(http.calls) == 2


class _CaptureGeminiClient:
    def __init__(self):
        self.payloads = []

    def post_json(self, **kwargs):
        self.payloads.append(kwargs["payload"])
        response = _Response(
            200,
            {
                "candidates": [
                    {
                        "finishReason": "STOP",
                        "content": {"parts": [{"text": "ok"}]},
                    }
                ],
                "usageMetadata": {
                    "promptTokenCount": 10,
                    "candidatesTokenCount": 2,
                    "thoughtsTokenCount": 1,
                    "totalTokenCount": 13,
                },
            },
        )
        budget = kwargs["attempt_budget"]
        assert budget.reserve() is not None
        return GeminiCallResult(
            response=response,
            key_alias="primary",
            project_group="project-a",
            network_attempts=budget.attempts_used,
            root_operation_id=budget.root_operation_id,
        )


def test_workload_budgets_and_low_thinking_are_sent_without_extra_request():
    analyzer = AIAnalyzer(
        provider="gemini",
        api_key="fake-key",
        model="gemini-3.1-flash-lite",
        summary_model="gemini-3.1-flash-lite",
    )
    capture = _CaptureGeminiClient()
    analyzer.gemini_client = capture

    analyzer._call_gemini_text(
        prompt="bounded chat context",
        system_prompt="system",
        model=analyzer.summary_model,
        temperature=analyzer.gemini_temperature,
        workload=GeminiWorkload.CHAT,
    )
    analyzer._call_gemini_text(
        prompt="structured transcript",
        system_prompt="system",
        model=analyzer.model,
        temperature=analyzer.gemini_temperature,
        response_json=True,
        workload=GeminiWorkload.STRUCTURED_ANALYSIS,
    )

    chat_config = capture.payloads[0]["generationConfig"]
    structured_config = capture.payloads[1]["generationConfig"]
    assert chat_config["maxOutputTokens"] == 1200
    assert structured_config["maxOutputTokens"] == 4096
    assert chat_config["thinkingConfig"] == {"thinkingLevel": "low"}
    assert chat_config["temperature"] == 0.2
    assert len(capture.payloads) == 2


def test_production_generation_path_selects_validates_and_calls_fake_http_once():
    store = InMemoryV2GeminiKeyCooldownStore(
        namespace="production-path-test",
        allowed_aliases=frozenset({"primary"}),
    )
    manager = GeminiKeyManager(
        [GeminiKeyEntry(alias="primary", secret="fake-primary")],
        project_groups={"primary": "project-a"},
        cooldown_store=store,
    )
    http = _HTTP(
        [
            _Response(
                200,
                {
                    "candidates": [
                        {
                            "finishReason": "STOP",
                            "content": {"parts": [{"text": "bounded answer"}]},
                        }
                    ],
                    "usageMetadata": {
                        "promptTokenCount": 6,
                        "candidatesTokenCount": 2,
                        "totalTokenCount": 8,
                    },
                },
            )
        ]
    )
    analyzer = AIAnalyzer(
        provider="gemini",
        api_key="fake-primary",
        model="gemini-3.1-flash-lite",
        summary_model="gemini-3.1-flash-lite",
        gemini_max_attempts=2,
    )
    analyzer.gemini_key_manager = manager
    analyzer.gemini_client = GeminiClient(
        manager,
        max_attempts=2,
        fail_fast_seconds=0,
        backoff_base_ms=0,
        backoff_max_ms=0,
        backoff_jitter=False,
        http_client_factory=lambda **_: http,
        sleep=lambda _: None,
    )

    result = analyzer._call_gemini_text(
        prompt="retrieved evidence only",
        system_prompt="safe system instruction",
        model="gemini-3.1-flash-lite",
        temperature=0.2,
        max_output_tokens=1200,
        workload=GeminiWorkload.CHAT,
    )

    assert result == "bounded answer"
    assert len(http.calls) == 1
    assert http.calls[0][1]["headers"]["x-goog-api-key"] == "fake-primary"


def test_chat_uses_only_bounded_retrieved_context_not_full_transcript(monkeypatch):
    captured = {}

    class _Analyzer:
        summary_model = "gemini-3.1-flash-lite"
        gemini_temperature = 0.2
        chat_max_output_tokens = 1200

        def _call_gemini_text(self, **kwargs):
            captured.update(kwargs)
            return json.dumps({"answer": "ok", "source_segments": []})

    monkeypatch.setattr(
        meeting_chat_service, "build_analysis_analyzer", lambda settings: _Analyzer()
    )
    settings = SimpleNamespace(
        gemini_rag_top_k=2,
        gemini_rag_context_max_tokens=80,
        gemini_chat_history_max_tokens=20,
        gemini_cost_guard_enabled=False,
    )
    result = meeting_chat_service.answer_meeting_question(
        settings=settings,
        question="What was decided?",
        summary="short summary",
        transcript_excerpt="FULL_TRANSCRIPT_MUST_NOT_BE_SENT",
        analysis={"private": "FULL_ANALYSIS_MUST_NOT_BE_SENT"},
        source_segments=[
            {"segmentId": "s1", "speaker": "A", "startTime": 1, "quote": "decision"},
            {"segmentId": "s1", "speaker": "A", "startTime": 1, "quote": "decision"},
            {"segmentId": "s2", "speaker": "B", "startTime": 2, "quote": "follow up"},
        ],
    )

    assert result["provider"] == "gemini"
    assert "FULL_TRANSCRIPT_MUST_NOT_BE_SENT" not in captured["prompt"]
    assert "FULL_ANALYSIS_MUST_NOT_BE_SENT" not in captured["prompt"]
    assert captured["max_output_tokens"] == 1200
    assert captured["workload"] is GeminiWorkload.CHAT
    assert captured["prompt"].count("decision") == 1
