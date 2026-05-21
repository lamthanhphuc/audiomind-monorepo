import asyncio
import sys
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

import numpy as np
from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from loguru import logger
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from sqlalchemy import text
from sqlalchemy.orm import Session
from starlette.requests import Request
from starlette.responses import Response

from app.config import get_runtime_device, get_settings
from app.database import (
    Base,
    engine,
    ensure_bigint_meeting_id,
    get_db,
    wait_for_database,
)
from app.ffmpeg_utils import ensure_ffmpeg_on_path
from app.job_status_store import (
    _get_client,
    cleanup_expired_job_statuses,
    get_job_status,
    load_job_statuses,
    set_job_status,
)
from app.metrics import stt_metrics
from app.schemas import (
    ActionItem,
    AnalysisResponse,
    ProcessRequest,
    ProcessResponse,
    SttStreamResponse,
    TranscriptResponse,
    TranscriptSegment,
)
from app.services.glossary_repository import GlossaryRepository
from app.services.glossary_service import GlossaryService
from app.services.grpc_stt_service import AiStreamServicer, create_grpc_server
from app.services.stt_adapter import (
    DeepgramSTTAdapter,
    is_terminal_error,
    is_transient_error,
)
from app.services.stt_ownership import (
    SttLease,
    SttOwnershipLost,
    get_stt_ownership_manager,
)
from app.services.stt_persistence import TranscriptPersistenceRepository
from app.services.stt_session_actor import MeetingSessionActor, MeetingSessionState
from app.tasks import process_meeting

try:
    from app.pipeline import ProcessingPipeline
except Exception as pipeline_import_error:
    ProcessingPipeline = None
    logger.warning(f"Pipeline modules unavailable: {repr(pipeline_import_error)}")

# Configure logging
logger.remove()
logger.add(sys.stderr, level="INFO", serialize=True)
logger.add("logs/app.log", rotation="500 MB", level="DEBUG", serialize=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Manage startup and shutdown lifecycle."""
    ensure_runtime_dirs()
    load_job_statuses(recover_interrupted=True)
    cleanup_expired_job_statuses()
    is_production = (settings.app_env or "").strip().lower() in {"prod", "production"}

    try:
        wait_for_database()
    except Exception as e:
        if is_production:
            raise RuntimeError(
                "Database connectivity check failed during production startup"
            ) from e
        logger.warning(f"Database connectivity check skipped: {repr(e)}")

    try:
        ensure_bigint_meeting_id()
    except Exception as e:
        if is_production:
            raise RuntimeError(
                "Database migration step failed during production startup"
            ) from e
        logger.warning(f"Database migration step skipped: {repr(e)}")

    try:
        Base.metadata.create_all(bind=engine)
    except Exception as e:
        if is_production:
            raise RuntimeError(
                "Database schema initialization failed during production startup"
            ) from e
        logger.warning(f"Database schema initialization failed: {repr(e)}")

    try:
        ensure_ffmpeg_on_path(log=True)
    except Exception as e:
        logger.warning(f"FFmpeg bootstrap warning: {repr(e)}")

    logger.info("=" * 50)
    logger.info("AudioMind AI Service Starting...")
    logger.info(f"Whisper Model: {settings.whisper_model}")
    logger.info(f"Device: {get_runtime_device()}")
    logger.info(
        "STT CONFIG api_key_exists={} model={} base_url={}",
        bool(settings.deepgram_api_key),
        settings.deepgram_model,
        settings.deepgram_base_url,
    )
    logger.info("=" * 50)

    grpc_server = None
    grpc_thread = None
    try:
        stt_adapter = _get_stt_adapter()
        if stt_adapter:
            servicer = AiStreamServicer(stt_adapter)
            grpc_server = create_grpc_server(servicer)
            grpc_thread = threading.Thread(target=grpc_server.start, daemon=True)
            grpc_thread.start()
    except Exception as e:
        logger.warning(f"Failed to start gRPC server: {repr(e)}")
    yield

    await _shutdown_all_stt_actors()
    if grpc_server:
        try:
            grpc_server.stop(grace=5)
        except Exception as e:
            logger.warning(f"Error during gRPC server shutdown: {repr(e)}")
    cleanup_expired_job_statuses()
    logger.info("AudioMind AI Service Shutting Down...")


def _extract_latest_transcript_event(
    events: list[dict[str, object]],
    fallback_transcript: str = "",
) -> tuple[str, bool, float | None]:
    transcript = fallback_transcript
    is_final = False
    confidence: float | None = None

    for event in reversed(events):
        text = str(event.get("text") or "").strip()
        if text:
            transcript = text
            is_final = bool(event.get("is_final"))
            confidence_value = event.get("confidence")
            if isinstance(confidence_value, (int, float)):
                confidence = float(confidence_value)
            break

    return transcript, is_final, confidence


async def _close_stt_session(meeting_id: int) -> None:
    actor = _stt_stream_sessions.pop(_normalize_meeting_key(meeting_id), None)
    if actor is None:
        return

    try:
        await actor.shutdown()
    finally:
        if actor.session_id:
            actor.adapter.get_raw_response(actor.session_id)
        _clear_stream_retry_guard(_normalize_meeting_key(meeting_id))


async def _retire_stt_actor(
    meeting_key: str, actor: MeetingSessionActor, *, clear_retry_guard: bool = False
) -> None:
    async with _stt_stream_registry_lock:
        if _stt_stream_sessions.get(meeting_key) is actor:
            _stt_stream_sessions.pop(meeting_key, None)

    try:
        await actor.shutdown(grace_seconds=settings.stt_shutdown_grace_seconds)
    except Exception as exc:
        logger.warning(
            "STT_ACTOR_RETIREMENT_ERROR meeting_id={} error={}",
            meeting_key,
            repr(exc),
        )
    finally:
        if clear_retry_guard:
            _clear_stream_retry_guard(meeting_key)


def _default_retry_guard_snapshot() -> dict[str, object]:
    return {
        "cooldown_until": 0.0,
        "requires_new_stream": False,
        "last_terminal_close_code": None,
        "last_terminal_close_reason": None,
        "last_terminal_close_error": None,
    }


def _retry_guard_snapshot_from_actor(actor: MeetingSessionActor) -> dict[str, object]:
    snapshot = _default_retry_guard_snapshot()
    snapshot_getter = getattr(actor, "retry_guard_snapshot", None)
    if not callable(snapshot_getter):
        return snapshot

    try:
        candidate = snapshot_getter()
    except Exception as exc:
        logger.warning(
            "STT_RETRY_GUARD_SNAPSHOT_FAILED meeting_id={} error={}",
            getattr(actor, "meeting_key", None),
            repr(exc),
        )
        return snapshot

    if isinstance(candidate, dict):
        snapshot.update(candidate)
    return snapshot


settings = get_settings()

app = FastAPI(lifespan=lifespan)

_stt_adapter: DeepgramSTTAdapter | None = None
_stt_stream_sessions: dict[str, MeetingSessionActor] = {}
_stt_stream_registry_lock = asyncio.Lock()
_stt_stream_retry_guards: dict[str, "MeetingStreamRetryGuard"] = {}
_stt_finalized_responses: dict[str, tuple[SttStreamResponse, float]] = {}
_STT_FINALIZED_RESPONSE_TTL_SECONDS = 300.0


@dataclass
class MeetingStreamRetryGuard:
    cooldown_until: float = 0.0
    requires_new_stream: bool = False
    last_seq: int = 0
    last_seen_at: float = 0.0
    last_terminal_seq: int = 0
    last_terminal_close_code: str | None = None
    last_terminal_close_reason: str | None = None
    last_terminal_close_error: str | None = None


def _normalize_meeting_key(meeting_id: int | str) -> str:
    return str(meeting_id).strip()


def _normalize_stt_language(language: str | None) -> str:
    value = (language or "vi").strip()
    return value or "vi"


def _is_webm_header_chunk(chunk_bytes: bytes) -> bool:
    return bytes(chunk_bytes[:4]) == bytes.fromhex("1a45dfa3")


def _get_stream_retry_guard(meeting_key: str) -> MeetingStreamRetryGuard:
    guard = _stt_stream_retry_guards.get(meeting_key)
    if guard is None:
        guard = MeetingStreamRetryGuard()
        _stt_stream_retry_guards[meeting_key] = guard
    return guard


def _clear_stream_retry_guard(meeting_key: str) -> None:
    _stt_stream_retry_guards.pop(meeting_key, None)


def _update_stream_retry_guard_from_actor(
    meeting_key: str, actor: MeetingSessionActor
) -> None:
    snapshot = _retry_guard_snapshot_from_actor(actor)
    guard = _get_stream_retry_guard(meeting_key)
    guard.cooldown_until = max(
        guard.cooldown_until, float(snapshot.get("cooldown_until") or 0.0)
    )
    guard.requires_new_stream = bool(
        snapshot.get("requires_new_stream") or guard.requires_new_stream
    )
    guard.last_terminal_close_code = snapshot.get("last_terminal_close_code")
    guard.last_terminal_close_reason = snapshot.get("last_terminal_close_reason")
    guard.last_terminal_close_error = snapshot.get("last_terminal_close_error")
    guard.last_terminal_seq = max(
        guard.last_terminal_seq, int(getattr(actor, "_last_ack_seq", 0) or 0)
    )


def _describe_terminal_error(exc: BaseException) -> tuple[str | None, str | None, str]:
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        code = getattr(current, "code", None)
        reason = getattr(current, "reason", None)
        if code is not None or reason is not None:
            return (
                None if code is None else str(code),
                None if reason is None else str(reason),
                type(current).__name__,
            )
        current = current.__cause__ or current.__context__
    return None, None, type(exc).__name__


def _purge_stt_finalized_responses() -> None:
    now = time.time()
    expired_keys = [
        meeting_key
        for meeting_key, (_, stored_at) in _stt_finalized_responses.items()
        if now - stored_at > _STT_FINALIZED_RESPONSE_TTL_SECONDS
    ]
    for meeting_key in expired_keys:
        _stt_finalized_responses.pop(meeting_key, None)


def _get_cached_final_response(meeting_key: str) -> SttStreamResponse | None:
    _purge_stt_finalized_responses()
    cached_entry = _stt_finalized_responses.get(meeting_key)
    if cached_entry is None:
        return None
    return cached_entry[0]


def _store_final_response(meeting_key: str, response: SttStreamResponse) -> None:
    _stt_finalized_responses[meeting_key] = (response, time.time())


def _stt_registry_summary() -> dict[str, int]:
    summary: dict[str, int] = {}
    for actor in _stt_stream_sessions.values():
        summary[actor.state.value] = summary.get(actor.state.value, 0) + 1
    summary["total"] = len(_stt_stream_sessions)
    summary["cooldown"] = sum(
        1
        for guard in _stt_stream_retry_guards.values()
        if guard.cooldown_until > time.time()
    )
    return summary


async def _cleanup_stale_stt_actors() -> None:
    async with _stt_stream_registry_lock:
        stale_keys = [
            meeting_key
            for meeting_key, actor in _stt_stream_sessions.items()
            if actor.state in {MeetingSessionState.CLOSED, MeetingSessionState.FAILED}
        ]
        for meeting_key in stale_keys:
            _stt_stream_sessions.pop(meeting_key, None)


async def _get_or_create_stt_actor(
    meeting_key: str,
    normalized_language: str,
    *,
    seq: int | None = None,
    chunk_bytes: bytes | None = None,
) -> MeetingSessionActor:
    await _cleanup_stale_stt_actors()
    guard = _get_stream_retry_guard(meeting_key)
    now = time.time()
    stt_adapter = _get_stt_adapter()
    if stt_adapter is None:
        raise RuntimeError("Deepgram STT adapter is unavailable")

    ownership_manager = get_stt_ownership_manager()
    shared_cooldown_until = 0.0
    if ownership_manager is not None:
        try:
            shared_cooldown_until = ownership_manager.get_cooldown_until(meeting_key)
        except Exception as exc:
            logger.warning(
                "STT_OWNERSHIP_COOLDOWN_READ_ERROR meeting_id={} error={}",
                meeting_key,
                repr(exc),
            )
            raise HTTPException(
                status_code=503,
                detail="STT ownership store is unavailable",
            ) from exc
        guard.cooldown_until = max(guard.cooldown_until, shared_cooldown_until)

    if guard.cooldown_until > now:
        stt_metrics.ownership_event("cooldown_hit")
        retry_after_seconds = max(1, int(guard.cooldown_until - now + 0.999))
        raise HTTPException(
            status_code=429,
            detail={
                "meeting_id": meeting_key,
                "seq": seq,
                "reason": "reconnect cooldown active",
                "retry_after_seconds": retry_after_seconds,
            },
            headers={"Retry-After": str(retry_after_seconds)},
        )

    if guard.requires_new_stream:
        can_restart = (
            seq == 1 and chunk_bytes is not None and _is_webm_header_chunk(chunk_bytes)
        )
        if can_restart:
            _clear_stream_retry_guard(meeting_key)
        else:
            raise HTTPException(
                status_code=409,
                detail={
                    "meeting_id": meeting_key,
                    "seq": seq,
                    "reason": "new recording lifecycle required",
                },
            )

    async with _stt_stream_registry_lock:
        existing_actor = _stt_stream_sessions.get(meeting_key)
        if existing_actor is not None and existing_actor.state not in {
            MeetingSessionState.CLOSED,
            MeetingSessionState.FAILED,
        }:
            if not existing_actor._owns_meeting():
                _stt_stream_sessions.pop(meeting_key, None)
                asyncio.create_task(_retire_stt_actor(meeting_key, existing_actor))
            else:
                return existing_actor

        lease: SttLease | None = None
        if ownership_manager is not None:
            try:
                lease = ownership_manager.acquire(meeting_key)
            except Exception as exc:
                logger.warning(
                    "STT_OWNERSHIP_ACQUIRE_ERROR meeting_id={} error={}",
                    meeting_key,
                    repr(exc),
                )
                raise HTTPException(
                    status_code=503,
                    detail="STT ownership store is unavailable",
                ) from exc
            if lease is None:
                stt_metrics.ownership_event("acquire_conflict")
                raise HTTPException(
                    status_code=409,
                    detail={
                        "meeting_id": meeting_key,
                        "seq": seq,
                        "reason": "meeting STT stream is already owned by another replica",
                    },
                )

        try:
            actor = await MeetingSessionActor.create(
                meeting_key=meeting_key,
                language=normalized_language,
                adapter=stt_adapter,
                lease=lease,
                ownership_manager=ownership_manager,
            )
        except Exception:
            if lease is not None and ownership_manager is not None:
                try:
                    ownership_manager.release(lease)
                except Exception:
                    pass
            raise
        _stt_stream_sessions[meeting_key] = actor
        logger.info(
            "STT_OWNERSHIP_ACQUIRED meeting_id={} owner_id={} fencing_token={}",
            meeting_key,
            lease.owner_id if lease is not None else None,
            lease.fencing_token if lease is not None else 0,
        )
        if lease is not None:
            stt_metrics.ownership_event("acquired")
        return actor


async def _shutdown_all_stt_actors() -> None:
    async with _stt_stream_registry_lock:
        actors = list(_stt_stream_sessions.items())
        _stt_stream_sessions.clear()

    for meeting_key, actor in actors:
        try:
            logger.info(
                "STT_SHUTDOWN_DRAIN_BEGIN meeting_id={} session_id={}",
                meeting_key,
                actor.session_id,
            )
            await actor.shutdown(grace_seconds=settings.stt_shutdown_grace_seconds)
            logger.info(
                "STT_SHUTDOWN_DRAIN_END meeting_id={} session_id={}",
                meeting_key,
                actor.session_id,
            )
        except Exception as exc:
            logger.warning(
                "STT_SHUTDOWN_DRAIN_END meeting_id={} error={}",
                meeting_key,
                repr(exc),
            )


def _get_stt_adapter() -> DeepgramSTTAdapter | None:
    global _stt_adapter

    if _stt_adapter is not None:
        return _stt_adapter

    if not (settings.deepgram_api_key or "").strip():
        return None

    _stt_adapter = DeepgramSTTAdapter(
        api_key=settings.deepgram_api_key,
        model=settings.deepgram_model,
        base_url=settings.deepgram_base_url,
        timeout_seconds=settings.deepgram_timeout_seconds,
        simplify_streaming_url=settings.deepgram_simplify_streaming_url,
        debug_raw_messages=settings.deepgram_debug_raw_messages,
        enable_speaker_diarization=settings.enable_speaker_diarization,
        deepgram_diarize=settings.deepgram_diarize,
    )
    return _stt_adapter


def _transcribe_locally(
    chunk_bytes: bytes, normalized_language: str, is_final: bool
) -> SttStreamResponse:
    recognizer = (
        getattr(pipeline, "speech_recognizer", None) if pipeline is not None else None
    )
    if recognizer is None:
        raise RuntimeError("Processing pipeline dependencies are not available")

    audio = np.frombuffer(chunk_bytes, dtype=np.int16)
    result = recognizer.transcribe_segment(
        audio, sr=16000, language=normalized_language
    )
    transcript = (
        recognizer.get_full_text(result)
        if hasattr(recognizer, "get_full_text")
        else str(result)
    )
    confidence: float | None = None
    if isinstance(result, dict):
        segments = result.get("segments") or []
        if segments:
            first_segment = segments[0]
            if isinstance(first_segment, dict):
                confidence_value = first_segment.get("confidence")
                if isinstance(confidence_value, (int, float)):
                    confidence = float(confidence_value)

    return SttStreamResponse(
        transcript=transcript,
        is_final=is_final,
        confidence=confidence,
    )


pipeline = ProcessingPipeline() if ProcessingPipeline is not None else None


def _resolve_cors_origins() -> list[str]:
    raw_origins = (settings.cors_allowed_origins or "").split(",")
    return [origin.strip() for origin in raw_origins if origin.strip()]


def _glossary_service(db: Session) -> GlossaryService:
    return GlossaryService(
        GlossaryRepository(db), cache_ttl_seconds=settings.glossary_cache_ttl_seconds
    )


app.add_middleware(
    CORSMiddleware,
    allow_origins=_resolve_cors_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID", "X-Trace-ID"],
)


@app.middleware("http")
async def inject_trace_headers(request: Request, call_next) -> Response:
    trace_id = (
        request.headers.get("x-trace-id")
        or request.headers.get("x-request-id")
        or uuid4().hex
    )
    request_id = request.headers.get("x-request-id") or trace_id
    request.state.trace_id = trace_id
    request.state.request_id = request_id

    response = await call_next(request)
    response.headers["x-trace-id"] = trace_id
    response.headers["x-request-id"] = request_id
    logger.bind(trace_id=trace_id, request_id=request_id).debug(
        f"request completed path={request.url.path} status={response.status_code}"
    )
    return response


def ensure_runtime_dirs() -> None:
    """Create writable runtime directories for mounted volumes in containers."""
    for runtime_dir in (
        Path("/app/models"),
        Path("/app/uploads"),
        Path("/app/storage"),
        Path("/app/storage/uploads"),
        Path("./storage"),
    ):
        runtime_dir.mkdir(parents=True, exist_ok=True)
        try:
            runtime_dir.chmod(0o775)
        except OSError as permission_error:
            logger.warning(
                f"Could not update permissions for {runtime_dir}: {permission_error}"
            )


def resolve_upload_dir() -> Path:
    """Pick the first writable upload directory shared across API and worker containers."""
    candidates = (
        Path("/app/uploads"),
        Path("/app/storage/uploads"),
        Path("./storage/uploads"),
    )
    for upload_dir in candidates:
        try:
            upload_dir.mkdir(parents=True, exist_ok=True)
            probe_file = upload_dir / ".write_probe"
            with probe_file.open("wb") as probe:
                probe.write(b"ok")
            probe_file.unlink(missing_ok=True)
            return upload_dir
        except OSError as permission_error:
            logger.warning(
                f"Upload dir not writable ({upload_dir}): {permission_error}"
            )

    raise RuntimeError("No writable upload directory is available")


@app.get("/api/meeting/{meeting_id}/transcript", response_model=TranscriptResponse)
async def get_transcript(meeting_id: int, db: Session = Depends(get_db)):
    """
    Get transcript for a meeting

    Returns all transcript segments with speaker labels and timestamps
    """
    try:
        logger.info(f"Fetching transcript for meeting {meeting_id}")

        fragment_segments = []
        try:
            fragment_repository = TranscriptPersistenceRepository(db)
            fragment_segments = (
                fragment_repository.assemble_visible_transcript_segments(meeting_id)
            )
        except AttributeError:
            fragment_segments = []

        if fragment_segments:
            logger.info(
                "STT_TRANSCRIPT_GET meeting_id={} source={} rows={}",
                meeting_id,
                "transcript_fragments_visible",
                len(fragment_segments),
            )
            return TranscriptResponse(
                meeting_id=meeting_id,
                transcripts=[
                    TranscriptSegment(
                        speaker=str(segment.get("speaker") or "system"),
                        start_time=float(segment.get("start_time") or 0.0),
                        end_time=float(segment.get("end_time") or 0.0),
                        text=str(segment.get("text") or ""),
                    )
                    for segment in fragment_segments
                    if str(segment.get("text") or "").strip()
                ],
            )

        if pipeline is None:
            logger.info(
                "STT_TRANSCRIPT_GET meeting_id={} source={} rows={}",
                meeting_id,
                "none",
                0,
            )
            raise HTTPException(
                status_code=404,
                detail="No transcript found for meeting; no speech was detected or no transcript fragments were persisted",
            )

        transcripts = pipeline.get_transcript(meeting_id, db)

        if not transcripts:
            logger.info(
                "STT_TRANSCRIPT_GET meeting_id={} source={} rows={}",
                meeting_id,
                "none",
                0,
            )
            raise HTTPException(
                status_code=404,
                detail="No transcript found for meeting; no speech was detected or no transcript fragments were persisted",
            )

        logger.info(
            "STT_TRANSCRIPT_GET meeting_id={} source={} rows={}",
            meeting_id,
            "transcripts",
            len(transcripts),
        )

        segments = [
            TranscriptSegment(
                speaker=t.speaker,
                start_time=t.start_time,
                end_time=t.end_time,
                text=t.text,
            )
            for t in transcripts
        ]

        return TranscriptResponse(meeting_id=meeting_id, transcripts=segments)

    except HTTPException:
        raise
    except Exception as e:
        request_id = uuid4().hex
        logger.error(f"Error fetching transcript request_id={request_id}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error. request_id={request_id}",
        )


@app.get("/api/meeting/{meeting_id}/status")
async def get_processing_status(meeting_id: int):
    status = get_job_status(meeting_id)

    if status is None:
        raise HTTPException(status_code=404, detail="Meeting job status not found")

    return status


@app.get("/api/meeting/{meeting_id}/analysis", response_model=AnalysisResponse)
async def get_analysis(meeting_id: int, db: Session = Depends(get_db)):
    """
    Get AI analysis for a meeting

    Returns summary, keywords, technical terms, and action items
    """
    try:
        if pipeline is None:
            raise HTTPException(
                status_code=503,
                detail="Processing pipeline dependencies are not available",
            )

        logger.info(f"Fetching analysis for meeting {meeting_id}")

        analysis = pipeline.get_analysis(meeting_id, db)

        if not analysis:
            raise HTTPException(status_code=404, detail="Analysis not found")

        action_items = [ActionItem(**item) for item in analysis.action_items]

        return AnalysisResponse(
            meeting_id=meeting_id,
            summary=analysis.summary,
            keywords=analysis.keywords,
            technical_terms=analysis.technical_terms,
            action_items=action_items,
            created_at=analysis.created_at,
        )

    except HTTPException:
        raise
    except Exception as e:
        request_id = uuid4().hex
        logger.error(f"Error fetching analysis request_id={request_id}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error. request_id={request_id}",
        )


@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "service": "AudioMind AI Service",
        "version": "1.0.0",
        "status": "running",
    }


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    await _cleanup_stale_stt_actors()
    return {
        "status": "healthy",
        "whisper_model": settings.whisper_model,
        "device": get_runtime_device(),
        "lazy_load_models": settings.lazy_load_models,
        "enable_speaker_diarization": settings.enable_speaker_diarization,
        "stt_actor_registry": _stt_registry_summary(),
    }


@app.get("/metrics")
async def metrics() -> Response:
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/ready")
async def readiness_check():
    await _cleanup_stale_stt_actors()
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    _get_client().ping()
    if pipeline is None:
        raise HTTPException(status_code=503, detail="Pipeline dependencies unavailable")
    return {
        "status": "ready",
        "service": "ai-service",
        "stt_actor_registry": _stt_registry_summary(),
    }


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    trace_id = getattr(request.state, "trace_id", uuid4().hex)
    logger.exception(f"Unhandled exception trace_id={trace_id}: {repr(exc)}")
    return JSONResponse(
        status_code=500,
        content={
            "code": "INTERNAL_SERVER_ERROR",
            "message": "Unexpected server error",
            "trace_id": trace_id,
        },
    )


@app.post("/api/process", response_model=ProcessResponse)
async def process_audio(
    request: ProcessRequest,
    http_request: Request,
):
    """
    Queue audio file processing.

    Long-running model work executes in background task.
    """
    try:
        if pipeline is None:
            raise HTTPException(
                status_code=503,
                detail="Processing pipeline dependencies are not available",
            )

        trace_id = request.trace_id or getattr(http_request.state, "trace_id", None)
        logger.info(
            f"[traceId={trace_id}] [jobId={request.meeting_id}] received process request"
        )

        set_job_status(
            request.meeting_id,
            "QUEUED",
            file_id=request.file_id,
            trace_id=trace_id,
            progress=0,
            stage="uploading",
        )
        payload = request.model_dump()
        payload["trace_id"] = trace_id
        process_meeting.delay(payload)

        return ProcessResponse(
            meeting_id=request.meeting_id,
            status="queued",
            message="Processing job queued",
        )

    except HTTPException:
        raise
    except Exception as e:
        request_id = uuid4().hex
        logger.exception(
            f"Unexpected processing error request_id={request_id}: {repr(e)}"
        )
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error. request_id={request_id}",
        )


@app.post("/api/v1/process")
async def process_mock_v1(_: dict):
    """Deprecated endpoint retained for migration notice only."""
    raise HTTPException(
        status_code=410,
        detail="/api/v1/process is deprecated. Use /api/process with upload-audio flow.",
    )


@app.post("/api/upload-audio")
async def upload_audio(file: UploadFile = File(...)):
    try:
        uploads_dir = resolve_upload_dir()

        original_name = Path(file.filename or "audio.wav").name
        extension = (Path(original_name).suffix or ".wav").lower()
        allowed_extensions = {
            item.strip().lower()
            for item in settings.allowed_upload_extensions.split(",")
            if item.strip()
        }
        if extension not in allowed_extensions:
            raise HTTPException(
                status_code=415, detail="Unsupported audio file extension"
            )
        saved_name = f"{uuid4().hex}{extension}"
        saved_path = uploads_dir / saved_name

        total_bytes = 0
        chunk_size = 1024 * 1024

        with saved_path.open("wb") as output_file:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > settings.max_upload_size_bytes:
                    output_file.close()
                    saved_path.unlink(missing_ok=True)
                    raise HTTPException(status_code=413, detail="File too large")
                output_file.write(chunk)

        await file.close()

        return {
            "audio_path": str(saved_path),
            "original_filename": original_name,
        }
    except HTTPException:
        raise
    except Exception as e:
        request_id = uuid4().hex
        logger.exception(f"Upload audio error request_id={request_id}: {repr(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error. request_id={request_id}",
        )


@app.post("/api/stt/stream")
async def open_stt_session(payload: dict = Body(default_factory=dict)):
    meeting_id = payload.get("meeting_id")
    if meeting_id is None:
        raise HTTPException(status_code=400, detail="meeting_id is required")

    language = _normalize_stt_language(payload.get("language"))
    actor = await _get_or_create_stt_actor(_normalize_meeting_key(meeting_id), language)

    return {
        "session_id": actor.session_id,
        "status": "opened",
        "meeting_id": meeting_id,
        "language": actor.language,
    }


@app.post("/api/v1/stt/stream", response_model=SttStreamResponse)
async def stream_stt_chunk(
    meeting_id: int = Form(...),
    audio_chunk: UploadFile = File(...),
    seq: int = Form(...),
    language: str = Form(default="vi"),
    is_final: bool = Form(default=False),
):
    normalized_language = _normalize_stt_language(language)
    chunk_bytes = await audio_chunk.read()
    logger.info(
        "stream_stt_chunk received meeting_id={} seq={} byteLength={}",
        meeting_id,
        seq,
        len(chunk_bytes),
    )
    logger.info(
        "WEBM_HEADER_CHECK seq={} first4hex={} matches_ebml={}",
        seq,
        chunk_bytes[:4].hex(),
        bool(chunk_bytes[:4] == bytes.fromhex("1a45dfa3")),
    )
    await audio_chunk.close()

    if not chunk_bytes and not is_final:
        raise HTTPException(status_code=400, detail="audio_chunk is empty")

    meeting_key = _normalize_meeting_key(meeting_id)
    now = time.time()
    guard = _get_stream_retry_guard(meeting_key)
    previous_seq = guard.last_seq
    previous_seen_at = guard.last_seen_at
    guard.last_seq = max(guard.last_seq, int(seq))
    guard.last_seen_at = now

    if previous_seq > 0:
        gap_ms = max(0, int((now - previous_seen_at) * 1000.0))
        if seq > previous_seq + 1 or gap_ms >= 1000:
            logger.warning(
                "STT_AUDIO_GAP meeting_id={} previous_seq={} next_seq={} gap_ms={}",
                meeting_key,
                previous_seq,
                seq,
                gap_ms,
            )

    if guard.cooldown_until > now:
        retry_after_seconds = max(1, int(guard.cooldown_until - now + 0.999))
        logger.warning(
            "STT_RECONNECT_COOLDOWN meeting_id={} seq={} cooldown_until={} now={}",
            meeting_key,
            seq,
            guard.cooldown_until,
            now,
        )
        raise HTTPException(
            status_code=429,
            detail={
                "meeting_id": meeting_key,
                "seq": seq,
                "reason": "reconnect cooldown active",
                "retry_after_seconds": retry_after_seconds,
            },
            headers={"Retry-After": str(retry_after_seconds)},
        )

    if guard.requires_new_stream and not (
        seq == 1 and _is_webm_header_chunk(chunk_bytes)
    ):
        logger.warning(
            "STT_RECONNECT_BLOCKED_WEBM_CONTINUATION meeting_id={} seq={} last_ack_seq={} reason={}",
            meeting_key,
            seq,
            guard.last_terminal_seq,
            guard.last_terminal_close_error
            or "new stream required after terminal websocket close",
        )
        raise HTTPException(
            status_code=409,
            detail={
                "meeting_id": meeting_key,
                "seq": seq,
                "reason": "new recording lifecycle required",
            },
        )

    if seq == 1 and _is_webm_header_chunk(chunk_bytes) and guard.requires_new_stream:
        _clear_stream_retry_guard(meeting_key)
        guard = _get_stream_retry_guard(meeting_key)

    cached_response = _get_cached_final_response(meeting_key)
    if cached_response is not None:
        logger.info(
            "STT_FINALIZATION_REPLAY meeting_id={} seq={} is_final={} reason=cached_final_response",
            meeting_key,
            seq,
            is_final,
        )
        if is_final:
            return cached_response
        raise HTTPException(status_code=409, detail="Meeting already finalized")

    try:
        actor = await _get_or_create_stt_actor(
            meeting_key,
            normalized_language,
            seq=seq,
            chunk_bytes=chunk_bytes,
        )
    except HTTPException:
        raise
    except Exception as exc:
        if (
            "unavailable" in str(exc).lower()
            and pipeline is not None
            and getattr(pipeline, "speech_recognizer", None) is not None
        ):
            logger.info(
                "STT_LOCAL_FALLBACK meeting_id={} seq={} reason=deepgram_unavailable",
                meeting_key,
                seq,
            )
            return _transcribe_locally(chunk_bytes, normalized_language, is_final)
        logger.exception("Failed to create STT session: {}", repr(exc))
        raise HTTPException(
            status_code=503,
            detail=f"Failed to initialize STT: {repr(exc)}",
        ) from exc

    try:
        if is_final:
            logger.info(
                "STT_SESSION_STATE meeting_id={} session_id={} seq={} action=finalize",
                meeting_key,
                actor.session_id,
                seq,
            )
            response = await actor.finalize(seq=int(seq), ts_ms=int(seq))
        else:
            logger.info(
                "STT_SESSION_STATE meeting_id={} session_id={} transition=ACTIVE->ACTIVE seq={} action=submit",
                meeting_key,
                actor.session_id,
                seq,
            )
            response = await actor.submit_chunk(
                seq=int(seq),
                pcm_chunk=chunk_bytes,
                ts_ms=int(seq),
                is_final=False,
            )
    except Exception as exc:
        if is_terminal_error(exc) or not is_transient_error(exc):
            code, reason, error_name = _describe_terminal_error(exc)
            logger.warning(
                "STT_TERMINAL_FAILURE meeting_id={} session_id={} seq={} code={} reason={} error={}",
                meeting_key,
                actor.session_id,
                seq,
                code,
                reason,
                error_name,
            )
            snapshot = _retry_guard_snapshot_from_actor(actor)
            guard.cooldown_until = max(
                guard.cooldown_until, float(snapshot.get("cooldown_until") or 0.0)
            )
            guard.requires_new_stream = bool(
                snapshot.get("requires_new_stream") or guard.requires_new_stream
            )
            guard.last_terminal_close_code = snapshot.get("last_terminal_close_code")
            guard.last_terminal_close_reason = snapshot.get(
                "last_terminal_close_reason"
            )
            guard.last_terminal_close_error = (
                snapshot.get("last_terminal_close_error") or error_name
            )
            guard.last_terminal_seq = max(guard.last_terminal_seq, int(seq))
            if int(seq) > 1:
                guard.requires_new_stream = True
                guard.cooldown_until = max(
                    guard.cooldown_until,
                    time.time() + settings.stt_reconnect_cooldown_seconds,
                )
                if getattr(actor, "ownership_manager", None) is not None:
                    actor.ownership_manager.set_cooldown_until(
                        meeting_key, guard.cooldown_until
                    )
                logger.warning(
                    "STT_RECONNECT_BLOCKED_WEBM_CONTINUATION meeting_id={} seq={} last_ack_seq={} reason={}",
                    meeting_key,
                    seq,
                    guard.last_terminal_seq,
                    guard.last_terminal_close_error or error_name,
                )
            elif not _is_webm_header_chunk(chunk_bytes):
                guard.requires_new_stream = True
            _update_stream_retry_guard_from_actor(meeting_key, actor)
            await _retire_stt_actor(meeting_key, actor)
            logger.warning(
                "STT_TERMINAL_FAILURE meeting_id={} session_id={} seq={} error={}",
                meeting_key,
                actor.session_id,
                seq,
                repr(exc),
            )
            status_code = (
                409
                if guard.requires_new_stream or isinstance(exc, SttOwnershipLost)
                else 429 if guard.cooldown_until > time.time() else 502
            )
            detail = {
                "meeting_id": meeting_key,
                "seq": seq,
                "reason": (
                    "meeting STT ownership lost"
                    if isinstance(exc, SttOwnershipLost)
                    else (
                        "new recording lifecycle required"
                        if guard.requires_new_stream
                        else (
                            "reconnect cooldown active"
                            if guard.cooldown_until > time.time()
                            else f"STT stream failed: {repr(exc)}"
                        )
                    )
                ),
                "retry_after_seconds": (
                    max(1, int(guard.cooldown_until - time.time() + 0.999))
                    if guard.cooldown_until > time.time()
                    else None
                ),
            }
            headers = None
            if guard.cooldown_until > time.time():
                headers = {
                    "Retry-After": str(
                        max(1, int(guard.cooldown_until - time.time() + 0.999))
                    )
                }
            raise HTTPException(
                status_code=status_code,
                detail=detail,
                headers=headers,
            ) from exc

        logger.warning(
            "STT_TRANSIENT_RETRY meeting_id={} session_id={} seq={} error={}",
            meeting_key,
            actor.session_id,
            seq,
            repr(exc),
        )
        raise HTTPException(
            status_code=502,
            detail=f"STT stream failed for meeting_id={meeting_id}: {repr(exc)}",
        ) from exc

    if is_final:
        _store_final_response(meeting_key, response)
        _stt_stream_sessions.pop(meeting_key, None)
        _clear_stream_retry_guard(meeting_key)
        logger.info(
            "STT_FINALIZATION_END meeting_id={} session_id={} seq={} transcript_length={}",
            meeting_key,
            actor.session_id,
            seq,
            len(response.transcript),
        )
        return response

    return response
