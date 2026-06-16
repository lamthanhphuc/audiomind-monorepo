from __future__ import annotations

import json
import time
from typing import Any
from uuid import uuid4

ANALYSIS_LOCK_TTL_SECONDS = 600
_LOCK_TOKEN_PREFIX = "aiapi:"


def new_lock_token() -> str:
    return f"{_LOCK_TOKEN_PREFIX}{uuid4().hex}"


def build_lock_payload(
    *,
    meeting_id: int,
    analysis_input_hash: str,
    trigger_source: str,
    analysis_attempt: int,
    trace_id: str,
    lock_token: str | None = None,
    started_at: float | None = None,
) -> str:
    payload = {
        "lockToken": lock_token or new_lock_token(),
        "meetingId": meeting_id,
        "analysisInputHash": analysis_input_hash,
        "triggerSource": trigger_source,
        "analysisAttempt": max(1, int(analysis_attempt)),
        "traceId": trace_id,
        "startedAt": started_at if started_at is not None else time.time(),
    }
    return json.dumps(payload, separators=(",", ":"), sort_keys=True)


def parse_lock_payload(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    text = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
    if not text.strip():
        return {}
    if text.startswith(_LOCK_TOKEN_PREFIX):
        return {"lockToken": text}
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError, json.JSONDecodeError):
        return {"lockToken": text}
    return parsed if isinstance(parsed, dict) else {"lockToken": text}


def lock_token_from_raw(raw: Any) -> str:
    payload = parse_lock_payload(raw)
    return str(payload.get("lockToken") or "")


def is_ai_owned_lock(raw: Any) -> bool:
    token = lock_token_from_raw(raw)
    return token.startswith(_LOCK_TOKEN_PREFIX)


def acquire_analysis_lock(
    client: Any,
    *,
    lock_key: str,
    meeting_id: int,
    analysis_input_hash: str,
    trigger_source: str,
    analysis_attempt: int,
    trace_id: str,
    ttl_seconds: int = ANALYSIS_LOCK_TTL_SECONDS,
) -> tuple[bool, str | None, dict[str, Any]]:
    lock_token = new_lock_token()
    payload = build_lock_payload(
        meeting_id=meeting_id,
        analysis_input_hash=analysis_input_hash,
        trigger_source=trigger_source,
        analysis_attempt=analysis_attempt,
        trace_id=trace_id,
        lock_token=lock_token,
    )
    acquired = client.set(
        lock_key,
        payload,
        nx=True,
        ex=max(120, int(ttl_seconds)),
    )
    if acquired:
        return True, lock_token, parse_lock_payload(payload)
    holder = parse_lock_payload(client.get(lock_key))
    return False, None, holder


def release_analysis_lock(client: Any, lock_key: str, lock_token: str | None) -> None:
    if not lock_token:
        return
    try:
        current = client.get(lock_key)
        if not current:
            return
        stored_token = lock_token_from_raw(current)
        if stored_token and stored_token == lock_token:
            client.delete(lock_key)
    except Exception:
        return


def holder_trace_id(holder_payload: dict[str, Any]) -> str | None:
    trace_id = str(holder_payload.get("traceId") or "").strip()
    return trace_id or None
