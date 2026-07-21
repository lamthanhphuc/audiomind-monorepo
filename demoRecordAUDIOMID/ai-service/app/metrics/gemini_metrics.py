from __future__ import annotations

from dataclasses import dataclass

from prometheus_client import Counter

_LOGICAL_OPERATIONS = Counter(
    "gemini_requests_total", "Gemini logical operations started.", ["workload"]
)
_NETWORK_ATTEMPTS = Counter(
    "gemini_network_attempts_total",
    "Actual Gemini generateContent HTTP attempts.",
    ["workload", "model"],
)
_SUCCESS = Counter(
    "gemini_success_total",
    "Successful Gemini model generations.",
    ["workload", "model"],
)
_FAILURE = Counter(
    "gemini_failure_total", "Terminal Gemini logical operation failures.", ["reason"]
)
_INPUT_TOKENS = Counter("gemini_input_tokens_total", "Gemini prompt tokens.")
_OUTPUT_TOKENS = Counter("gemini_output_tokens_total", "Gemini candidate tokens.")
_THINKING_TOKENS = Counter("gemini_thinking_tokens_total", "Gemini thinking tokens.")
_CACHED_TOKENS = Counter("gemini_cached_tokens_total", "Gemini cached prompt tokens.")
_RETRY = Counter("gemini_retry_total", "Gemini retries by reason.", ["reason"])
_MAX_TOKENS_RETRY = Counter(
    "gemini_max_tokens_retry_total", "Controlled MAX_TOKENS retries."
)
_FAILOVER = Counter("gemini_failover_total", "Gemini key failovers.")
_CACHE_HIT = Counter("gemini_cache_hit_total", "Gemini analysis cache hits.")
_DUPLICATE = Counter(
    "gemini_duplicate_suppressed_total", "Duplicate Gemini operations suppressed."
)
_BILLING_BLOCK = Counter(
    "gemini_billing_block_total", "Gemini operations blocked by project billing."
)


def _bounded(value: str, *, fallback: str = "unknown", length: int = 64) -> str:
    normalized = str(value or "").strip().lower()
    safe = "".join(
        ch for ch in normalized if ch.isascii() and (ch.isalnum() or ch in "._-")
    )
    return safe[:length] or fallback


def _count(value: object) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


@dataclass(frozen=True, slots=True)
class GeminiMetrics:
    def logical_operation(self, workload: str) -> None:
        _LOGICAL_OPERATIONS.labels(workload=_bounded(workload)).inc()

    def network_attempt(self, workload: str, model: str) -> None:
        _NETWORK_ATTEMPTS.labels(
            workload=_bounded(workload), model=_bounded(model)
        ).inc()

    def success(self, workload: str, model: str) -> None:
        _SUCCESS.labels(workload=_bounded(workload), model=_bounded(model)).inc()

    def failure(self, reason: str) -> None:
        _FAILURE.labels(reason=_bounded(reason)).inc()

    def usage(
        self,
        *,
        input_tokens: object = 0,
        output_tokens: object = 0,
        thinking_tokens: object = 0,
        cached_tokens: object = 0,
    ) -> None:
        _INPUT_TOKENS.inc(_count(input_tokens))
        _OUTPUT_TOKENS.inc(_count(output_tokens))
        _THINKING_TOKENS.inc(_count(thinking_tokens))
        _CACHED_TOKENS.inc(_count(cached_tokens))

    def retry(self, reason: str) -> None:
        _RETRY.labels(reason=_bounded(reason)).inc()

    def max_tokens_retry(self) -> None:
        _MAX_TOKENS_RETRY.inc()

    def failover(self) -> None:
        _FAILOVER.inc()

    def cache_hit(self) -> None:
        _CACHE_HIT.inc()

    def duplicate_suppressed(self) -> None:
        _DUPLICATE.inc()

    def billing_block(self) -> None:
        _BILLING_BLOCK.inc()


gemini_metrics = GeminiMetrics()
