import random
import re
import socket
import time
from dataclasses import dataclass
from enum import Enum
from math import ceil
from typing import Any, Callable
from urllib.parse import urlparse, urlunparse

import httpx
from loguru import logger

from app.metrics.gemini_metrics import gemini_metrics
from app.services.analysis_errors import (
    AnalysisConfigError,
    AnalysisProviderError,
    AnalysisRateLimitError,
    AnalysisUnavailableError,
)
from app.services.gemini_key_manager import GeminiKeyManager
from app.services.gemini_policy import GeminiAttemptBudget

MAX_SAME_ALIAS_TRANSIENT_RETRIES = 2


class GeminiKeyFailureReason(str, Enum):
    TRANSIENT_RATE_LIMIT = "transient_rate_limit"
    BILLING_CREDITS_DEPLETED = "billing_credits_depleted"
    FREE_TIER_TOKEN_QUOTA_EXHAUSTED = "free_tier_token_quota_exhausted"
    DAILY_QUOTA_EXHAUSTED = "daily_quota_exhausted"
    MODEL_UNAVAILABLE = "model_unavailable"
    AUTH_ERROR = "auth_error"
    TRANSIENT_PROVIDER_ERROR = "transient_provider_error"
    NETWORK_ERROR = "network_error"
    INVALID_REQUEST = "invalid_request"
    REGION_BLOCKED = "region_blocked"


@dataclass(frozen=True)
class GeminiCallResult:
    """HTTP success for one Gemini call, with the key alias that served it."""

    response: httpx.Response
    key_alias: str
    project_group: str
    network_attempts: int
    root_operation_id: str


_BILLING_CREDITS_MARKERS = (
    "prepayment credits are depleted",
    "prepaid credits are depleted",
    "prepaid credits depleted",
    "billing credits exhausted",
    "billing account has no available credits",
    "credits are depleted",
    "insufficient credits",
)

_FREE_TIER_QUOTA_MARKERS = (
    "generate_content_free_tier_input_token_count",
    "generate_content_free_tier_output_token_count",
    "generate_content_free_tier_requests",
    "free_tier_input_token",
    "free_tier_requests",
    "free tier quota",
)

_DAILY_QUOTA_MARKERS = (
    "requests_per_day",
    "requests per day",
    "per-day",
    "per day quota",
    "daily quota",
)

_MODEL_UNAVAILABLE_MARKERS = (
    "is no longer available",
    "is not available to new users",
    "not available to new users",
    "model not found",
    "not supported for generatecontent",
    "not supported for generate_content",
    "unavailable for this project",
    "unavailable for this api key",
    "unavailable for this key",
)

_MODEL_UNAVAILABLE_PATTERNS = (
    re.compile(
        r"model[s]?\s*/?\s*[\w.\-]+.*(no longer available|not available|not found|not supported)",
        re.IGNORECASE,
    ),
    re.compile(
        r"models/[\w.\-]+\s+is\s+not\s+found",
        re.IGNORECASE,
    ),
)


def _bounded_retry_after(response: Any, fallback_seconds: float) -> float:
    retry_after = ""
    headers = getattr(response, "headers", None) or {}
    try:
        retry_after = str(headers.get("Retry-After", "")).strip()
    except Exception:
        retry_after = ""
    if retry_after:
        try:
            return max(0.0, float(retry_after))
        except ValueError:
            pass
    return max(0.0, float(fallback_seconds or 0.0))


def _response_error_message(response: Any) -> str:
    try:
        body = response.json()
    except Exception:
        return ""
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or "").strip()
    return ""


def _response_body_text(response: Any) -> str:
    message = _response_error_message(response)
    try:
        body = response.json()
    except Exception:
        body = None
    chunks = [message]
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            chunks.append(str(error.get("status") or ""))
            details = error.get("details")
            if isinstance(details, list):
                for detail in details:
                    if not isinstance(detail, dict):
                        continue
                    chunks.append(str(detail.get("quotaMetric") or ""))
                    chunks.append(str(detail.get("reason") or ""))
                    metadata = detail.get("metadata")
                    if isinstance(metadata, dict):
                        chunks.append(str(metadata.get("quota_metric") or ""))
                        chunks.append(str(metadata.get("quotaMetric") or ""))
            try:
                chunks.append(str(body)[:2000])
            except Exception:
                pass
    return " ".join(part for part in chunks if part).lower()


def _sanitize_quota_metric(text: str) -> str:
    lowered = str(text or "").lower()
    for marker in _FREE_TIER_QUOTA_MARKERS:
        if marker in lowered:
            return marker
    if "rpm" in lowered or "requests per minute" in lowered:
        return "rpm"
    if "tpm" in lowered or "tokens per minute" in lowered:
        return "tpm"
    if "rpd" in lowered or "requests per day" in lowered:
        return "rpd"
    if "billing" in lowered or "credit" in lowered:
        return "billing_credits"
    return ""


def _is_region_blocked_message(message: str) -> bool:
    lowered = str(message or "").strip().lower()
    return "location is not supported" in lowered


def is_model_unavailable_response(response: Any) -> bool:
    """True only when status + body indicate the *model* is unavailable for this key."""
    status_code = int(getattr(response, "status_code", 0) or 0)
    if status_code not in {400, 404}:
        return False
    message = _response_error_message(response)
    if not message:
        return False
    lowered = message.strip().lower()
    # Never treat bare NOT_FOUND / empty / generic path 404 as model unavailable.
    if lowered in {"not found", "not_found", ""}:
        return False
    if any(pattern.search(message) for pattern in _MODEL_UNAVAILABLE_PATTERNS):
        return True
    has_model_token = "model" in lowered or "models/" in lowered
    if not has_model_token:
        return False
    return any(marker in lowered for marker in _MODEL_UNAVAILABLE_MARKERS)


def _is_model_unavailable_message(message: str, *, reason: str = "") -> bool:
    """Legacy helper kept for call sites; prefer is_model_unavailable_response."""
    del reason  # reason alone must not classify model unavailable
    lowered = str(message or "").strip().lower()
    if not lowered:
        return False

    class _MsgResponse:
        status_code = 404

        def json(self):
            return {"error": {"message": message}}

    return is_model_unavailable_response(_MsgResponse())


def classify_http_429(response: Any) -> GeminiKeyFailureReason:
    haystack = _response_body_text(response)
    if "billing_credits" in haystack or any(
        marker in haystack for marker in _BILLING_CREDITS_MARKERS
    ):
        return GeminiKeyFailureReason.BILLING_CREDITS_DEPLETED
    if any(marker in haystack for marker in _DAILY_QUOTA_MARKERS):
        return GeminiKeyFailureReason.DAILY_QUOTA_EXHAUSTED
    if any(marker in haystack for marker in _FREE_TIER_QUOTA_MARKERS):
        return GeminiKeyFailureReason.FREE_TIER_TOKEN_QUOTA_EXHAUSTED
    return GeminiKeyFailureReason.TRANSIENT_RATE_LIMIT


def is_billing_depleted_response(response: Any) -> bool:
    haystack = _response_body_text(response)
    return "billing_credits" in haystack or any(
        marker in haystack for marker in _BILLING_CREDITS_MARKERS
    )


def extract_model_from_gemini_url(url: str) -> str:
    match = re.search(r"/models/([^/:]+)", str(url or ""))
    if not match:
        return ""
    return GeminiKeyManager.normalize_model_name(match.group(1))


_TERMINAL_KEY_FAILURE_REASONS = frozenset(
    {
        GeminiKeyFailureReason.BILLING_CREDITS_DEPLETED,
        GeminiKeyFailureReason.FREE_TIER_TOKEN_QUOTA_EXHAUSTED,
        GeminiKeyFailureReason.DAILY_QUOTA_EXHAUSTED,
        GeminiKeyFailureReason.MODEL_UNAVAILABLE,
        GeminiKeyFailureReason.AUTH_ERROR,
        GeminiKeyFailureReason.INVALID_REQUEST,
        GeminiKeyFailureReason.REGION_BLOCKED,
    }
)


def conclude_key_pool_failure(
    failures_by_alias: dict[str, GeminiKeyFailureReason],
    *,
    retry_after_seconds: int = 0,
    key_alias: str | None = None,
) -> AnalysisProviderError:
    """Map structured per-alias failures to a public error_code (no secrets)."""
    reasons = {reason for reason in failures_by_alias.values() if reason is not None}
    aliases = sorted(failures_by_alias.keys())
    summary = ",".join(f"{alias}={failures_by_alias[alias].value}" for alias in aliases)
    logger.warning(
        "GEMINI_KEY_POOL_CONCLUSION aliases={} summary={} distinctReasons={}",
        aliases,
        summary,
        sorted(r.value for r in reasons),
    )

    if not reasons:
        return AnalysisUnavailableError(
            "Gemini service unavailable",
            provider="gemini",
            error_code="GEMINI_UNAVAILABLE",
            retry_after_seconds=retry_after_seconds or None,
            key_alias=key_alias,
        )

    if reasons == {GeminiKeyFailureReason.MODEL_UNAVAILABLE}:
        return AnalysisUnavailableError(
            "Gemini model is unavailable for all configured API keys",
            provider="gemini",
            error_code="GEMINI_MODEL_UNAVAILABLE",
            retryable=False,
            key_alias=key_alias,
        )

    if reasons == {GeminiKeyFailureReason.TRANSIENT_RATE_LIMIT}:
        return AnalysisRateLimitError(
            "Gemini rate limit reached",
            provider="gemini",
            error_code="GEMINI_RATE_LIMITED",
            retry_after_seconds=retry_after_seconds or None,
            key_alias=key_alias,
        )

    if reasons == {GeminiKeyFailureReason.BILLING_CREDITS_DEPLETED}:
        return AnalysisUnavailableError(
            "Gemini billing credits are depleted for all configured API keys",
            provider="gemini",
            error_code="GEMINI_BILLING_CREDITS_DEPLETED",
            retryable=False,
            key_alias=key_alias,
        )

    if reasons == {GeminiKeyFailureReason.FREE_TIER_TOKEN_QUOTA_EXHAUSTED}:
        return AnalysisUnavailableError(
            "Gemini free-tier token quota exhausted for all configured API keys",
            provider="gemini",
            error_code="GEMINI_FREE_TIER_TOKEN_QUOTA_EXHAUSTED",
            retryable=False,
            key_alias=key_alias,
        )

    if reasons == {GeminiKeyFailureReason.DAILY_QUOTA_EXHAUSTED}:
        return AnalysisUnavailableError(
            "Gemini daily project quota is exhausted",
            provider="gemini",
            error_code="GEMINI_DAILY_QUOTA_EXHAUSTED",
            retryable=False,
            key_alias=key_alias,
        )

    if reasons == {GeminiKeyFailureReason.AUTH_ERROR}:
        return AnalysisConfigError(
            "Gemini API key was rejected or is missing",
            provider="gemini",
            error_code="GEMINI_INVALID_KEY",
            key_alias=key_alias,
        )

    if reasons <= {
        GeminiKeyFailureReason.TRANSIENT_PROVIDER_ERROR,
        GeminiKeyFailureReason.NETWORK_ERROR,
    }:
        return AnalysisUnavailableError(
            "Gemini service unavailable",
            provider="gemini",
            error_code="GEMINI_UNAVAILABLE",
            retry_after_seconds=retry_after_seconds or None,
            key_alias=key_alias,
        )

    # Mixed pool (e.g. rate-limit + model unavailable) must not collapse to 429.
    # Retry only when at least one failure reason is transient.
    all_terminal = bool(reasons) and reasons <= _TERMINAL_KEY_FAILURE_REASONS
    return AnalysisUnavailableError(
        "Gemini key pool unavailable due to mixed provider failures",
        provider="gemini",
        error_code="GEMINI_KEY_POOL_UNAVAILABLE",
        retryable=not all_terminal,
        retry_after_seconds=retry_after_seconds or None,
        key_alias=key_alias,
    )


_UNAVAILABLE_REASON_TO_FAILURE: dict[str, GeminiKeyFailureReason] = {
    "billing_credits_depleted": GeminiKeyFailureReason.BILLING_CREDITS_DEPLETED,
    "free_tier_token_quota_exhausted": (
        GeminiKeyFailureReason.FREE_TIER_TOKEN_QUOTA_EXHAUSTED
    ),
    "free_tier_quota_exhausted": GeminiKeyFailureReason.FREE_TIER_TOKEN_QUOTA_EXHAUSTED,
    "daily_quota_exhausted": GeminiKeyFailureReason.DAILY_QUOTA_EXHAUSTED,
    "model_unavailable": GeminiKeyFailureReason.MODEL_UNAVAILABLE,
    "invalid_key": GeminiKeyFailureReason.AUTH_ERROR,
    "auth_error": GeminiKeyFailureReason.AUTH_ERROR,
    "region_blocked": GeminiKeyFailureReason.REGION_BLOCKED,
    "invalid_request": GeminiKeyFailureReason.INVALID_REQUEST,
    "rate_limit": GeminiKeyFailureReason.TRANSIENT_RATE_LIMIT,
    "transient_rate_limit": GeminiKeyFailureReason.TRANSIENT_RATE_LIMIT,
    "network_error": GeminiKeyFailureReason.NETWORK_ERROR,
    "cooldown": GeminiKeyFailureReason.TRANSIENT_RATE_LIMIT,
}


def failure_reasons_from_unavailable(
    unavailable_reasons: dict[str, str],
) -> dict[str, GeminiKeyFailureReason]:
    """Map key-manager unavailable reason codes to structured failure reasons."""
    mapped: dict[str, GeminiKeyFailureReason] = {}
    for alias, reason in (unavailable_reasons or {}).items():
        key = str(alias or "").strip()
        code = str(reason or "").strip().lower()
        if not key or not code:
            continue
        mapped[key] = _UNAVAILABLE_REASON_TO_FAILURE.get(
            code, GeminiKeyFailureReason.TRANSIENT_PROVIDER_ERROR
        )
    return mapped


def _sanitize_proxy_for_log(proxy_url: str) -> str:
    """Return a proxy descriptor safe for logs (no credentials)."""
    raw = str(proxy_url or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw)
    host = (parsed.hostname or "").strip()
    if not host:
        return "<proxy>"
    port = f":{parsed.port}" if parsed.port else ""
    scheme = parsed.scheme or "http"
    if parsed.username:
        return f"{scheme}://***@{host}{port}"
    return f"{scheme}://{host}{port}"


class SafeProxyContext:
    """Holds proxy URL for transport while exposing a credential-free log label."""

    def __init__(self, proxy_url: str) -> None:
        self.proxy_url = _normalize_gemini_proxy_url(proxy_url)
        self.log_label = _sanitize_proxy_for_log(self.proxy_url)


def _normalize_gemini_proxy_url(proxy_url: str) -> str:
    raw = str(proxy_url or "").strip()
    if not raw:
        return ""

    parsed = urlparse(raw)
    host = (parsed.hostname or "").strip().lower()
    if host not in {"host.docker.internal", "host.containers.internal"}:
        return raw

    try:
        ipv4_host = socket.gethostbyname(host)
    except OSError:
        return raw

    port = parsed.port
    userinfo = ""
    if parsed.username:
        userinfo = parsed.username
        if parsed.password:
            userinfo = f"{userinfo}:{parsed.password}"
        userinfo = f"{userinfo}@"

    netloc = f"{userinfo}{ipv4_host}"
    if port:
        netloc = f"{netloc}:{port}"

    normalized = urlunparse(
        (
            parsed.scheme,
            netloc,
            parsed.path or "",
            parsed.params,
            parsed.query,
            parsed.fragment,
        )
    )
    if normalized != raw:
        logger.info(
            "GEMINI_HTTP_PROXY_NORMALIZED host={} ipv4={} port={}",
            host,
            ipv4_host,
            port,
        )
    return normalized


def resolve_http_client_factory(
    *,
    proxy: str | None = None,
    base_factory: Callable[..., Any] = httpx.Client,
) -> tuple[Callable[..., Any], str]:
    proxy_url = _normalize_gemini_proxy_url(str(proxy or "").strip())
    if not proxy_url:
        return base_factory, ""

    logger.info(
        "GEMINI_HTTP_PROXY_ENABLED proxy={}",
        _sanitize_proxy_for_log(proxy_url),
    )

    def factory(**kwargs: Any) -> httpx.Client:
        return base_factory(proxies=proxy_url, **kwargs)

    return factory, proxy_url


def _response_reason(response: Any) -> str:
    try:
        body = response.json()
    except Exception:
        body = None
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            status = str(error.get("status") or "").strip().upper()
            if status:
                return status
    status_code = int(getattr(response, "status_code", 0) or 0)
    if status_code == 429:
        return "RESOURCE_EXHAUSTED"
    if status_code in {401, 403}:
        return "PERMISSION_DENIED"
    if status_code == 400:
        return "INVALID_ARGUMENT"
    if status_code == 404:
        return "NOT_FOUND"
    if status_code == 504:
        return "DEADLINE_EXCEEDED"
    if status_code >= 500:
        return "UNAVAILABLE"
    return f"HTTP_{status_code}"


class GeminiClient:
    def __init__(
        self,
        key_manager: GeminiKeyManager,
        *,
        max_attempts: int = 3,
        cross_project_failover_enabled: bool = False,
        key_cooldown_seconds: float = 90.0,
        key_hard_cooldown_seconds: float = 900.0,
        backoff_base_ms: float = 500.0,
        backoff_max_ms: float = 10000.0,
        backoff_jitter: bool = True,
        fail_fast_seconds: float = 30.0,
        http_proxy: str = "",
        http_client_factory: Callable[..., Any] = httpx.Client,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        random_float: Callable[[float, float], float] = random.uniform,
    ):
        self.key_manager = key_manager
        self.max_attempts = max(1, int(max_attempts or 1))
        self.cross_project_failover_enabled = bool(cross_project_failover_enabled)
        self.key_cooldown_seconds = max(0.0, float(key_cooldown_seconds or 0.0))
        self.key_hard_cooldown_seconds = max(
            0.0, float(key_hard_cooldown_seconds or 0.0)
        )
        self.backoff_base_ms = max(0.0, float(backoff_base_ms or 0.0))
        self.backoff_max_ms = max(0.0, float(backoff_max_ms or 0.0))
        self.backoff_jitter = bool(backoff_jitter)
        self.fail_fast_seconds = max(0.0, float(fail_fast_seconds or 0.0))
        self.http_proxy = _normalize_gemini_proxy_url(http_proxy)
        self.proxy_context = SafeProxyContext(self.http_proxy)
        self.http_client_factory = http_client_factory
        self.sleep = sleep
        self.clock = clock
        self.random_float = random_float

    def post_json(
        self,
        *,
        url: str,
        payload: dict[str, Any],
        timeout_seconds: int,
        preferred_key_alias: str | None = None,
        model: str | None = None,
        attempt_budget: GeminiAttemptBudget | None = None,
        workload: str = "unknown",
    ) -> GeminiCallResult:
        started = self.clock()
        last_error: Exception | None = None
        failures_by_alias: dict[str, GeminiKeyFailureReason] = {}
        attempted_aliases: set[str] = set()
        same_alias_transient_retries: dict[str, int] = {}
        retry_after_seconds = 0
        sticky_alias = str(preferred_key_alias or "").strip() or None
        budget = attempt_budget or GeminiAttemptBudget(
            max_total_attempts=self.max_attempts,
            deadline_monotonic=(
                started + self.fail_fast_seconds if self.fail_fast_seconds > 0 else None
            ),
            clock=self.clock,
        )
        if budget.remaining <= 0 or budget.deadline_exhausted():
            raise AnalysisUnavailableError(
                "Gemini total attempt budget exhausted",
                provider="gemini",
                error_code="GEMINI_ATTEMPT_BUDGET_EXHAUSTED",
                retryable=False,
            )
        blocked_aliases: set[str] = set()
        last_attempt_alias: str | None = None
        model_name = GeminiKeyManager.normalize_model_name(
            model
        ) or extract_model_from_gemini_url(url)
        loop_attempts = budget.remaining

        client_timeout = self._per_attempt_timeout(started, timeout_seconds)
        with self.http_client_factory(timeout=client_timeout) as client:
            for attempt in range(1, loop_attempts + 1):
                stale_aliases: set[str] = set()
                while True:
                    allow_preferred_reuse = bool(
                        sticky_alias
                        and preferred_key_alias
                        and sticky_alias == preferred_key_alias
                    )
                    selection = self.key_manager.select_key(
                        preferred_alias=sticky_alias,
                        model=model_name or None,
                        attempted_aliases=attempted_aliases,
                        exclude_aliases=stale_aliases | blocked_aliases,
                        allow_preferred_reuse=allow_preferred_reuse,
                    )
                    if not selection.available or selection.entry is None:
                        break
                    if self.key_manager.validate_selection(
                        selection, model=model_name or None
                    ):
                        break
                    stale_alias = selection.entry.alias
                    stale_aliases.add(stale_alias)
                    attempted_aliases.add(stale_alias)
                    sticky_alias = None
                    logger.info(
                        "GEMINI_KEY_SELECTION_STALE alias={} model={} reselect=true",
                        stale_alias,
                        model_name or "",
                    )
                    if len(stale_aliases) >= len(self.key_manager.entries):
                        selection = self.key_manager.select_key(
                            model=model_name or None,
                            attempted_aliases=attempted_aliases,
                            exclude_aliases=stale_aliases | blocked_aliases,
                            allow_preferred_reuse=False,
                        )
                        break

                per_attempt_timeout = self._per_attempt_timeout(
                    started, timeout_seconds
                )
                if per_attempt_timeout <= 0:
                    # Fail-fast grace only for keys not yet tried in this request.
                    # Do not re-grant budget to retry the same timed-out alias.
                    selected_unattempted = bool(
                        selection.available
                        and selection.entry is not None
                        and selection.entry.alias not in attempted_aliases
                    )
                    if failures_by_alias and (
                        selected_unattempted or selection.has_unattempted_eligible
                    ):
                        per_attempt_timeout = min(
                            max(0.0, float(timeout_seconds or 0)), 15.0
                        )
                        if per_attempt_timeout <= 0:
                            per_attempt_timeout = 15.0
                        logger.warning(
                            "GEMINI_FAIL_FAST_GRACE attempt={} remainingKeys=true graceTimeoutSeconds={}",
                            attempt,
                            per_attempt_timeout,
                        )
                    else:
                        last_error = AnalysisUnavailableError(
                            "Gemini fail-fast deadline exceeded",
                            provider="gemini",
                            error_code="GEMINI_UNAVAILABLE",
                            key_alias=sticky_alias,
                        )
                        break

                if not selection.available or selection.entry is None:
                    if selection.all_model_unsupported:
                        logger.warning(
                            "GEMINI_ALL_KEYS_UNSUPPORTED model={} httpCallsSkipped=true",
                            model_name,
                        )
                        raise AnalysisUnavailableError(
                            "Gemini model is unavailable for all configured API keys",
                            provider="gemini",
                            error_code="GEMINI_MODEL_UNAVAILABLE",
                            retryable=False,
                            key_alias=sticky_alias,
                        )
                    pool_failures = dict(failures_by_alias)
                    if not pool_failures and selection.unavailable_reasons:
                        pool_failures = failure_reasons_from_unavailable(
                            selection.unavailable_reasons
                        )
                    retryable_hint = True
                    if pool_failures:
                        reason_set = set(pool_failures.values())
                        retryable_hint = not (
                            bool(reason_set)
                            and reason_set <= _TERMINAL_KEY_FAILURE_REASONS
                        )
                    elif selection.all_terminal:
                        retryable_hint = False
                    logger.warning(
                        "GEMINI_ALL_KEYS_EXHAUSTED retryable={} cooldownActive={} reasons={}",
                        retryable_hint,
                        selection.cooldown_active,
                        sorted(selection.unavailable_reasons.items()),
                    )
                    retry_after = selection.retry_after_seconds or retry_after_seconds
                    if pool_failures:
                        raise conclude_key_pool_failure(
                            pool_failures,
                            retry_after_seconds=retry_after,
                            key_alias=sticky_alias,
                        )
                    raise AnalysisUnavailableError(
                        "Gemini service unavailable",
                        provider="gemini",
                        error_code="GEMINI_UNAVAILABLE",
                        retry_after_seconds=retry_after,
                        key_alias=sticky_alias,
                    )

                entry = selection.entry
                attempted_aliases.add(entry.alias)
                # After first selection, drop sticky preference only when this
                # attempt is not the preferred key (preferred was cooled down).
                if sticky_alias and entry.alias != sticky_alias:
                    sticky_alias = None

                headers = {
                    "Content-Type": "application/json",
                    "x-goog-api-key": entry.secret,
                }
                logger.info(
                    "GEMINI_KEY_SELECTED alias={} attempt={} sticky={} model={}",
                    entry.alias,
                    attempt,
                    bool(preferred_key_alias and entry.alias == preferred_key_alias),
                    model_name or "",
                )
                provider_attempt = budget.reserve()
                if provider_attempt is None:
                    last_error = AnalysisUnavailableError(
                        "Gemini total attempt budget exhausted",
                        provider="gemini",
                        error_code="GEMINI_ATTEMPT_BUDGET_EXHAUSTED",
                        retryable=False,
                        key_alias=entry.alias,
                    )
                    break
                if last_attempt_alias is not None and last_attempt_alias != entry.alias:
                    gemini_metrics.failover()
                last_attempt_alias = entry.alias
                gemini_metrics.network_attempt(workload, model_name)
                try:
                    response = client.post(
                        url,
                        headers=headers,
                        json=payload,
                        timeout=per_attempt_timeout,
                    )
                except httpx.TimeoutException as exc:
                    last_error = exc
                    sticky_alias = None
                    failures_by_alias[entry.alias] = (
                        GeminiKeyFailureReason.NETWORK_ERROR
                    )
                    logger.warning(
                        "GEMINI_CALL_FAILED alias={} status=timeout reason=TIMEOUT",
                        entry.alias,
                    )
                    if attempt >= loop_attempts or budget.remaining <= 0:
                        break
                    if (
                        not selection.has_unattempted_eligible
                        and same_alias_transient_retries.get(entry.alias, 0)
                        < MAX_SAME_ALIAS_TRANSIENT_RETRIES
                    ):
                        same_alias_transient_retries[entry.alias] = (
                            same_alias_transient_retries.get(entry.alias, 0) + 1
                        )
                        attempted_aliases.discard(entry.alias)
                    gemini_metrics.retry("timeout")
                    self._sleep_before_retry(attempt, started)
                    continue
                except httpx.ConnectError as exc:
                    last_error = exc
                    sticky_alias = None
                    failures_by_alias[entry.alias] = (
                        GeminiKeyFailureReason.NETWORK_ERROR
                    )
                    if self.http_proxy:
                        logger.warning(
                            "GEMINI_PROXY_CONNECT_FAILED alias={} proxy={} errorType={}",
                            entry.alias,
                            self.proxy_context.log_label,
                            type(exc).__name__,
                        )
                        last_error = AnalysisUnavailableError(
                            "Cannot reach Gemini HTTP proxy. Start Clash/V2Ray, enable "
                            "Allow LAN, and verify GEMINI_HTTP_PROXY port in infra/.env.",
                            provider="gemini",
                            error_code="GEMINI_PROXY_CONNECT_FAILED",
                            key_alias=entry.alias,
                        )
                    else:
                        logger.warning(
                            "GEMINI_CALL_FAILED alias={} status=network reason=CONNECT_ERROR",
                            entry.alias,
                        )
                    if attempt >= loop_attempts or budget.remaining <= 0:
                        break
                    if (
                        not selection.has_unattempted_eligible
                        and same_alias_transient_retries.get(entry.alias, 0)
                        < MAX_SAME_ALIAS_TRANSIENT_RETRIES
                    ):
                        same_alias_transient_retries[entry.alias] = (
                            same_alias_transient_retries.get(entry.alias, 0) + 1
                        )
                        attempted_aliases.discard(entry.alias)
                    gemini_metrics.retry("connect_error")
                    self._sleep_before_retry(attempt, started)
                    continue
                except httpx.HTTPError as exc:
                    last_error = exc
                    sticky_alias = None
                    failures_by_alias[entry.alias] = (
                        GeminiKeyFailureReason.NETWORK_ERROR
                    )
                    logger.warning(
                        "GEMINI_CALL_FAILED alias={} status=network reason=HTTP_ERROR",
                        entry.alias,
                    )
                    if attempt >= loop_attempts or budget.remaining <= 0:
                        break
                    if (
                        not selection.has_unattempted_eligible
                        and same_alias_transient_retries.get(entry.alias, 0)
                        < MAX_SAME_ALIAS_TRANSIENT_RETRIES
                    ):
                        same_alias_transient_retries[entry.alias] = (
                            same_alias_transient_retries.get(entry.alias, 0) + 1
                        )
                        attempted_aliases.discard(entry.alias)
                    gemini_metrics.retry("network_error")
                    self._sleep_before_retry(attempt, started)
                    continue

                status_code = int(getattr(response, "status_code", 0) or 0)
                if status_code < 400:
                    # HTTP 2xx must not clear shared cooldown or model marker.
                    logger.info(
                        "GEMINI_CALL_SUCCEEDED alias={} attempt={} model={}",
                        entry.alias,
                        attempt,
                        model_name or "",
                    )
                    return GeminiCallResult(
                        response=response,
                        key_alias=entry.alias,
                        project_group=self.key_manager.project_group_for_alias(
                            entry.alias
                        ),
                        network_attempts=budget.attempts_used,
                        root_operation_id=budget.root_operation_id,
                    )

                reason = _response_reason(response)
                error_message = _response_error_message(response)
                model_unavailable = is_model_unavailable_response(response)
                quota_metric = _sanitize_quota_metric(_response_body_text(response))
                logger.warning(
                    "GEMINI_KEY_FAILED alias={} model={} providerAttempt={} statusCode={} errorCode={} failureReason={} quotaMetric={} retryable={}",
                    entry.alias,
                    model_name or "",
                    attempt,
                    status_code,
                    reason,
                    "model_unavailable" if model_unavailable else reason,
                    quota_metric,
                    status_code in {429, 500, 502, 503, 504} or model_unavailable,
                )
                logger.warning(
                    "GEMINI_CALL_FAILED alias={} status={} reason={} messagePresent={}",
                    entry.alias,
                    status_code,
                    reason,
                    bool(error_message),
                )

                if is_billing_depleted_response(response):
                    failure_reason = GeminiKeyFailureReason.BILLING_CREDITS_DEPLETED
                    failures_by_alias[entry.alias] = failure_reason
                    sticky_alias = None
                    grouped_aliases = self.key_manager.hard_cooldown_project_group(
                        entry.alias,
                        seconds=self.key_hard_cooldown_seconds,
                        reason=failure_reason.value,
                    )
                    blocked_aliases.update(grouped_aliases)
                    gemini_metrics.billing_block()
                    logger.warning(
                        "GEMINI_KEY_HARD_COOLDOWN alias={} model={} cooldownMs={} reason={} quotaMetric={}",
                        entry.alias,
                        model_name or "",
                        int(self.key_hard_cooldown_seconds * 1000),
                        failure_reason.value,
                        quota_metric,
                    )
                    billing_error = AnalysisUnavailableError(
                        "Gemini project billing credits are depleted",
                        provider="gemini",
                        error_code="GEMINI_BILLING_CREDITS_DEPLETED",
                        retryable=False,
                        key_alias=entry.alias,
                    )
                    if not self.cross_project_failover_enabled:
                        raise billing_error
                    if attempt >= loop_attempts or budget.remaining <= 0:
                        raise billing_error
                    gemini_metrics.retry("cross_project_billing_failover")
                    continue

                if status_code == 400:
                    if _is_region_blocked_message(error_message):
                        failures_by_alias[entry.alias] = (
                            GeminiKeyFailureReason.REGION_BLOCKED
                        )
                        raise AnalysisUnavailableError(
                            "Gemini API is blocked in this region. "
                            "Set GEMINI_HTTP_PROXY to a local HTTP proxy (e.g. Clash/V2Ray) for development.",
                            provider="gemini",
                            error_code="GEMINI_REGION_BLOCKED",
                            retryable=False,
                            key_alias=entry.alias,
                        )
                    if model_unavailable and model_name:
                        failures_by_alias[entry.alias] = (
                            GeminiKeyFailureReason.MODEL_UNAVAILABLE
                        )
                        sticky_alias = None
                        self.key_manager.mark_model_unsupported(entry.alias, model_name)
                        last_error = AnalysisUnavailableError(
                            error_message
                            or "Gemini model is not available for this API key",
                            provider="gemini",
                            error_code="GEMINI_MODEL_UNAVAILABLE",
                            retryable=False,
                            key_alias=entry.alias,
                        )
                        raise last_error
                    failures_by_alias[entry.alias] = (
                        GeminiKeyFailureReason.INVALID_REQUEST
                    )
                    detail = error_message or "Gemini request failed with HTTP 400"
                    raise AnalysisUnavailableError(
                        detail,
                        provider="gemini",
                        error_code="GEMINI_INVALID_REQUEST",
                        retryable=False,
                        key_alias=entry.alias,
                    )

                if status_code in {401, 403}:
                    failures_by_alias[entry.alias] = GeminiKeyFailureReason.AUTH_ERROR
                    self.key_manager.hard_cooldown_key(
                        entry.alias,
                        seconds=self.key_hard_cooldown_seconds,
                        reason="invalid_key",
                    )
                    logger.warning(
                        "GEMINI_KEY_COOLDOWN alias={} cooldownMs={} reason=invalid_key",
                        entry.alias,
                        int(self.key_hard_cooldown_seconds * 1000),
                    )
                    last_error = AnalysisConfigError(
                        "Gemini API key was rejected or is missing",
                        provider="gemini",
                        error_code="GEMINI_INVALID_KEY",
                        key_alias=entry.alias,
                    )
                    project_group = self.key_manager.project_group_for_alias(
                        entry.alias
                    )
                    blocked_aliases.update(
                        self.key_manager.aliases_in_project_group(project_group)
                    )
                    sticky_alias = None
                    if not self.cross_project_failover_enabled:
                        raise last_error
                    if attempt >= loop_attempts or budget.remaining <= 0:
                        break
                    gemini_metrics.retry("auth_failover")
                    continue

                if status_code == 429:
                    failure_reason = classify_http_429(response)
                    failures_by_alias[entry.alias] = failure_reason
                    sticky_alias = None
                    if failure_reason in {
                        GeminiKeyFailureReason.FREE_TIER_TOKEN_QUOTA_EXHAUSTED,
                        GeminiKeyFailureReason.DAILY_QUOTA_EXHAUSTED,
                    }:
                        cooldown = self.key_hard_cooldown_seconds
                        grouped_aliases = self.key_manager.hard_cooldown_project_group(
                            entry.alias,
                            seconds=cooldown,
                            reason=failure_reason.value,
                        )
                        blocked_aliases.update(grouped_aliases)
                        logger.warning(
                            "GEMINI_KEY_HARD_COOLDOWN alias={} model={} cooldownMs={} reason={} quotaMetric={}",
                            entry.alias,
                            model_name or "",
                            int(cooldown * 1000),
                            failure_reason.value,
                            quota_metric,
                        )
                        quota_error = AnalysisUnavailableError(
                            (
                                "Gemini daily project quota is exhausted"
                                if failure_reason
                                is GeminiKeyFailureReason.DAILY_QUOTA_EXHAUSTED
                                else "Gemini free-tier token quota is exhausted"
                            ),
                            provider="gemini",
                            error_code=(
                                "GEMINI_BILLING_CREDITS_DEPLETED"
                                if failure_reason
                                is GeminiKeyFailureReason.BILLING_CREDITS_DEPLETED
                                else (
                                    "GEMINI_DAILY_QUOTA_EXHAUSTED"
                                    if failure_reason
                                    is GeminiKeyFailureReason.DAILY_QUOTA_EXHAUSTED
                                    else "GEMINI_FREE_TIER_TOKEN_QUOTA_EXHAUSTED"
                                )
                            ),
                            retryable=False,
                            key_alias=entry.alias,
                        )
                        if not self.cross_project_failover_enabled:
                            raise quota_error
                        if attempt >= loop_attempts or budget.remaining <= 0:
                            raise quota_error
                        gemini_metrics.retry("cross_project_billing_failover")
                        continue
                    else:
                        retry_after = _bounded_retry_after(
                            response, self.key_cooldown_seconds
                        )
                        retry_after_seconds = int(ceil(retry_after))
                        self.key_manager.cooldown_key(
                            entry.alias,
                            seconds=retry_after,
                            reason="rate_limit",
                        )
                        logger.warning(
                            "GEMINI_KEY_COOLDOWN alias={} cooldownMs={} reason=rate_limit quotaMetric={}",
                            entry.alias,
                            int(retry_after * 1000),
                            quota_metric,
                        )
                    if attempt >= loop_attempts or budget.remaining <= 0:
                        break
                    # Match VPS failover intent: try the next eligible key
                    # immediately inside this logical request (primary 429 →
                    # backup1). Do not burn fail-fast budget on backoff sleep
                    # when another key can still serve the model.
                    if selection.has_unattempted_eligible:
                        logger.info(
                            "GEMINI_KEY_FAILOVER_IMMEDIATE fromAlias={} model={}",
                            entry.alias,
                            model_name or "",
                        )
                        gemini_metrics.retry("rate_limit_failover")
                        continue
                    gemini_metrics.retry("rate_limit")
                    self._sleep_before_retry(attempt, started)
                    continue

                if model_unavailable:
                    failures_by_alias[entry.alias] = (
                        GeminiKeyFailureReason.MODEL_UNAVAILABLE
                    )
                    sticky_alias = None
                    if model_name:
                        self.key_manager.mark_model_unsupported(entry.alias, model_name)
                    logger.warning(
                        "GEMINI_KEY_MODEL_UNAVAILABLE alias={} model={} reason=model_unavailable",
                        entry.alias,
                        model_name or "",
                    )
                    last_error = AnalysisUnavailableError(
                        error_message
                        or "Gemini model is not available for this API key",
                        provider="gemini",
                        error_code="GEMINI_MODEL_UNAVAILABLE",
                        retryable=False,
                        key_alias=entry.alias,
                    )
                    raise last_error

                if status_code in {500, 502, 503, 504}:
                    sticky_alias = None
                    failures_by_alias[entry.alias] = (
                        GeminiKeyFailureReason.TRANSIENT_PROVIDER_ERROR
                    )
                    last_error = AnalysisUnavailableError(
                        f"Gemini request failed with HTTP {status_code}",
                        provider="gemini",
                        error_code="GEMINI_UNAVAILABLE",
                        key_alias=entry.alias,
                    )
                    if attempt >= loop_attempts or budget.remaining <= 0:
                        break
                    if (
                        not selection.has_unattempted_eligible
                        and same_alias_transient_retries.get(entry.alias, 0)
                        < MAX_SAME_ALIAS_TRANSIENT_RETRIES
                    ):
                        same_alias_transient_retries[entry.alias] = (
                            same_alias_transient_retries.get(entry.alias, 0) + 1
                        )
                        attempted_aliases.discard(entry.alias)
                    gemini_metrics.retry("provider_5xx")
                    self._sleep_before_retry(attempt, started)
                    continue

                raise AnalysisUnavailableError(
                    f"Gemini request failed with HTTP {status_code}",
                    provider="gemini",
                    error_code="GEMINI_UNAVAILABLE",
                    key_alias=entry.alias,
                )

        logger.warning(
            "GEMINI_ALL_KEYS_EXHAUSTED retryable=true cooldownActive={}",
            0,
        )
        if failures_by_alias:
            raise conclude_key_pool_failure(
                failures_by_alias,
                retry_after_seconds=retry_after_seconds,
                key_alias=sticky_alias,
            )
        if isinstance(last_error, AnalysisConfigError):
            raise last_error
        if isinstance(last_error, AnalysisUnavailableError):
            raise last_error
        raise AnalysisUnavailableError(
            "Gemini service unavailable",
            provider="gemini",
            error_code="GEMINI_UNAVAILABLE",
        )

    def _per_attempt_timeout(self, started: float, timeout_seconds: int) -> float:
        base_timeout = max(0.0, float(timeout_seconds or 0))
        if self.fail_fast_seconds <= 0:
            return base_timeout
        elapsed = max(0.0, self.clock() - started)
        remaining = self.fail_fast_seconds - elapsed
        return min(base_timeout, max(0.0, remaining))

    def _sleep_before_retry(self, attempt: int, started: float) -> None:
        if self.backoff_base_ms <= 0:
            return
        delay_ms = min(
            self.backoff_max_ms,
            self.backoff_base_ms * (2 ** max(0, attempt - 1)),
        )
        if self.backoff_jitter and delay_ms > 0:
            delay_ms = self.random_float(0, delay_ms)
        delay_seconds = max(0.0, delay_ms / 1000.0)
        if self.fail_fast_seconds > 0:
            elapsed = max(0.0, self.clock() - started)
            remaining = self.fail_fast_seconds - elapsed
            if remaining <= 0:
                return
            delay_seconds = min(delay_seconds, remaining)
        logger.warning(
            "GEMINI_RETRY_SCHEDULED delayMs={} attempt={}",
            int(delay_seconds * 1000),
            attempt + 1,
        )
        self.sleep(delay_seconds)
