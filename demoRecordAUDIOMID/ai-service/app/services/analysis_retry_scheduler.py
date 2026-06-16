from __future__ import annotations

import json
import random
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from loguru import logger

ANALYSIS_RETRY_QUEUE_KEY = "analysis:retry:queue"
ANALYSIS_LOCK_TTL_SECONDS = 600

# analysisAttempt 2..5 delays in seconds
BACKOFF_SCHEDULE_SECONDS = (30, 120, 300, 900)
JITTER_RATIO = 0.10

RETRYABLE_ERROR_CODES = frozenset(
    {
        "GEMINI_RATE_LIMITED",
        "GEMINI_UNAVAILABLE",
        "GEMINI_QUOTA_EXHAUSTED",
        "CIRCUIT_OPEN",
    }
)


@dataclass(frozen=True)
class RetryQueueEntry:
    meeting_id: int
    analysis_attempt: int
    analysis_input_hash: str
    trace_id: str
    source: str
    next_retry_at: float


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def compute_retry_delay_seconds(analysis_attempt: int) -> int:
    # analysisAttempt is 1-based; first retry is attempt 2 -> index 0
    index = max(0, min(analysis_attempt - 2, len(BACKOFF_SCHEDULE_SECONDS) - 1))
    base = BACKOFF_SCHEDULE_SECONDS[index]
    jitter = base * JITTER_RATIO
    return max(1, int(base + random.uniform(-jitter, jitter)))


def serialize_queue_member(entry: RetryQueueEntry) -> str:
    return json.dumps(
        {
            "meetingId": entry.meeting_id,
            "analysisAttempt": entry.analysis_attempt,
            "analysisInputHash": entry.analysis_input_hash,
            "traceId": entry.trace_id,
            "source": entry.source,
        },
        separators=(",", ":"),
        sort_keys=True,
    )


def parse_queue_member(raw: str) -> dict[str, Any] | None:
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def enqueue_background_retry(
    redis_client,
    *,
    meeting_id: int,
    analysis_attempt: int,
    analysis_input_hash: str,
    trace_id: str,
    source: str,
    max_attempts: int,
    enabled: bool = True,
) -> RetryQueueEntry | None:
    if not enabled:
        return None
    if analysis_attempt >= max_attempts + 1:
        logger.warning(
            "ANALYSIS_BACKGROUND_RETRY_EXHAUSTED meetingId={} analysisRetryCount={}",
            meeting_id,
            analysis_attempt - 1,
        )
        return None

    delay_seconds = compute_retry_delay_seconds(analysis_attempt + 1)
    next_retry_at = time.time() + delay_seconds
    entry = RetryQueueEntry(
        meeting_id=meeting_id,
        analysis_attempt=analysis_attempt + 1,
        analysis_input_hash=analysis_input_hash,
        trace_id=trace_id,
        source=source,
        next_retry_at=next_retry_at,
    )
    member = serialize_queue_member(entry)
    redis_client.zadd(ANALYSIS_RETRY_QUEUE_KEY, {member: next_retry_at})
    logger.info(
        "ANALYSIS_BACKGROUND_RETRY_ENQUEUED meetingId={} analysisAttempt={} nextRetryAt={}",
        meeting_id,
        entry.analysis_attempt,
        datetime.fromtimestamp(next_retry_at, tz=timezone.utc).isoformat(),
    )
    return entry


def pop_due_retries(redis_client, *, now: float | None = None) -> list[RetryQueueEntry]:
    current = now if now is not None else time.time()
    members = redis_client.zrangebyscore(ANALYSIS_RETRY_QUEUE_KEY, "-inf", current)
    entries: list[RetryQueueEntry] = []
    for raw in members or []:
        member = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
        payload = parse_queue_member(member)
        if payload is None:
            redis_client.zrem(ANALYSIS_RETRY_QUEUE_KEY, member)
            continue
        meeting_id = int(payload.get("meetingId") or 0)
        if meeting_id <= 0:
            redis_client.zrem(ANALYSIS_RETRY_QUEUE_KEY, member)
            continue
        entries.append(
            RetryQueueEntry(
                meeting_id=meeting_id,
                analysis_attempt=int(payload.get("analysisAttempt") or 1),
                analysis_input_hash=str(payload.get("analysisInputHash") or ""),
                trace_id=str(payload.get("traceId") or ""),
                source=str(payload.get("source") or "background_retry"),
                next_retry_at=current,
            )
        )
        redis_client.zrem(ANALYSIS_RETRY_QUEUE_KEY, member)
    return entries


def is_retryable_error_code(error_code: str | None) -> bool:
    normalized = str(error_code or "").strip().upper()
    return normalized in RETRYABLE_ERROR_CODES


def serialize_lock_payload(
    *,
    meeting_id: int,
    analysis_input_hash: str,
    trigger_source: str,
    analysis_attempt: int,
    trace_id: str,
) -> str:
    return json.dumps(
        {
            "meetingId": meeting_id,
            "analysisInputHash": analysis_input_hash,
            "triggerSource": trigger_source,
            "analysisAttempt": analysis_attempt,
            "traceId": trace_id,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
