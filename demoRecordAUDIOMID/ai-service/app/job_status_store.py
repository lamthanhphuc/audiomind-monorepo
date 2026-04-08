from __future__ import annotations

from datetime import datetime, timezone
import json

import redis
from loguru import logger

from app.config import get_settings

settings = get_settings()
_redis_client: redis.Redis | None = None


def _get_client() -> redis.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.from_url(settings.job_state_redis_url, decode_responses=True)
    return _redis_client


def _job_key(job_id: int) -> str:
    return f"job:{job_id}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_job_statuses(recover_interrupted: bool = False) -> None:
    try:
        _get_client().ping()
        logger.info("Redis job status store is ready")
    except Exception as redis_error:
        logger.warning(f"Redis job store unavailable: {repr(redis_error)}")


def cleanup_expired_job_statuses() -> None:
    # Redis TTL handles cleanup.
    return


def persist_job_statuses() -> None:
    # Redis is the source of truth.
    return


def set_job_status(
    meeting_id: int,
    status: str,
    error: str | None = None,
    result: dict | None = None,
    file_id: str | None = None,
    trace_id: str | None = None,
) -> None:
    key = _job_key(meeting_id)

    try:
        client = _get_client()
        existing_raw = client.get(key)
        state: dict = {}
        if existing_raw:
            try:
                parsed = json.loads(existing_raw)
                if isinstance(parsed, dict):
                    state = parsed
            except json.JSONDecodeError:
                state = {}

        if "createdAt" not in state:
            state["createdAt"] = _now_iso()

        state["jobId"] = str(meeting_id)
        state["status"] = status.upper()
        state["updatedAt"] = _now_iso()

        if file_id is not None and file_id != "":
            state["fileId"] = file_id
        else:
            state.setdefault("fileId", None)

        if trace_id is not None and trace_id != "":
            state["traceId"] = trace_id
        else:
            state.setdefault("traceId", None)

        if error:
            state["error"] = error
        else:
            state["error"] = None

        if result is not None:
            state["result"] = result
        else:
            state.setdefault("result", None)

        client.set(key, json.dumps(state, ensure_ascii=True), ex=settings.job_state_ttl_seconds)
    except Exception as redis_error:
        logger.warning(f"Could not set Redis job state for {meeting_id}: {repr(redis_error)}")


def get_job_status(meeting_id: int) -> dict | None:
    try:
        raw = _get_client().get(_job_key(meeting_id))
        if not raw:
            return None
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
        return None
    except Exception as redis_error:
        logger.warning(f"Could not load Redis job state for {meeting_id}: {repr(redis_error)}")
        return None
