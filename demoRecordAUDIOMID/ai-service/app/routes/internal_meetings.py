"""Internal meeting routes for Epic 3 transcript quality."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.models import MeetingAnalysisRun
from app.services.canonical_idempotency import (
    check_idempotent_skip,
    log_idempotent_skip,
    mark_inflight,
)
from app.services.canonical_persist_service import (
    build_transcript_quality_dto,
    preview_canonical_hash,
    resolve_latest_run_id,
)

router = APIRouter(prefix="/api/internal/meetings", tags=["internal-meetings"])
settings = get_settings()


class CanonicalizeRequest(BaseModel):
    run_id: int | None = Field(default=None, alias="runId")
    force: bool = False

    model_config = {"populate_by_name": True}


def _resolve_run(
    db: Session, meeting_id: int, requested_run_id: int | None
) -> MeetingAnalysisRun | None:
    if requested_run_id is not None:
        return (
            db.query(MeetingAnalysisRun)
            .filter(
                MeetingAnalysisRun.id == requested_run_id,
                MeetingAnalysisRun.meeting_id == meeting_id,
            )
            .first()
        )
    run_id = resolve_latest_run_id(db, meeting_id)
    if run_id is None:
        return None
    return db.query(MeetingAnalysisRun).filter(MeetingAnalysisRun.id == run_id).first()


def _enqueue_canonicalize(meeting_id: int, run_id: int) -> str:
    from app.tasks import canonicalize_and_persist

    try:
        async_result = canonicalize_and_persist.delay(meeting_id, run_id)
        return str(async_result.id or "")
    except Exception as celery_error:
        logger.warning(
            "event=TRANSCRIPT_QUALITY_ASYNC_FALLBACK meetingId={} reason={}",
            meeting_id,
            type(celery_error).__name__,
        )
        import asyncio
        import threading

        from app.database import SessionLocal
        from app.services.canonical_persist_service import canonicalize_and_persist_run

        def _fallback_sync() -> None:
            db = SessionLocal()
            try:
                canonicalize_and_persist_run(db, meeting_id, run_id)
            finally:
                db.close()

        try:
            loop = asyncio.get_running_loop()
            loop.run_in_executor(None, _fallback_sync)
        except RuntimeError:
            threading.Thread(target=_fallback_sync, daemon=True).start()
        return ""


@router.post("/{meeting_id}/canonicalize", status_code=202)
def request_canonicalize(
    meeting_id: int,
    body: CanonicalizeRequest | None = None,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    if not settings.transcript_quality_enabled:
        return {"taskId": ""}

    requested_run_id = body.run_id if body else None
    run = _resolve_run(db, meeting_id, requested_run_id)
    if run is None:
        from app.tasks import canonicalize_deferred_retry

        try:
            canonicalize_deferred_retry.apply_async(
                args=[meeting_id, 1],
                countdown=5,
            )
        except Exception:
            logger.warning(
                "event=TRANSCRIPT_QUALITY_SKIP_NO_RUN meetingId={} attemptCount=0",
                meeting_id,
            )
        return {"taskId": ""}

    version, canonical_hash = preview_canonical_hash(db, meeting_id)
    skip_reason = check_idempotent_skip(
        meeting_id,
        run.id,
        canonical_hash,
        run.canonical_transcript_hash,
    )
    if skip_reason and not (body and body.force):
        log_idempotent_skip(meeting_id, run.id, canonical_hash, skip_reason)
        return {"taskId": ""}

    mark_inflight(meeting_id, run.id, canonical_hash)
    task_id = _enqueue_canonicalize(meeting_id, run.id)
    return {"taskId": task_id}


@router.get("/{meeting_id}/transcript-quality")
def get_transcript_quality(
    meeting_id: int,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    run_id = resolve_latest_run_id(db, meeting_id)
    if run_id is None:
        return {"meetingId": meeting_id, "ready": False}

    run = db.query(MeetingAnalysisRun).filter(MeetingAnalysisRun.id == run_id).first()
    if run is None:
        return {"meetingId": meeting_id, "ready": False}

    return build_transcript_quality_dto(run, meeting_id)
