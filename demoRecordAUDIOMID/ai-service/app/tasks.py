from loguru import logger

from app.celery_app import celery_app
from app.config import get_settings
from app.database import SessionLocal
from app.job_status_store import set_job_status
from app.logging_utils import safe_error_message
from app.services.glossary_repository import GlossaryRepository
from app.services.glossary_service import GlossaryService

try:
    from app.pipeline import ProcessingPipeline
except Exception as pipeline_import_error:
    ProcessingPipeline = None
    logger.warning(
        f"Pipeline modules unavailable in worker: {repr(pipeline_import_error)}"
    )

pipeline = ProcessingPipeline() if ProcessingPipeline is not None else None
settings = get_settings()


def _infer_batch_failure_stage(exc: Exception) -> str:
    error_type = type(exc).__name__
    message = f"{error_type}:{exc}".lower()
    if error_type == "TypeError" and "len()" in message:
        return "speech_recognition"
    if any(
        token in message
        for token in ("glossary", "speech", "stt", "transcri", "whisper", "deepgram")
    ):
        return "speech_recognition"
    if any(token in message for token in ("audio", "file not found", "load_audio")):
        return "audio_load"
    if any(token in message for token in ("analysis", "gemini")):
        return "analysis"
    return "pipeline"


def _build_batch_failure_error(exc: Exception) -> str:
    error_type = type(exc).__name__
    stage = _infer_batch_failure_stage(exc)
    error_code = str(getattr(exc, "error_code", None) or "").strip()
    if error_code:
        return (
            f"BATCH_PIPELINE_FAILED errorCode={error_code} "
            f"errorType={error_type} stage={stage}"
        )
    return f"BATCH_PIPELINE_FAILED errorType={error_type} stage={stage}"


def _resolve_glossary_context(payload: dict, db) -> dict | None:
    glossary_ref = payload.get("glossary_ref")
    topic = payload.get("topic")
    if not glossary_ref and not topic:
        return None

    if hasattr(glossary_ref, "model_dump"):
        glossary_ref = glossary_ref.model_dump()

    if glossary_ref is not None and not isinstance(glossary_ref, dict):
        return None
    glossary_ref = glossary_ref or {}

    service = GlossaryService(
        GlossaryRepository(db), cache_ttl_seconds=settings.glossary_cache_ttl_seconds
    )

    glossary_id = glossary_ref.get("glossary_id")
    glossary_version_id = None
    resolved_domain = glossary_ref.get("domain") or topic
    if glossary_id is not None:
        try:
            glossary_version_id = int(glossary_id)
        except (TypeError, ValueError):
            glossary_version_id = None
        if glossary_version_id is not None:
            domain_from_version = service.resolve_domain_for_version(
                glossary_version_id
            )
            if domain_from_version:
                resolved_domain = domain_from_version

    snapshot = service.get_snapshot(resolved_domain)
    requested_hash = glossary_ref.get("version_hash") or snapshot.version_hash
    if (
        glossary_ref.get("version_hash")
        and glossary_ref.get("version_hash") != snapshot.version_hash
    ):
        logger.warning(
            f"Glossary version hash mismatch: requested={glossary_ref.get('version_hash')} resolved={snapshot.version_hash}"
        )

    return {
        "glossary_id": (
            glossary_version_id
            if glossary_version_id is not None
            else snapshot.version_id
        ),
        "domain": resolved_domain,
        "version_id": snapshot.version_id,
        "version_hash": requested_hash,
        "resolved_version_hash": snapshot.version_hash,
        "terms": snapshot.terms,
        "topic_defaults": snapshot.topic_defaults,
        "normalization_map": snapshot.normalization_map,
    }


@celery_app.task(name="app.tasks.process_meeting")
def process_meeting(payload: dict) -> None:
    meeting_id = int(payload["meeting_id"])
    trace_id = payload.get("trace_id")
    file_id = payload.get("file_id")
    db = SessionLocal()

    result_data = {
        "transcripts": [],
    }

    try:
        if pipeline is None:
            raise RuntimeError("Processing pipeline dependencies are not available")

        glossary_context = _resolve_glossary_context(payload, db)

        logger.info(f"[traceId={trace_id}] [jobId={meeting_id}] update RUNNING")
        set_job_status(meeting_id, "RUNNING", file_id=file_id, trace_id=trace_id)

        process_result = pipeline.process_meeting(
            audio_path=payload["audio_path"],
            meeting_id=meeting_id,
            db=db,
            topic=payload.get("topic"),
            glossary_terms=payload.get("glossary_terms"),
            glossary_context=glossary_context,
            language=payload.get("language"),
            trace_id=trace_id,
            owner_user_id=payload.get("owner_user_id"),
            domain_mode=payload.get("domain_mode"),
        )

        transcripts = pipeline.get_transcript(meeting_id, db)
        if transcripts:
            result_data["transcripts"] = [
                {
                    "speaker": item.speaker,
                    "start_time": item.start_time,
                    "end_time": item.end_time,
                    "text": item.text,
                }
                for item in transcripts
            ]

        analysis = None
        if isinstance(process_result, dict):
            analysis = process_result.get("analysis")

        if analysis is None:
            db_analysis = pipeline.get_analysis(meeting_id, db)
            if db_analysis:
                analysis = {
                    "summary": db_analysis.summary,
                    "keywords": db_analysis.keywords,
                    "technical_terms": db_analysis.technical_terms,
                    "action_items": db_analysis.action_items,
                    "created_at": (
                        db_analysis.created_at.isoformat()
                        if db_analysis.created_at
                        else None
                    ),
                    "glossary_domain": getattr(db_analysis, "glossary_domain", None),
                    "glossary_version_id": getattr(
                        db_analysis, "glossary_version_id", None
                    ),
                    "glossary_version_hash": getattr(
                        db_analysis, "glossary_version_hash", None
                    ),
                }

        if analysis:
            result_data["analysis"] = analysis
            try:
                from app.config import get_settings
                from app.services.embedding_service import index_meeting_for_search

                summary_text = ""
                if isinstance(analysis, dict):
                    summary_text = str(
                        analysis.get("summary") or analysis.get("meetingSummary") or ""
                    )
                index_meeting_for_search(
                    settings=get_settings(),
                    meeting_id=meeting_id,
                    user_id=int(payload.get("owner_user_id") or 0),
                    title=str(payload.get("topic") or ""),
                    summary=summary_text,
                )
            except Exception as index_error:
                logger.warning(
                    "embedding_index_after_process_failed meetingId={} error={}",
                    meeting_id,
                    index_error,
                )

        set_job_status(
            meeting_id,
            "COMPLETED",
            result=result_data,
            file_id=file_id,
            trace_id=trace_id,
        )
        logger.info(f"[traceId={trace_id}] [jobId={meeting_id}] update COMPLETED")
    except Exception as processing_error:
        from app.services.analysis_errors import AnalysisProviderError

        error_type = type(processing_error).__name__
        stage = _infer_batch_failure_stage(processing_error)
        logger.error(
            "event=BATCH_PIPELINE_FAILED meetingId={} jobId={} errorType={} stage={} traceId={} error={}",
            meeting_id,
            meeting_id,
            error_type,
            stage,
            trace_id,
            safe_error_message(processing_error),
        )
        set_job_status(
            meeting_id,
            "FAILED",
            error=_build_batch_failure_error(processing_error),
            file_id=file_id,
            trace_id=trace_id,
            stage="failed",
        )
        # Provider errors are pickle-safe and already recorded in job state.
        # Do not re-raise them so the worker stays healthy (Celery task returns).
        if isinstance(processing_error, AnalysisProviderError):
            return
        raise
    finally:
        db.close()


@celery_app.task(name="app.tasks.analysis_retry_scheduled")
def analysis_retry_scheduled() -> int:
    """Scan Redis retry queue and dispatch due background analysis retries."""
    import httpx

    from app.job_status_store import _get_client
    from app.main import _analysis_lock_key
    from app.services.analysis_lock import is_ai_owned_lock, parse_lock_payload
    from app.services.analysis_retry_scheduler import (
        enqueue_background_retry,
        pop_due_retries,
    )

    if not settings.analysis_background_retry_enabled:
        return 0

    client = _get_client()
    entries = pop_due_retries(client)
    dispatched = 0
    for entry in entries:
        lock_key = _analysis_lock_key(entry.meeting_id)
        holder_raw = client.get(lock_key)
        if holder_raw and is_ai_owned_lock(holder_raw):
            holder = parse_lock_payload(holder_raw)
            logger.info(
                "ANALYSIS_LOCK_DEFERRED meetingId={} triggerSource=background holderTraceId={}",
                entry.meeting_id,
                holder.get("traceId"),
            )
            enqueue_background_retry(
                client,
                meeting_id=entry.meeting_id,
                analysis_attempt=entry.analysis_attempt,
                analysis_input_hash=entry.analysis_input_hash,
                trace_id=entry.trace_id,
                source=entry.source,
                max_attempts=settings.analysis_background_retry_max_attempts,
                enabled=True,
            )
            continue

        logger.info(
            "ANALYSIS_BACKGROUND_RETRY_DISPATCH meetingId={} analysisAttempt={} traceId={}",
            entry.meeting_id,
            entry.analysis_attempt,
            entry.trace_id,
        )
        payload: dict = {
            "meeting_id": entry.meeting_id,
            "mode": "failed_retry",
            "source": entry.source,
        }
        db = SessionLocal()
        try:
            from app.services.stt_persistence import TranscriptPersistenceRepository

            repository = TranscriptPersistenceRepository(db)
            scope = repository.resolve_preferred_transcript_scope(entry.meeting_id)
            transcript_text = repository.assemble_meeting_analysis_transcript_text(
                entry.meeting_id
            )
            if not transcript_text.strip():
                logger.warning(
                    "ANALYSIS_BACKGROUND_RETRY_SKIPPED meetingId={} reason=EMPTY_TRANSCRIPT "
                    "scope={}",
                    entry.meeting_id,
                    (
                        f"v2:{scope.get('recordingSessionId')}:{scope.get('attemptId')}"
                        if scope and scope.get("scopeKind") == "v2"
                        else (scope.get("scopeKind") if scope else "none")
                    ),
                )
                continue
            if scope and scope.get("scopeKind") == "v2":
                payload["recording_session_id"] = int(scope["recordingSessionId"])
                payload["attempt_id"] = int(scope["attemptId"])
            payload["transcript"] = transcript_text
        finally:
            db.close()

        try:
            response = httpx.post(
                f"{settings.internal_api_base_url.rstrip('/')}/api/internal/realtime-analysis",
                json=payload,
                timeout=30.0,
            )
            if response.status_code < 500:
                dispatched += 1
        except Exception as dispatch_error:
            logger.warning(
                "ANALYSIS_BACKGROUND_RETRY_DISPATCH_FAILED meetingId={} error={}",
                entry.meeting_id,
                safe_error_message(dispatch_error),
            )
    return dispatched


@celery_app.task(
    name="app.tasks.canonicalize_and_persist",
    autoretry_for=(Exception,),
    retry_backoff=60,
    max_retries=3,
)
def canonicalize_and_persist(meeting_id: int, run_id: int) -> dict:
    """Persist canonical transcript rows + evidence stats on meeting_analysis_runs."""
    import time

    from app.observability.celery_trace import celery_task_span
    from app.services.canonical_persist_service import canonicalize_and_persist_run

    trace_id = f"canonicalize-{meeting_id}-{run_id}"
    with celery_task_span(
        "canonicalize_and_persist", meeting_id=meeting_id, trace_id=trace_id
    ):
        db = SessionLocal()
        started = time.perf_counter()
        try:
            return canonicalize_and_persist_run(db, meeting_id, run_id)
        except Exception as exc:
            duration_ms = int((time.perf_counter() - started) * 1000)
            logger.error(
                "event=TRANSCRIPT_QUALITY_PERSIST_FAILED meetingId={} errorCode={} durationMs={} traceId={}",
                meeting_id,
                type(exc).__name__,
                duration_ms,
                trace_id,
            )
            raise
        finally:
            db.close()


@celery_app.task(name="app.tasks.canonicalize_deferred_retry")
def canonicalize_deferred_retry(meeting_id: int, attempt: int = 1) -> dict:
    """Retry run resolution when no analysis run exists yet (§5.3.1)."""
    from app.observability.celery_trace import celery_task_span
    from app.services.canonical_persist_service import resolve_latest_run_id

    trace_id = f"canonicalize-deferred-{meeting_id}-a{attempt}"
    with celery_task_span(
        "canonicalize_deferred_retry", meeting_id=meeting_id, trace_id=trace_id
    ):
        db = SessionLocal()
        try:
            run_id = resolve_latest_run_id(db, meeting_id)
            if run_id is None:
                if attempt >= 5:
                    logger.warning(
                        "event=TRANSCRIPT_QUALITY_SKIP_NO_RUN meetingId={} attemptCount={} traceId={}",
                        meeting_id,
                        attempt,
                        trace_id,
                    )
                    return {"status": "skipped", "attempt": attempt}
                canonicalize_deferred_retry.apply_async(
                    args=[meeting_id, attempt + 1],
                    countdown=5,
                )
                return {"status": "deferred", "attempt": attempt}

            return canonicalize_and_persist(meeting_id, run_id)
        finally:
            db.close()
