from __future__ import annotations

from datetime import datetime, timezone
import json
from typing import Any

import redis
from loguru import logger

from app.config import get_settings

settings = get_settings()
_redis_client: redis.Redis | None = None


def _get_client() -> redis.Redis:
    global _redis_client
    if _redis_client is None:
        pool = redis.ConnectionPool.from_url(
            settings.job_state_redis_url,
            decode_responses=True,
            max_connections=settings.redis_max_connections,
        )
        _redis_client = redis.Redis(connection_pool=pool)
    return _redis_client


def _job_key(job_id: int) -> str:
    return f"job:{job_id}"


def _chunk_key(job_id: int, chunk_index: int) -> str:
    return f"chunk:{job_id}:{chunk_index}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True)


def _json_load(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


def _normalize_status(value: str | None) -> str:
    return (value or "UNKNOWN").upper()


def _to_int(value: str | None, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


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
    progress: int | None = None,
    stage: str | None = None,
    failed_chunks: list[dict[str, Any]] | None = None,
    attempts: int | None = None,
    total_chunks: int | None = None,
    completed_chunks: int | None = None,
) -> None:
    key = _job_key(meeting_id)

    try:
        client = _get_client()
        existing = _safe_job_hash(client, key)
        created_at = existing.get("createdAt", _now_iso())

        safe_status = _normalize_status(status)
        if safe_status in {"COMPLETED"}:
            progress = 100 if progress is None else min(100, max(0, int(progress)))
            stage = stage or "completed"
        elif safe_status in {"FAILED"}:
            stage = stage or "failed"

        if progress is not None:
            progress = min(100, max(0, int(progress)))

        state_updates: dict[str, str] = {
            "jobId": str(meeting_id),
            "status": safe_status,
            "createdAt": created_at,
            "updatedAt": _now_iso(),
            "fileId": file_id if file_id else existing.get("fileId") or "",
            "traceId": trace_id if trace_id else existing.get("traceId") or "",
            "error": error or "",
        }

        if progress is not None:
            state_updates["progress"] = str(progress)
        elif "progress" not in existing:
            state_updates["progress"] = "0"

        if stage is not None:
            state_updates["stage"] = stage
        elif "stage" not in existing:
            state_updates["stage"] = "uploading"

        if result is not None:
            state_updates["result"] = _json_dump(result)

        if failed_chunks is not None:
            state_updates["failed_chunks"] = _json_dump(failed_chunks)

        if attempts is not None:
            state_updates["attempts"] = str(max(0, attempts))

        if total_chunks is not None:
            state_updates["total_chunks"] = str(max(0, total_chunks))

        if completed_chunks is not None:
            state_updates["completed_chunks"] = str(max(0, completed_chunks))

        client.hset(key, mapping=state_updates)
        client.expire(key, settings.job_state_ttl_seconds)
    except Exception as redis_error:
        logger.warning(
            f"Could not set Redis job state for {meeting_id}: {repr(redis_error)}"
        )


def get_job_status(meeting_id: int) -> dict | None:
    try:
        raw = _safe_job_hash(_get_client(), _job_key(meeting_id))
        if not raw:
            return None

        result_value = _json_load(raw.get("result"), None)
        failed_chunks = _json_load(raw.get("failed_chunks"), [])
        return {
            "jobId": raw.get("jobId", str(meeting_id)),
            "status": _normalize_status(raw.get("status")),
            "progress": _to_int(raw.get("progress"), 0),
            "stage": raw.get("stage", "uploading"),
            "error": raw.get("error") or None,
            "createdAt": raw.get("createdAt"),
            "updatedAt": raw.get("updatedAt"),
            "fileId": raw.get("fileId") or None,
            "traceId": raw.get("traceId") or None,
            "attempts": _to_int(raw.get("attempts"), 0),
            "total_chunks": _to_int(raw.get("total_chunks"), 0),
            "completed_chunks": _to_int(raw.get("completed_chunks"), 0),
            "failed_chunks": failed_chunks if isinstance(failed_chunks, list) else [],
            "result": result_value,
        }
    except Exception as redis_error:
        logger.warning(
            f"Could not load Redis job state for {meeting_id}: {repr(redis_error)}"
        )
        return None


def set_chunk_status(
    job_id: int,
    chunk_index: int,
    status: str,
    reason: str | None = None,
    segment_count: int | None = None,
) -> None:
    try:
        client = _get_client()
        key = _chunk_key(job_id, chunk_index)
        current = client.hgetall(key)
        updates = {
            "jobId": str(job_id),
            "chunk_index": str(chunk_index),
            "status": _normalize_status(status),
            "updatedAt": _now_iso(),
            "reason": reason or "",
            "segment_count": str(
                segment_count
                if segment_count is not None
                else current.get("segment_count", "0")
            ),
        }
        if "createdAt" not in current:
            updates["createdAt"] = _now_iso()
        client.hset(key, mapping=updates)
        client.expire(key, settings.chunk_state_ttl_seconds)
    except Exception as redis_error:
        logger.warning(
            f"Could not set chunk status for job={job_id} chunk={chunk_index}: {repr(redis_error)}"
        )


def get_chunk_status(job_id: int, chunk_index: int) -> dict | None:
    try:
        data = _get_client().hgetall(_chunk_key(job_id, chunk_index))
        if not data:
            return None
        return {
            "jobId": data.get("jobId", str(job_id)),
            "chunk_index": _to_int(data.get("chunk_index"), chunk_index),
            "status": _normalize_status(data.get("status")),
            "createdAt": data.get("createdAt"),
            "updatedAt": data.get("updatedAt"),
            "reason": data.get("reason") or None,
            "segment_count": _to_int(data.get("segment_count"), 0),
        }
    except Exception as redis_error:
        logger.warning(
            f"Could not load chunk status for job={job_id} chunk={chunk_index}: {repr(redis_error)}"
        )
        return None


def force_fail_job(job_id: int, reason: str) -> None:
    set_job_status(
        meeting_id=job_id,
        status="FAILED",
        error=reason,
        stage="failed",
    )


def list_running_job_ids() -> list[int]:
    try:
        client = _get_client()
        keys = client.keys("job:*")
        running: list[int] = []
        for key in keys:
            status = _normalize_status(client.hget(key, "status"))
            if status in {"RUNNING", "RETRYING"}:
                job_id_raw = client.hget(key, "jobId")
                if job_id_raw and str(job_id_raw).isdigit():
                    running.append(int(job_id_raw))
        return running
    except Exception as redis_error:
        logger.warning(f"Could not list running jobs: {repr(redis_error)}")
        return []


def increment_completed_chunks(job_id: int) -> int:
    try:
        client = _get_client()
        key = _job_key(job_id)
        value = client.hincrby(key, "completed_chunks", 1)
        client.expire(key, settings.job_state_ttl_seconds)
        return int(value)
    except Exception as redis_error:
        logger.warning(
            f"Could not increment completed_chunks for job={job_id}: {repr(redis_error)}"
        )
        return 0


def _safe_job_hash(client: redis.Redis, key: str) -> dict[str, str]:
    key_type = client.type(key)
    if key_type in ("none", b"none"):
        return {}

    if key_type in ("hash", b"hash"):
        return client.hgetall(key)

    # Backward compatibility: migrate legacy JSON string state into hash format.
    if key_type in ("string", b"string"):
        legacy_raw = client.get(key)
        legacy_state = _json_load(legacy_raw, {})
        if not isinstance(legacy_state, dict):
            legacy_state = {}

        client.delete(key)
        migrated = {
            "jobId": str(legacy_state.get("jobId", "")),
            "status": _normalize_status(legacy_state.get("status")),
            "progress": str(_to_int(str(legacy_state.get("progress", "0")), 0)),
            "stage": str(legacy_state.get("stage", "uploading")),
            "error": str(legacy_state.get("error") or ""),
            "createdAt": str(legacy_state.get("createdAt") or _now_iso()),
            "updatedAt": str(legacy_state.get("updatedAt") or _now_iso()),
            "fileId": str(legacy_state.get("fileId") or ""),
            "traceId": str(legacy_state.get("traceId") or ""),
            "attempts": str(_to_int(str(legacy_state.get("attempts", "0")), 0)),
            "total_chunks": str(_to_int(str(legacy_state.get("total_chunks", "0")), 0)),
            "completed_chunks": str(
                _to_int(str(legacy_state.get("completed_chunks", "0")), 0)
            ),
            "failed_chunks": _json_dump(legacy_state.get("failed_chunks", [])),
        }
        result_value = legacy_state.get("result")
        if result_value is not None:
            migrated["result"] = _json_dump(result_value)

        client.hset(key, mapping=migrated)
        client.expire(key, settings.job_state_ttl_seconds)
        return client.hgetall(key)

    # Unknown type: clear corrupted key and start fresh.
    client.delete(key)
    return {}
