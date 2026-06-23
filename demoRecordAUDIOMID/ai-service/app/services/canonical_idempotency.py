"""Redis idempotency for canonicalize enqueue (Epic 3 §5.3.1)."""

from __future__ import annotations

from loguru import logger

from app.job_status_store import _get_client

_INFLIGHT_TTL_SECONDS = 600  # 10 minutes


def _inflight_key(meeting_id: int, run_id_or_none: str, canonical_hash: str) -> str:
    return f"canonicalize:{meeting_id}:{run_id_or_none}:{canonical_hash}"


def check_idempotent_skip(
    meeting_id: int,
    run_id: int | None,
    canonical_hash: str,
    persisted_hash: str | None,
) -> str | None:
    """Return skip reason ('persisted' | 'in_flight') or None to proceed."""
    if persisted_hash and persisted_hash == canonical_hash:
        return "persisted"

    run_key = str(run_id) if run_id is not None else "none"
    client = _get_client()
    key = _inflight_key(meeting_id, run_key, canonical_hash)
    if client.exists(key):
        return "in_flight"
    return None


def mark_inflight(meeting_id: int, run_id: int | None, canonical_hash: str) -> None:
    run_key = str(run_id) if run_id is not None else "none"
    client = _get_client()
    key = _inflight_key(meeting_id, run_key, canonical_hash)
    client.set(key, "1", ex=_INFLIGHT_TTL_SECONDS)


def log_idempotent_skip(
    meeting_id: int,
    run_id: int | None,
    canonical_hash: str,
    reason: str,
) -> None:
    logger.info(
        "event=TRANSCRIPT_QUALITY_IDEMPOTENT_SKIP meetingId={} runId={} canonicalTranscriptHash={} reason={}",
        meeting_id,
        run_id,
        canonical_hash,
        reason,
    )
