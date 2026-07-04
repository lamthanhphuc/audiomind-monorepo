import random
import socket
import time
from math import ceil
from typing import Any, Callable
from urllib.parse import urlparse, urlunparse

import httpx
from loguru import logger

from app.services.analysis_errors import (
    AnalysisConfigError,
    AnalysisRateLimitError,
    AnalysisUnavailableError,
)
from app.services.gemini_key_manager import GeminiKeyManager


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


def _is_region_blocked_message(message: str) -> bool:
    lowered = str(message or "").strip().lower()
    return "location is not supported" in lowered


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

    logger.info("GEMINI_HTTP_PROXY_ENABLED proxy={}", proxy_url)

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
        self.key_cooldown_seconds = max(0.0, float(key_cooldown_seconds or 0.0))
        self.key_hard_cooldown_seconds = max(
            0.0, float(key_hard_cooldown_seconds or 0.0)
        )
        self.backoff_base_ms = max(0.0, float(backoff_base_ms or 0.0))
        self.backoff_max_ms = max(0.0, float(backoff_max_ms or 0.0))
        self.backoff_jitter = bool(backoff_jitter)
        self.fail_fast_seconds = max(0.0, float(fail_fast_seconds or 0.0))
        self.http_proxy = _normalize_gemini_proxy_url(http_proxy)
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
    ):
        started = self.clock()
        last_error: Exception | None = None
        saw_rate_limit = False
        retry_after_seconds = 0

        client_timeout = self._per_attempt_timeout(started, timeout_seconds)
        with self.http_client_factory(timeout=client_timeout) as client:
            for attempt in range(1, self.max_attempts + 1):
                per_attempt_timeout = self._per_attempt_timeout(
                    started, timeout_seconds
                )
                if per_attempt_timeout <= 0:
                    last_error = AnalysisUnavailableError(
                        "Gemini fail-fast deadline exceeded",
                        provider="gemini",
                        error_code="GEMINI_UNAVAILABLE",
                    )
                    break

                selection = self.key_manager.select_key()
                if not selection.available or selection.entry is None:
                    logger.warning(
                        "GEMINI_ALL_KEYS_EXHAUSTED retryable=true cooldownActive={}",
                        selection.cooldown_active,
                    )
                    retry_after = selection.retry_after_seconds or retry_after_seconds
                    if saw_rate_limit:
                        raise AnalysisRateLimitError(
                            "Gemini rate limit reached",
                            provider="gemini",
                            error_code="GEMINI_RATE_LIMITED",
                            retry_after_seconds=retry_after,
                        )
                    raise AnalysisUnavailableError(
                        "Gemini service unavailable",
                        provider="gemini",
                        error_code="GEMINI_UNAVAILABLE",
                        retry_after_seconds=retry_after,
                    )

                entry = selection.entry
                headers = {
                    "Content-Type": "application/json",
                    "x-goog-api-key": entry.secret,
                }
                logger.info(
                    "GEMINI_KEY_SELECTED alias={} attempt={}", entry.alias, attempt
                )
                try:
                    response = client.post(
                        url,
                        headers=headers,
                        json=payload,
                        timeout=per_attempt_timeout,
                    )
                except httpx.TimeoutException as exc:
                    last_error = exc
                    logger.warning(
                        "GEMINI_CALL_FAILED alias={} status=timeout reason=TIMEOUT",
                        entry.alias,
                    )
                    if attempt >= self.max_attempts:
                        break
                    self._sleep_before_retry(attempt, started)
                    continue
                except httpx.ConnectError as exc:
                    last_error = exc
                    if self.http_proxy:
                        logger.warning(
                            "GEMINI_PROXY_CONNECT_FAILED alias={} proxy={} error={}",
                            entry.alias,
                            self.http_proxy,
                            exc,
                        )
                        last_error = AnalysisUnavailableError(
                            "Cannot reach Gemini HTTP proxy. Start Clash/V2Ray, enable "
                            "Allow LAN, and verify GEMINI_HTTP_PROXY port in infra/.env.",
                            provider="gemini",
                            error_code="GEMINI_PROXY_CONNECT_FAILED",
                        )
                    else:
                        logger.warning(
                            "GEMINI_CALL_FAILED alias={} status=network reason=CONNECT_ERROR",
                            entry.alias,
                        )
                    if attempt >= self.max_attempts:
                        break
                    self._sleep_before_retry(attempt, started)
                    continue
                except httpx.HTTPError as exc:
                    last_error = exc
                    logger.warning(
                        "GEMINI_CALL_FAILED alias={} status=network reason=HTTP_ERROR",
                        entry.alias,
                    )
                    if attempt >= self.max_attempts:
                        break
                    self._sleep_before_retry(attempt, started)
                    continue

                status_code = int(getattr(response, "status_code", 0) or 0)
                if status_code < 400:
                    logger.info(
                        "GEMINI_CALL_SUCCEEDED alias={} attempt={}",
                        entry.alias,
                        attempt,
                    )
                    return response

                reason = _response_reason(response)
                logger.warning(
                    "GEMINI_KEY_FAILED alias={} providerAttempt={} statusCode={} errorCode={} retryable={}",
                    entry.alias,
                    attempt,
                    status_code,
                    reason,
                    status_code in {429, 500, 502, 503, 504},
                )
                error_message = _response_error_message(response)
                logger.warning(
                    "GEMINI_CALL_FAILED alias={} status={} reason={} message={}",
                    entry.alias,
                    status_code,
                    reason,
                    error_message[:240] if error_message else "",
                )

                if status_code == 400:
                    if _is_region_blocked_message(error_message):
                        raise AnalysisUnavailableError(
                            "Gemini API is blocked in this region. "
                            "Set GEMINI_HTTP_PROXY to a local HTTP proxy (e.g. Clash/V2Ray) for development.",
                            provider="gemini",
                            error_code="GEMINI_REGION_BLOCKED",
                            retryable=False,
                        )
                    detail = error_message or "Gemini request failed with HTTP 400"
                    raise AnalysisUnavailableError(
                        detail,
                        provider="gemini",
                        error_code="GEMINI_INVALID_REQUEST",
                        retryable=False,
                    )

                if status_code in {401, 403}:
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
                    )
                    if attempt >= self.max_attempts:
                        break
                    continue

                if status_code == 429:
                    saw_rate_limit = True
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
                        "GEMINI_KEY_COOLDOWN alias={} cooldownMs={} reason=rate_limit",
                        entry.alias,
                        int(retry_after * 1000),
                    )
                    if attempt >= self.max_attempts:
                        break
                    self._sleep_before_retry(attempt, started)
                    continue

                if status_code in {500, 502, 503, 504}:
                    last_error = AnalysisUnavailableError(
                        f"Gemini request failed with HTTP {status_code}",
                        provider="gemini",
                        error_code="GEMINI_UNAVAILABLE",
                    )
                    if attempt >= self.max_attempts:
                        break
                    self._sleep_before_retry(attempt, started)
                    continue

                raise AnalysisUnavailableError(
                    f"Gemini request failed with HTTP {status_code}",
                    provider="gemini",
                    error_code="GEMINI_UNAVAILABLE",
                )

        logger.warning(
            "GEMINI_ALL_KEYS_EXHAUSTED retryable=true cooldownActive={}",
            0,
        )
        if saw_rate_limit:
            raise AnalysisRateLimitError(
                "Gemini rate limit reached",
                provider="gemini",
                error_code="GEMINI_RATE_LIMITED",
                retry_after_seconds=retry_after_seconds,
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
