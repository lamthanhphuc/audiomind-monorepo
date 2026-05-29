import asyncio
import hashlib
import re
import sys
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np
from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.exceptions import RequestValidationError
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
from app.models import Analysis
from app.logging_utils import safe_error_message, transcript_hash_prefix
from app.services.ai_analyzer import AIAnalyzer
from app.schemas import (
    ActionItem,
    AnalysisPainPoint,
    AnalysisResponse,
    AnalysisTechnicalTerm,
    ProcessRequest,
    ProcessResponse,
    RealtimeTranscriptAnalysisRequest,
    RealtimeTranscriptAnalysisResponse,
    SttStreamResponse,
    TranscriptResponse,
    TranscriptSegment,
)
from app.services.analysis_errors import (
    AnalysisConfigError,
    AnalysisNotImplementedError,
    AnalysisParseError,
    AnalysisProviderError,
    AnalysisRateLimitError,
    AnalysisUnavailableError,
)
from app.services.analysis_factory import build_analysis_analyzer
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
    logger.warning(
        "Pipeline modules unavailable: {}",
        safe_error_message(pipeline_import_error),
    )

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
        logger.warning("Database connectivity check skipped: {}", safe_error_message(e))

    try:
        ensure_bigint_meeting_id()
    except Exception as e:
        if is_production:
            raise RuntimeError(
                "Database migration step failed during production startup"
            ) from e
        logger.warning("Database migration step skipped: {}", safe_error_message(e))

    try:
        Base.metadata.create_all(bind=engine)
    except Exception as e:
        if is_production:
            raise RuntimeError(
                "Database schema initialization failed during production startup"
            ) from e
        logger.warning(
            "Database schema initialization failed: {}", safe_error_message(e)
        )

    try:
        ensure_ffmpeg_on_path(log=True)
    except Exception as e:
        logger.warning("FFmpeg bootstrap warning: {}", safe_error_message(e))

    logger.info("=" * 50)
    logger.info("AudioMind AI Service Starting...")
    logger.info(f"Whisper Model: {settings.whisper_model}")
    logger.info(f"Device: {get_runtime_device()}")
    logger.info(
        "STT CONFIG api_key_exists={} realtime_model={} batch_model={} language={} base_url={}",
        bool(settings.deepgram_api_key),
        _resolve_realtime_model(),
        _resolve_batch_model(),
        _normalize_stt_language(None),
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
        logger.warning("Failed to start gRPC server: {}", safe_error_message(e))
    yield

    await _shutdown_all_stt_actors()
    if grpc_server:
        try:
            grpc_server.stop(grace=5)
        except Exception as e:
            logger.warning(
                "Error during gRPC server shutdown: {}", safe_error_message(e)
            )
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
            safe_error_message(exc),
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
            safe_error_message(exc),
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
_REALTIME_ANALYSIS_GUARD_TTL_SECONDS = 30.0 * 60.0
_REALTIME_ANALYSIS_LOCK_TTL_SECONDS = 180.0
_REALTIME_ANALYSIS_FAILURE_COOLDOWN_SECONDS = 90.0
_REALTIME_ANALYSIS_STALE_SECONDS = max(300.0, _REALTIME_ANALYSIS_LOCK_TTL_SECONDS * 2.0)
_REALTIME_ANALYSIS_LOCK_TOKEN_PREFIX = "aiapi:"
_REALTIME_ANALYSIS_STATE_OWNER = "ai-api"
_realtime_analysis_guard_lock = threading.Lock()
_realtime_analysis_in_progress: dict[int, tuple[str, float]] = {}
_realtime_analysis_completed_hash: dict[int, tuple[str, float]] = {}


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
    default_language = (settings.deepgram_language or "vi").strip().lower() or "vi"
    if default_language not in {"vi", "en", "multi"}:
        default_language = "vi"

    value = (language or "").strip().lower()
    if value in {"vi", "en", "multi"}:
        return value

    return default_language


def _normalize_speaker_mode(speaker_mode: str | None) -> str:
    normalized = (speaker_mode or "").strip().lower()
    if normalized in {"single", "multiple"}:
        return normalized
    return "single"


def _resolve_effective_diarize(speaker_mode: str | None) -> bool:
    normalized_mode = _normalize_speaker_mode(speaker_mode)
    if normalized_mode == "multiple":
        return True
    if normalized_mode == "single":
        return False
    return bool(settings.enable_speaker_diarization and settings.deepgram_diarize)


def _resolve_realtime_model() -> str:
    return (
        (settings.deepgram_realtime_model or "").strip()
        or (settings.deepgram_model or "").strip()
        or "nova-2"
    )


@dataclass(frozen=True)
class RealtimeEndpointingResolution:
    endpointing: int | None
    source: str
    env_name: str | None


def _coerce_endpointing_value(raw_value: object) -> int | None:
    if raw_value is None or isinstance(raw_value, bool):
        return None

    if isinstance(raw_value, float):
        if not raw_value.is_integer() or raw_value <= 0:
            return None
        return int(raw_value)

    if isinstance(raw_value, int):
        return raw_value if raw_value > 0 else None

    text = str(raw_value).strip()
    if not text:
        return None

    if not re.fullmatch(r"[+-]?\d+", text):
        return None

    numeric_value = int(text)
    return numeric_value if numeric_value > 0 else None


def _resolve_realtime_endpointing(language: str) -> RealtimeEndpointingResolution:
    normalized_language = _normalize_stt_language(language)
    language_env_map = {
        "vi": "DEEPGRAM_REALTIME_ENDPOINTING_VI",
        "en": "DEEPGRAM_REALTIME_ENDPOINTING_EN",
        "multi": "DEEPGRAM_REALTIME_ENDPOINTING_MULTI",
    }
    candidate_keys = [
        (
            "language_specific",
            language_env_map[normalized_language],
            getattr(settings, f"deepgram_realtime_endpointing_{normalized_language}"),
        ),
        (
            "realtime_default",
            "DEEPGRAM_REALTIME_ENDPOINTING_DEFAULT",
            settings.deepgram_realtime_endpointing_default,
        ),
        ("legacy_global", "DEEPGRAM_ENDPOINTING", settings.deepgram_endpointing),
    ]

    invalid_candidate_seen = False
    for source, env_name, raw_value in candidate_keys:
        parsed_value = _coerce_endpointing_value(raw_value)
        if parsed_value is not None:
            return RealtimeEndpointingResolution(
                endpointing=parsed_value,
                source="invalid_fallback" if invalid_candidate_seen else source,
                env_name=env_name,
            )

        if raw_value is None:
            continue

        raw_text = str(raw_value).strip()
        if not raw_text:
            continue

        invalid_candidate_seen = True
        logger.warning(
            "STT_STREAM_ENDPOINTING_INVALID language={} env={} value={}",
            normalized_language,
            env_name,
            raw_text,
        )

    return RealtimeEndpointingResolution(
        endpointing=None,
        source="invalid_fallback" if invalid_candidate_seen else "omitted",
        env_name=None,
    )


def _resolve_batch_model() -> str:
    return (
        (settings.deepgram_batch_model or "").strip()
        or (settings.deepgram_model or "").strip()
        or "nova-2"
    )


def _resolve_realtime_session_diagnostics(
    actor: MeetingSessionActor | None, fallback_transcript: str = ""
) -> dict[str, Any]:
    transcript_text = str(fallback_transcript or "")
    diagnostics: dict[str, Any] = {
        "final_segment_count": 0,
        "speech_final_count": 0,
        "is_final_count": 0,
        "transcript_length": len(transcript_text),
        "transcript_hash_prefix": transcript_hash_prefix(transcript_text),
    }
    if actor is None:
        return diagnostics

    adapter = getattr(actor, "adapter", None)
    session_id = str(getattr(actor, "session_id", "") or "")
    getter = getattr(adapter, "get_session_diagnostics", None)
    if not callable(getter) or not session_id:
        return diagnostics

    try:
        candidate = getter(session_id)
    except Exception:
        return diagnostics

    if not isinstance(candidate, dict):
        return diagnostics

    for field_name in ("final_segment_count", "speech_final_count", "is_final_count"):
        try:
            diagnostics[field_name] = max(0, int(candidate.get(field_name, 0) or 0))
        except (TypeError, ValueError):
            diagnostics[field_name] = 0

    transcript_length = candidate.get("transcript_length")
    if isinstance(transcript_length, int) and transcript_length >= 0:
        diagnostics["transcript_length"] = transcript_length
    else:
        diagnostics["transcript_length"] = len(transcript_text)

    hash_prefix = str(candidate.get("transcript_hash_prefix") or "").strip()
    diagnostics["transcript_hash_prefix"] = hash_prefix or transcript_hash_prefix(
        transcript_text
    )
    return diagnostics


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
    speaker_mode: str,
    *,
    seq: int | None = None,
    chunk_bytes: bytes | None = None,
    endpointing: int | None = None,
) -> MeetingSessionActor:
    await _cleanup_stale_stt_actors()
    guard = _get_stream_retry_guard(meeting_key)
    now = time.time()
    stt_adapter = _get_stt_adapter(endpointing=endpointing)
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
                safe_error_message(exc),
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

    is_finalize_signal = bool(
        seq == -1 and (chunk_bytes is None or len(chunk_bytes) == 0)
    )
    if guard.requires_new_stream and not is_finalize_signal:
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
                    safe_error_message(exc),
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
                speaker_mode=_normalize_speaker_mode(speaker_mode),
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
                safe_error_message(exc),
            )


def _get_stt_adapter(endpointing: int | None = None) -> DeepgramSTTAdapter | None:
    global _stt_adapter

    if endpointing is None and _stt_adapter is not None:
        return _stt_adapter

    if not (settings.deepgram_api_key or "").strip():
        return None

    adapter = DeepgramSTTAdapter(
        api_key=settings.deepgram_api_key,
        model=_resolve_realtime_model(),
        base_url=settings.deepgram_base_url,
        timeout_seconds=settings.deepgram_timeout_seconds,
        endpointing=endpointing,
        simplify_streaming_url=settings.deepgram_simplify_streaming_url,
        debug_raw_messages=settings.deepgram_debug_raw_messages,
        enable_speaker_diarization=settings.enable_speaker_diarization,
        deepgram_diarize=settings.deepgram_diarize,
    )

    if endpointing is None:
        _stt_adapter = adapter

    return adapter


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
_realtime_analysis_analyzer = None


def _get_realtime_analysis_analyzer():
    global _realtime_analysis_analyzer

    if _realtime_analysis_analyzer is not None:
        return _realtime_analysis_analyzer

    try:
        _realtime_analysis_analyzer = build_analysis_analyzer(settings)
    except Exception as exc:
        logger.warning(
            "Realtime analysis analyzer unavailable: {}",
            safe_error_message(exc),
        )
        _realtime_analysis_analyzer = None

    return _realtime_analysis_analyzer


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

TRACE_HEADER_NAME = "X-Trace-Id"


@app.middleware("http")
async def inject_trace_headers(request: Request, call_next) -> Response:
    started_at = time.time()
    trace_id = (
        request.headers.get("x-trace-id")
        or request.headers.get("x-request-id")
        or uuid4().hex
    )
    request_id = request.headers.get("x-request-id") or trace_id
    request.state.trace_id = trace_id
    request.state.request_id = request_id
    logger.bind(trace_id=trace_id, request_id=request_id).info(
        "event=REQUEST_RECEIVED traceId={} requestId={} path={}",
        trace_id,
        request_id,
        request.url.path,
    )
    try:
        response = await call_next(request)
    except Exception as exc:
        logger.bind(trace_id=trace_id, request_id=request_id).warning(
            "event=REQUEST_FAILED traceId={} requestId={} path={} errorCode={} durationMs={}",
            trace_id,
            request_id,
            request.url.path,
            type(exc).__name__,
            int((time.time() - started_at) * 1000),
        )
        raise
    response.headers[TRACE_HEADER_NAME] = trace_id
    response.headers["x-request-id"] = request_id
    logger.bind(trace_id=trace_id, request_id=request_id).info(
        "event=REQUEST_COMPLETED traceId={} requestId={} path={} httpStatus={} durationMs={}",
        trace_id,
        request_id,
        request.url.path,
        response.status_code,
        int((time.time() - started_at) * 1000),
    )
    return response


def _utc_now_iso8601() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _normalize_error_text(value: object) -> str:
    return str(value or "").strip().lower()


def _default_error_message(error: str) -> str:
    defaults = {
        "ANALYSIS_NOT_READY": "Analysis is not ready yet",
        "TRANSCRIPT_NOT_READY": "Transcript is not ready yet",
        "RESOURCE_NOT_FOUND": "Resource not found",
        "UNAUTHORIZED": "Unauthorized",
        "FORBIDDEN": "Forbidden",
        "CONFLICT": "Request conflicts with current resource state",
        "AI_SERVICE_UNAVAILABLE": "AI service is unavailable",
        "DATABASE_UNAVAILABLE": "Database dependency is unavailable",
        "SERVICE_UNAVAILABLE": "Service is unavailable",
        "DEEPGRAM_UNAVAILABLE": "Deepgram service is unavailable",
        "GEMINI_UNAVAILABLE": "Gemini service is unavailable",
        "GEMINI_ANALYSIS_FAILED": "Gemini analysis failed",
        "INVALID_LANGUAGE": "Invalid language",
        "EMPTY_TRANSCRIPT": "Transcript is empty",
        "DUPLICATE_REQUEST_SKIPPED": "Duplicate request skipped",
        "VALIDATION_ERROR": "Request validation failed",
        "INTERNAL_ERROR": "Unexpected server error",
    }
    return defaults.get(error, "Unexpected server error")


def _is_sensitive_text(value: str) -> bool:
    normalized = _normalize_error_text(value)
    return (
        "password" in normalized
        or "secret" in normalized
        or "token" in normalized
        or "authorization" in normalized
        or "bearer" in normalized
        or "stack trace" in normalized
        or "traceback" in normalized
    )


def _sanitize_message(message: object, fallback: str) -> str:
    candidate = str(message or "").strip()
    if not candidate:
        return fallback
    if len(candidate) > 280 or _is_sensitive_text(candidate):
        return fallback
    return candidate


def _resolve_trace_id(request: Request) -> str:
    from_header = request.headers.get("x-trace-id")
    if from_header and from_header.strip():
        return from_header.strip()

    from_state = getattr(request.state, "trace_id", "")
    if isinstance(from_state, str) and from_state.strip():
        return from_state.strip()

    return uuid4().hex


def _extract_meeting_details(path: str) -> dict[str, object] | None:
    match = re.search(r"/meeting/(\d+)/(analysis|transcript)$", path or "")
    if not match:
        return None
    return {"meetingId": match.group(1)}


def _sanitize_details(details: object) -> dict[str, object] | None:
    if not isinstance(details, dict):
        return None

    safe: dict[str, object] = {}
    for key, value in details.items():
        key_text = str(key).strip()
        if not key_text:
            continue
        normalized_key = key_text.lower()
        if (
            "password" in normalized_key
            or "secret" in normalized_key
            or "token" in normalized_key
            or "authorization" in normalized_key
            or "api_key" in normalized_key
            or "apikey" in normalized_key
            or "transcript" in normalized_key
        ):
            continue

        safe_value = _sanitize_detail_value(value)
        if safe_value is not None:
            safe[key_text] = safe_value

    return safe or None


def _sanitize_detail_value(value: object) -> object | None:
    if value is None:
        return None

    if isinstance(value, (bool, int, float)):
        return value

    if isinstance(value, str):
        clean_value = value.strip()
        if (
            clean_value
            and len(clean_value) <= 240
            and not _is_sensitive_text(clean_value)
        ):
            return clean_value
        return None

    if isinstance(value, dict):
        return _sanitize_details(value)

    if isinstance(value, list):
        safe_items: list[object] = []
        for item in value[:10]:
            safe_item = _sanitize_detail_value(item)
            if safe_item is not None:
                safe_items.append(safe_item)
        return safe_items or None

    clean_value = str(value).strip()
    if clean_value and len(clean_value) <= 240 and not _is_sensitive_text(clean_value):
        return clean_value
    return None


def build_error_response(
    error: str,
    message: str,
    status: int,
    request: Request,
    details: dict[str, object] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    trace_id = _resolve_trace_id(request)
    payload: dict[str, object] = {
        "error": error,
        "message": _sanitize_message(message, _default_error_message(error)),
        "status": status,
        "timestamp": _utc_now_iso8601(),
        "traceId": trace_id,
    }
    path = str(request.url.path or "").strip()
    if path:
        payload["path"] = path

    safe_details = _sanitize_details(details)
    if safe_details:
        payload["details"] = safe_details

    response_headers = dict(headers or {})
    response_headers[TRACE_HEADER_NAME] = trace_id
    return JSONResponse(status_code=status, content=payload, headers=response_headers)


def _map_http_exception(
    request: Request, exc: HTTPException
) -> tuple[str, str, dict[str, object] | None]:
    status_code = int(exc.status_code)
    path = str(request.url.path or "")
    normalized_path = path.lower()
    detail_text = exc.detail if isinstance(exc.detail, str) else ""
    normalized_detail = _normalize_error_text(detail_text)
    details = _sanitize_details(exc.detail)

    if status_code == 404:
        if normalized_path.endswith("/analysis"):
            return (
                "ANALYSIS_NOT_READY",
                _default_error_message("ANALYSIS_NOT_READY"),
                _extract_meeting_details(path),
            )
        if normalized_path.endswith("/transcript"):
            return (
                "TRANSCRIPT_NOT_READY",
                _default_error_message("TRANSCRIPT_NOT_READY"),
                _extract_meeting_details(path),
            )
        return (
            "RESOURCE_NOT_FOUND",
            _sanitize_message(
                detail_text, _default_error_message("RESOURCE_NOT_FOUND")
            ),
            details,
        )

    if status_code in {400, 422}:
        if "language" in normalized_detail:
            return (
                "INVALID_LANGUAGE",
                _default_error_message("INVALID_LANGUAGE"),
                details,
            )
        if "empty transcript" in normalized_detail:
            return (
                "EMPTY_TRANSCRIPT",
                _default_error_message("EMPTY_TRANSCRIPT"),
                details,
            )
        return (
            "VALIDATION_ERROR",
            _sanitize_message(detail_text, _default_error_message("VALIDATION_ERROR")),
            details,
        )

    if status_code == 401:
        return ("UNAUTHORIZED", _default_error_message("UNAUTHORIZED"), details)

    if status_code == 403:
        return ("FORBIDDEN", _default_error_message("FORBIDDEN"), details)

    if status_code == 409:
        return (
            "CONFLICT",
            _sanitize_message(detail_text, _default_error_message("CONFLICT")),
            details,
        )

    if status_code == 503:
        if "deepgram" in normalized_detail:
            return (
                "DEEPGRAM_UNAVAILABLE",
                _default_error_message("DEEPGRAM_UNAVAILABLE"),
                details,
            )
        if "gemini" in normalized_detail:
            return (
                "GEMINI_UNAVAILABLE",
                _default_error_message("GEMINI_UNAVAILABLE"),
                details,
            )
        if "analysis service unavailable" in normalized_detail:
            return (
                "AI_SERVICE_UNAVAILABLE",
                _default_error_message("AI_SERVICE_UNAVAILABLE"),
                details,
            )
        return (
            "SERVICE_UNAVAILABLE",
            _default_error_message("SERVICE_UNAVAILABLE"),
            details,
        )

    if status_code == 502:
        return (
            "GEMINI_ANALYSIS_FAILED",
            _default_error_message("GEMINI_ANALYSIS_FAILED"),
            details,
        )

    if status_code >= 500:
        return ("INTERNAL_ERROR", _default_error_message("INTERNAL_ERROR"), details)

    return (
        "SERVICE_UNAVAILABLE",
        _default_error_message("SERVICE_UNAVAILABLE"),
        details,
    )


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


def _normalize_domain_mode(value: Any, default: str = "it") -> str:
    normalized = str(value or default).strip().lower()
    if normalized in {"general", "it", "business", "education"}:
        return normalized
    return default


def _coerce_string_list(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for item in values:
        text = str(item or "").strip()
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(text)
    return normalized


def _coerce_structured_terms(values: Any) -> list[dict[str, str]]:
    if not isinstance(values, list):
        return []
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in values:
        if not isinstance(item, dict):
            continue
        term = str(item.get("term") or "").strip()
        if not term:
            continue
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(
            {
                "term": term,
                "meaning": str(item.get("meaning") or "").strip(),
                "category": str(item.get("category") or "").strip(),
            }
        )
    return normalized


def _coerce_pain_points(values: Any) -> list[dict[str, str]]:
    if not isinstance(values, list):
        return []
    normalized: list[dict[str, str]] = []
    for item in values:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        severity = str(item.get("severity") or "medium").strip().lower()
        if severity not in {"low", "medium", "high"}:
            severity = "medium"
        normalized.append(
            {
                "title": title,
                "evidence": str(item.get("evidence") or "").strip(),
                "severity": severity,
            }
        )
    return normalized


def _coerce_action_items(values: Any) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        return []
    normalized: list[dict[str, Any]] = []
    for item in values:
        if isinstance(item, dict):
            task = str(item.get("task") or item.get("text") or "").strip()
            if not task:
                continue
            owner = str(item.get("owner") or "").strip() or None
            due_date = (
                str(item.get("dueDate") or item.get("due_date") or item.get("deadline") or "").strip()
                or None
            )
            priority = str(item.get("priority") or "").strip() or None
            status = str(item.get("status") or "").strip() or None
            evidence = str(item.get("evidence") or "").strip() or None
            normalized.append(
                {
                    "task": task,
                    "owner": owner,
                    "dueDate": due_date,
                    "deadline": due_date,
                    "priority": priority,
                    "status": status,
                    "evidence": evidence,
                }
            )
            continue
        task = str(item or "").strip()
        if task:
            normalized.append(
                {
                    "task": task,
                    "owner": None,
                    "dueDate": None,
                    "deadline": None,
                    "priority": None,
                    "status": None,
                    "evidence": None,
                }
            )
    return normalized


def _extract_analysis_from_job_state(
    job_state: dict[str, Any] | None,
) -> dict[str, Any]:
    if not isinstance(job_state, dict):
        return {}
    result = job_state.get("result")
    if not isinstance(result, dict):
        return {}
    analysis = result.get("analysis")
    if not isinstance(analysis, dict):
        return {}
    return analysis


def _normalize_analysis_payload(raw_analysis: dict[str, Any]) -> dict[str, Any]:
    summary = str(
        raw_analysis.get("summary") or raw_analysis.get("meetingSummary") or ""
    ).strip()
    meeting_summary = str(raw_analysis.get("meetingSummary") or summary).strip()
    keywords = _coerce_string_list(
        raw_analysis.get("keywords")
        or raw_analysis.get("key_points")
        or raw_analysis.get("topics")
        or []
    )
    technical_terms = _coerce_string_list(
        raw_analysis.get("technical_terms") or raw_analysis.get("terms") or []
    )
    technical_terms_structured = _coerce_structured_terms(
        raw_analysis.get("technicalTerms") or []
    )
    if technical_terms_structured:
        technical_terms = [item["term"] for item in technical_terms_structured]
    pain_points = _coerce_pain_points(
        raw_analysis.get("painPoints") or raw_analysis.get("pain_points") or []
    )
    action_items_structured = _coerce_action_items(
        raw_analysis.get("action_items")
        or raw_analysis.get("businessActionItems")
        or raw_analysis.get("actionItems")
        or []
    )
    action_items = [
        str(item.get("task") or "").strip() for item in action_items_structured
    ]
    action_items = [item for item in action_items if item]
    key_decisions = _coerce_string_list(
        raw_analysis.get("keyDecisions") or raw_analysis.get("decisions") or []
    )
    risks = _coerce_string_list(
        raw_analysis.get("risks") or raw_analysis.get("risks_blockers") or []
    )
    blockers = _coerce_string_list(raw_analysis.get("blockers") or [])
    questions = _coerce_string_list(raw_analysis.get("questions") or [])
    deadlines = _coerce_string_list(raw_analysis.get("deadlines") or [])
    owners = _coerce_string_list(raw_analysis.get("owners") or [])
    next_steps = _coerce_string_list(raw_analysis.get("nextSteps") or [])
    if not next_steps and action_items:
        next_steps = action_items[:3]
    if not owners:
        owners = _coerce_string_list(
            [item.get("owner") for item in action_items_structured if item.get("owner")]
        )
    if not deadlines:
        deadlines = _coerce_string_list(
            [
                item.get("dueDate") or item.get("deadline")
                for item in action_items_structured
                if item.get("dueDate") or item.get("deadline")
            ]
        )
    confidence_raw = raw_analysis.get("confidence")
    confidence: float | None = None
    if isinstance(confidence_raw, (int, float)) and not isinstance(confidence_raw, bool):
        confidence = float(confidence_raw)
    elif isinstance(confidence_raw, str):
        trimmed = confidence_raw.strip().replace("%", "")
        if trimmed:
            try:
                confidence = float(trimmed)
            except ValueError:
                confidence = None
    if confidence is not None:
        if confidence > 1.0 and confidence <= 100.0:
            confidence = confidence / 100.0
        confidence = max(0.0, min(1.0, confidence))

    domain_mode = _normalize_domain_mode(
        raw_analysis.get("domainMode") or raw_analysis.get("domain_mode") or "it"
    )
    transcript_hash = (
        str(
            raw_analysis.get("transcript_hash")
            or raw_analysis.get("transcriptHash")
            or ""
        ).strip()
        or None
    )
    source = str(raw_analysis.get("source") or "").strip() or None
    prompt_version = (
        str(
            raw_analysis.get("promptVersion")
            or raw_analysis.get("prompt_version")
            or ""
        ).strip()
        or AIAnalyzer.PROMPT_VERSION
    )
    schema_version = (
        str(
            raw_analysis.get("schemaVersion")
            or raw_analysis.get("schema_version")
            or ""
        ).strip()
        or AIAnalyzer.SCHEMA_VERSION
    )
    risks_blockers = _coerce_string_list(risks + blockers)
    return {
        "summary": summary,
        "meetingSummary": meeting_summary or summary,
        "keywords": keywords,
        "technical_terms": technical_terms,
        "technicalTerms": technical_terms_structured,
        "painPoints": pain_points,
        "businessActionItems": action_items_structured,
        "action_items": action_items_structured,
        "actionItems": action_items,
        "domainMode": domain_mode,
        "domain_mode": domain_mode,
        "keyDecisions": key_decisions,
        "decisions": key_decisions,
        "risks": risks,
        "blockers": blockers,
        "questions": questions,
        "deadlines": deadlines,
        "owners": owners,
        "nextSteps": next_steps,
        "risks_blockers": risks_blockers,
        "businessImpact": str(raw_analysis.get("businessImpact") or "").strip(),
        "customerImpact": str(raw_analysis.get("customerImpact") or "").strip(),
        "technicalImpact": str(raw_analysis.get("technicalImpact") or "").strip(),
        "confidence": confidence,
        "promptVersion": prompt_version,
        "schemaVersion": schema_version,
        "transcript_hash": transcript_hash,
        "transcriptHash": transcript_hash,
        "source": source,
    }


def _normalize_transcript_text(transcript: str) -> str:
    lines = [
        line.strip() for line in str(transcript or "").splitlines() if line.strip()
    ]
    return "\n".join(lines).strip()


def _compute_transcript_hash(transcript: str, provided_hash: str | None) -> str:
    normalized = str(provided_hash or "").strip().lower()
    if normalized and re.fullmatch(r"[a-f0-9]{64}", normalized):
        return normalized
    return hashlib.sha256(transcript.encode("utf-8")).hexdigest()


def _normalize_analysis_version(value: Any, default: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        return default
    return normalized


def _analysis_cache_key(
    transcript_hash: str, prompt_version: str, schema_version: str
) -> str:
    return (
        f"{str(transcript_hash or '').strip().lower()}|"
        f"{str(prompt_version or '').strip().lower()}|"
        f"{str(schema_version or '').strip().lower()}"
    )


def _analysis_identity_from_row(analysis_row: Analysis | None) -> tuple[str, str, str]:
    transcript_hash = ""
    prompt_version = ""
    schema_version = ""
    if analysis_row is None:
        return transcript_hash, prompt_version, schema_version

    technical_terms_value = getattr(analysis_row, "technical_terms", None)
    if isinstance(technical_terms_value, dict):
        transcript_hash = str(
            technical_terms_value.get("transcript_hash")
            or technical_terms_value.get("transcriptHash")
            or ""
        ).strip().lower()
        prompt_version = str(
            technical_terms_value.get("promptVersion")
            or technical_terms_value.get("prompt_version")
            or ""
        ).strip()
        schema_version = str(
            technical_terms_value.get("schemaVersion")
            or technical_terms_value.get("schema_version")
            or ""
        ).strip()
    return transcript_hash, prompt_version, schema_version


def _is_matching_completed_analysis(
    analysis_row: Analysis | None,
    *,
    transcript_hash: str,
    prompt_version: str,
    schema_version: str,
) -> bool:
    stored_hash, stored_prompt_version, stored_schema_version = _analysis_identity_from_row(
        analysis_row
    )
    if not stored_hash:
        return False
    if stored_hash != str(transcript_hash or "").strip().lower():
        return False
    if (
        str(stored_prompt_version or "").strip()
        != str(prompt_version or "").strip()
    ):
        return False
    if (
        str(stored_schema_version or "").strip()
        != str(schema_version or "").strip()
    ):
        return False
    return True


def _analysis_lock_key(meeting_id: int) -> str:
    return f"analysis:lock:{meeting_id}"


def _analysis_state_key(meeting_id: int) -> str:
    return f"analysis:state:{meeting_id}"


def _analysis_cooldown_key(meeting_id: int) -> str:
    return f"analysis:cooldown:{meeting_id}"


def _parse_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _normalize_epoch_seconds(value: Any, default: float = 0.0) -> float:
    parsed = _parse_float(value, default=default)
    if parsed <= 0.0:
        return default
    # Some callers may persist epoch milliseconds instead of seconds.
    if parsed > 10_000_000_000:
        return parsed / 1000.0
    return parsed


def _is_ai_owned_lock_token(lock_token: Any) -> bool:
    return str(lock_token or "").startswith(_REALTIME_ANALYSIS_LOCK_TOKEN_PREFIX)


def _analysis_state_owner(state: dict[str, str]) -> str:
    owner = str(
        state.get("owner") or state.get("managed_by") or state.get("managedBy") or ""
    ).strip()
    return owner.lower()


def _release_realtime_analysis_lock(client: Any, meeting_id: int) -> None:
    try:
        client.delete(_analysis_lock_key(meeting_id))
    except Exception:
        return


def _clear_realtime_analysis_running_state(
    client: Any, meeting_id: int, reason: str
) -> None:
    try:
        client.delete(_analysis_lock_key(meeting_id))
        client.delete(_analysis_state_key(meeting_id))
        client.delete(_analysis_cooldown_key(meeting_id))
    except Exception as redis_error:
        logger.warning(
            "event=REDIS_OPERATION_FAILED operation=realtime_analysis_stale_clear meetingId={} reason={} errorCode={} error={}",
            meeting_id,
            reason,
            type(redis_error).__name__,
            safe_error_message(redis_error),
        )


def _running_state_is_stale(
    *, now: float, status: str, state: dict[str, str], lock_ttl: int | None
) -> bool:
    if status not in {"RUNNING", "PENDING", "QUEUED"}:
        return False

    started_at = _normalize_epoch_seconds(state.get("started_at"), default=0.0)
    updated_at = _normalize_epoch_seconds(state.get("updated_at"), default=0.0)
    reference = max(started_at, updated_at)
    if reference <= 0:
        return True

    running_age = now - reference
    if running_age > _REALTIME_ANALYSIS_STALE_SECONDS:
        return True

    if not isinstance(lock_ttl, int) or lock_ttl <= 0:
        return running_age > _REALTIME_ANALYSIS_LOCK_TTL_SECONDS

    return False


def _purge_realtime_analysis_guards(now: float) -> None:
    stale_in_progress = [
        meeting_id
        for meeting_id, (_, created_at) in _realtime_analysis_in_progress.items()
        if now - created_at > _REALTIME_ANALYSIS_GUARD_TTL_SECONDS
    ]
    for meeting_id in stale_in_progress:
        _realtime_analysis_in_progress.pop(meeting_id, None)

    stale_completed = [
        meeting_id
        for meeting_id, (_, created_at) in _realtime_analysis_completed_hash.items()
        if now - created_at > _REALTIME_ANALYSIS_GUARD_TTL_SECONDS
    ]
    for meeting_id in stale_completed:
        _realtime_analysis_completed_hash.pop(meeting_id, None)


def _try_begin_realtime_analysis(
    meeting_id: int,
    analysis_cache_key: str,
    source: str,
    prompt_version: str = AIAnalyzer.PROMPT_VERSION,
    schema_version: str = AIAnalyzer.SCHEMA_VERSION,
) -> tuple[bool, str | None, str | None, int, str | None]:
    now = time.time()
    state: dict[str, str] = {}
    cooldown_until = 0.0
    lock_retry_after = 0
    error_code: str | None = None

    with _realtime_analysis_guard_lock:
        _purge_realtime_analysis_guards(now)
        completed = _realtime_analysis_completed_hash.get(meeting_id)
        if completed is not None and completed[0] == analysis_cache_key:
            return False, "already_exists", None, 0, None

        in_progress = _realtime_analysis_in_progress.get(meeting_id)
        if in_progress is not None:
            active_hash, created_at = in_progress
            age_seconds = max(0.0, now - created_at)
            if (
                active_hash == analysis_cache_key
                and age_seconds <= _REALTIME_ANALYSIS_STALE_SECONDS
            ):
                retry_after = max(
                    1, int(_REALTIME_ANALYSIS_STALE_SECONDS - age_seconds + 0.999)
                )
                return False, "in_progress", None, retry_after, None
            _realtime_analysis_in_progress.pop(meeting_id, None)

    try:
        client = _get_client()
        state = client.hgetall(_analysis_state_key(meeting_id)) or {}
        cooldown_value = client.get(_analysis_cooldown_key(meeting_id))
        if cooldown_value:
            try:
                cooldown_until = max(
                    cooldown_until,
                    _normalize_epoch_seconds(cooldown_value, default=0.0),
                )
            except (TypeError, ValueError):
                cooldown_until = cooldown_until
        state_cooldown = state.get("cooldown_until") or state.get("cooldownUntilMs")
        if state_cooldown:
            try:
                cooldown_until = max(
                    cooldown_until,
                    _normalize_epoch_seconds(state_cooldown, default=0.0),
                )
            except (TypeError, ValueError):
                cooldown_until = cooldown_until

        status = str(state.get("status") or "").strip().upper()
        state_owner = _analysis_state_owner(state)
        state_hash = (
            str(
                state.get("analysis_cache_key")
                or state.get("analysisCacheKey")
                or state.get("transcript_hash")
                or state.get("transcriptHash")
                or ""
            )
            .strip()
            .lower()
        )
        error_code = (
            str(state.get("error_code") or state.get("errorCode") or "").strip().upper()
            or None
        )
        if (
            status == "COMPLETED"
            and state_owner in {"", _REALTIME_ANALYSIS_STATE_OWNER}
            and state_hash
            and state_hash == analysis_cache_key
        ):
            return False, "already_exists", error_code, 0, None
        if status in {"RUNNING", "PENDING", "QUEUED"}:
            lock_ttl = client.ttl(_analysis_lock_key(meeting_id))
            if state_owner and state_owner != _REALTIME_ANALYSIS_STATE_OWNER:
                logger.warning(
                    "event=REALTIME_ANALYSIS_STALE_CLEARED meetingId={} status={} lockTtl={} source={} reason=foreign_owner owner={}",
                    meeting_id,
                    status,
                    lock_ttl,
                    source,
                    state_owner,
                )
                _clear_realtime_analysis_running_state(
                    client, meeting_id, "foreign_owner"
                )
                with _realtime_analysis_guard_lock:
                    _realtime_analysis_in_progress.pop(meeting_id, None)
            elif _running_state_is_stale(
                now=now,
                status=status,
                state=state,
                lock_ttl=lock_ttl if isinstance(lock_ttl, int) else None,
            ):
                logger.warning(
                    "event=REALTIME_ANALYSIS_STALE_CLEARED meetingId={} status={} lockTtl={} source={}",
                    meeting_id,
                    status,
                    lock_ttl,
                    source,
                )
                _clear_realtime_analysis_running_state(
                    client, meeting_id, "stale_running"
                )
                with _realtime_analysis_guard_lock:
                    _realtime_analysis_in_progress.pop(meeting_id, None)
            else:
                lock_retry_after = int(
                    lock_ttl
                    if isinstance(lock_ttl, int) and lock_ttl > 0
                    else max(1, int(_REALTIME_ANALYSIS_LOCK_TTL_SECONDS))
                )
                return False, "in_progress", error_code, lock_retry_after, None
        if status == "FAILED" and cooldown_until > now:
            retry_after = max(1, int(cooldown_until - now + 0.999))
            return False, "cooldown_active", error_code, retry_after, None
    except Exception as redis_error:
        logger.warning(
            "event=REDIS_OPERATION_FAILED operation=realtime_analysis_precheck meetingId={} errorCode={} error={}",
            meeting_id,
            type(redis_error).__name__,
            safe_error_message(redis_error),
        )

    lock_token = f"{_REALTIME_ANALYSIS_LOCK_TOKEN_PREFIX}{uuid4().hex}"
    try:
        client = _get_client()
        lock_key = _analysis_lock_key(meeting_id)
        acquired = client.set(
            lock_key,
            lock_token,
            nx=True,
            ex=max(120, int(_REALTIME_ANALYSIS_LOCK_TTL_SECONDS)),
        )
        if not acquired:
            lock_ttl = client.ttl(lock_key)
            lock_token_value = client.get(lock_key)
            state_snapshot = client.hgetall(_analysis_state_key(meeting_id)) or {}
            status_snapshot = str(state_snapshot.get("status") or "").strip().upper()
            can_recover_foreign_or_orphan_lock = not _is_ai_owned_lock_token(
                lock_token_value
            ) and (
                status_snapshot not in {"RUNNING", "PENDING", "QUEUED"}
                or _running_state_is_stale(
                    now=now,
                    status=status_snapshot,
                    state=state_snapshot,
                    lock_ttl=lock_ttl if isinstance(lock_ttl, int) else None,
                )
            )
            if can_recover_foreign_or_orphan_lock:
                logger.warning(
                    "event=REALTIME_ANALYSIS_STALE_CLEARED meetingId={} status={} lockTtl={} source={} reason=foreign_or_orphan_lock",
                    meeting_id,
                    status_snapshot or "UNKNOWN",
                    lock_ttl,
                    source,
                )
                _clear_realtime_analysis_running_state(
                    client, meeting_id, "foreign_or_orphan_lock"
                )
                acquired = client.set(
                    lock_key,
                    lock_token,
                    nx=True,
                    ex=max(120, int(_REALTIME_ANALYSIS_LOCK_TTL_SECONDS)),
                )

            if not acquired:
                retry_after = int(
                    lock_ttl if isinstance(lock_ttl, int) and lock_ttl > 0 else 1
                )
                return False, "in_progress", error_code, retry_after, None

        with _realtime_analysis_guard_lock:
            _purge_realtime_analysis_guards(now)
            in_progress = _realtime_analysis_in_progress.get(meeting_id)
            if in_progress is not None:
                active_hash, created_at = in_progress
                age_seconds = max(0.0, now - created_at)
                if (
                    active_hash == analysis_cache_key
                    and age_seconds <= _REALTIME_ANALYSIS_STALE_SECONDS
                ):
                    _release_realtime_analysis_lock(client, meeting_id)
                    retry_after = max(
                        1, int(_REALTIME_ANALYSIS_STALE_SECONDS - age_seconds + 0.999)
                    )
                    return False, "in_progress", error_code, retry_after, None
                _realtime_analysis_in_progress.pop(meeting_id, None)

            completed = _realtime_analysis_completed_hash.get(meeting_id)
            if completed is not None and completed[0] == analysis_cache_key:
                _release_realtime_analysis_lock(client, meeting_id)
                return False, "already_exists", error_code, 0, None

            _realtime_analysis_in_progress[meeting_id] = (analysis_cache_key, now)

        client.hset(
            _analysis_state_key(meeting_id),
            mapping={
                "meeting_id": str(meeting_id),
                "status": "RUNNING",
                "transcript_hash": analysis_cache_key,
                "analysis_cache_key": analysis_cache_key,
                "prompt_version": prompt_version,
                "schema_version": schema_version,
                "source": source,
                "updated_at": str(now),
                "started_at": str(now),
                "owner": _REALTIME_ANALYSIS_STATE_OWNER,
                "error_code": "",
                "error_message": "",
            },
        )
        client.expire(
            _analysis_state_key(meeting_id), int(settings.job_state_ttl_seconds)
        )
        client.delete(_analysis_cooldown_key(meeting_id))
    except Exception as redis_error:
        logger.warning(
            "event=REDIS_OPERATION_FAILED operation=realtime_analysis_begin meetingId={} errorCode={} error={}",
            meeting_id,
            type(redis_error).__name__,
            safe_error_message(redis_error),
        )
        lock_token = None
    return True, None, None, 0, lock_token


def _finish_realtime_analysis(
    meeting_id: int,
    analysis_cache_key: str,
    success: bool,
    source: str,
    lock_token: str | None,
    prompt_version: str = AIAnalyzer.PROMPT_VERSION,
    schema_version: str = AIAnalyzer.SCHEMA_VERSION,
    error_code: str | None = None,
    error_reason: str | None = None,
    retry_after_seconds: int = 0,
) -> None:
    now = time.time()
    try:
        client = _get_client()
        if success:
            client.hset(
                _analysis_state_key(meeting_id),
                mapping={
                    "meeting_id": str(meeting_id),
                    "status": "COMPLETED",
                    "transcript_hash": analysis_cache_key,
                    "analysis_cache_key": analysis_cache_key,
                    "prompt_version": prompt_version,
                    "schema_version": schema_version,
                    "source": source,
                    "updated_at": str(now),
                    "completed_at": str(now),
                    "owner": _REALTIME_ANALYSIS_STATE_OWNER,
                    "error_code": "",
                    "error_message": "",
                },
            )
            client.expire(
                _analysis_state_key(meeting_id), int(settings.job_state_ttl_seconds)
            )
            client.delete(_analysis_cooldown_key(meeting_id))
        else:
            retry_after = max(
                1,
                retry_after_seconds or int(_REALTIME_ANALYSIS_FAILURE_COOLDOWN_SECONDS),
            )
            cooldown_until = now + retry_after
            client.hset(
                _analysis_state_key(meeting_id),
                mapping={
                    "meeting_id": str(meeting_id),
                    "status": "FAILED",
                    "transcript_hash": analysis_cache_key,
                    "analysis_cache_key": analysis_cache_key,
                    "prompt_version": prompt_version,
                    "schema_version": schema_version,
                    "source": source,
                    "updated_at": str(now),
                    "failed_at": str(now),
                    "owner": _REALTIME_ANALYSIS_STATE_OWNER,
                    "cooldown_until": str(cooldown_until),
                    "retry_after_seconds": str(retry_after),
                    "error_code": str(error_code or "GEMINI_ANALYSIS_FAILED"),
                    "error_message": str(error_reason or "analysis_failed")[:180],
                },
            )
            client.expire(
                _analysis_state_key(meeting_id), int(settings.job_state_ttl_seconds)
            )
            client.set(
                _analysis_cooldown_key(meeting_id),
                str(cooldown_until),
                ex=retry_after,
            )

        if lock_token:
            current_token = client.get(_analysis_lock_key(meeting_id))
            if current_token and str(current_token) == lock_token:
                client.delete(_analysis_lock_key(meeting_id))
    except Exception as redis_error:
        logger.warning(
            "event=REDIS_OPERATION_FAILED operation=realtime_analysis_finish meetingId={} errorCode={} error={}",
            meeting_id,
            type(redis_error).__name__,
            safe_error_message(redis_error),
        )

    with _realtime_analysis_guard_lock:
        _realtime_analysis_in_progress.pop(meeting_id, None)
        if success:
            _realtime_analysis_completed_hash[meeting_id] = (analysis_cache_key, now)


def _analyze_and_persist_realtime_transcript(
    *,
    meeting_id: int,
    transcript_text: str,
    transcript_hash: str,
    prompt_version: str,
    schema_version: str,
    source: str,
    domain_mode: str | None,
    db: Session,
):
    analyzer = _get_realtime_analysis_analyzer()
    if analyzer is None:
        raise HTTPException(
            status_code=503,
            detail="Analysis service unavailable",
        )

    requested_domain_mode = _normalize_domain_mode(
        domain_mode, default=analyzer.analysis_domain_mode
    )
    metadata = {
        "meetingId": meeting_id,
        "source": source,
        "transcriptHash": transcript_hash,
        "domainMode": requested_domain_mode,
        "promptVersion": prompt_version,
        "schemaVersion": schema_version,
    }

    if getattr(analyzer, "provider", "") == "gemini":
        structured_analysis = analyzer._analyze_with_gemini(
            transcript_text,
            metadata=metadata,
        )
    else:
        structured_analysis = analyzer.analyze_meeting(
            transcript_text,
            metadata=metadata,
        )

    normalized = _normalize_analysis_payload(structured_analysis)
    prepared = analyzer.prepare_analysis_for_storage(
        transcript=transcript_text,
        data=structured_analysis,
    )
    clean_keywords = prepared.get("keywords", [])
    clean_terms = prepared.get("technical_terms", [])
    clean_terms = analyzer.sanitize_technical_terms(
        transcript=transcript_text,
        technical_terms=clean_terms,
        keywords=clean_keywords,
    )

    technical_terms_payload = {
        "technical_terms": clean_terms,
        "technicalTerms": normalized["technicalTerms"],
        "painPoints": normalized["painPoints"],
        "meetingSummary": normalized["meetingSummary"],
        "keyDecisions": normalized["keyDecisions"],
        "risks": normalized["risks"],
        "blockers": normalized["blockers"],
        "questions": normalized["questions"],
        "deadlines": normalized["deadlines"],
        "owners": normalized["owners"],
        "nextSteps": normalized["nextSteps"],
        "businessImpact": normalized["businessImpact"],
        "customerImpact": normalized["customerImpact"],
        "technicalImpact": normalized["technicalImpact"],
        "confidence": normalized["confidence"],
        "domainMode": normalized["domainMode"],
        "transcript_hash": transcript_hash,
        "promptVersion": prompt_version,
        "schemaVersion": schema_version,
        "source": source,
    }
    action_items_payload = prepared.get("action_items", [])

    analysis_row = db.query(Analysis).filter(Analysis.meeting_id == meeting_id).first()
    if analysis_row is None:
        analysis_row = Analysis(meeting_id=meeting_id)
        db.add(analysis_row)

    analysis_row.summary = str(prepared.get("summary", ""))
    analysis_row.keywords = clean_keywords
    analysis_row.technical_terms = technical_terms_payload
    analysis_row.action_items = action_items_payload
    analysis_row.created_at = datetime.now(timezone.utc)
    db.commit()

    analysis_for_job_state = dict(normalized)
    analysis_for_job_state["transcriptHash"] = transcript_hash
    analysis_for_job_state["transcript_hash"] = transcript_hash
    analysis_for_job_state["promptVersion"] = prompt_version
    analysis_for_job_state["schemaVersion"] = schema_version
    analysis_for_job_state["source"] = source

    set_job_status(
        meeting_id=meeting_id,
        status="COMPLETED",
        result={"analysis": analysis_for_job_state, "source": source},
        stage="completed",
        progress=100,
    )

    logger.info("REALTIME_ANALYSIS_SAVED meetingId={}", meeting_id)

    return RealtimeTranscriptAnalysisResponse(
        meeting_id=meeting_id,
        status="completed",
        transcript_hash=transcript_hash,
        source=source,
        promptVersion=prompt_version,
        schemaVersion=schema_version,
    )


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
                        speaker=str(segment.get("speaker") or "SPEAKER_1"),
                        start_time=float(segment.get("start_time") or 0.0),
                        end_time=float(segment.get("end_time") or 0.0),
                        text=str(segment.get("text") or ""),
                        segment_id=(
                            str(segment.get("segment_id") or "").strip()
                            or f"meeting-{meeting_id}-start-{float(segment.get('start_time') or 0.0):.3f}-{str(segment.get('speaker') or 'SPEAKER_1').strip().lower().replace(' ', '_')}"
                        ),
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
                segment_id=(
                    str(getattr(t, "segment_id", "") or "").strip()
                    or f"meeting-{meeting_id}-start-{float(getattr(t, 'start_time', 0.0) or 0.0):.3f}-{str(getattr(t, 'speaker', 'SPEAKER_1') or 'SPEAKER_1').strip().lower().replace(' ', '_')}"
                ),
            )
            for t in transcripts
        ]

        return TranscriptResponse(meeting_id=meeting_id, transcripts=segments)

    except HTTPException:
        raise
    except Exception as e:
        request_id = uuid4().hex
        logger.error(
            "event=REQUEST_FAILED requestId={} path=/api/meeting/{}/transcript errorCode={} error={}",
            request_id,
            meeting_id,
            type(e).__name__,
            safe_error_message(e),
        )
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
        logger.info(f"Fetching analysis for meeting {meeting_id}")

        job_state = get_job_status(meeting_id)
        job_analysis = _extract_analysis_from_job_state(job_state)
        if job_analysis:
            normalized = _normalize_analysis_payload(job_analysis)
            action_items = [ActionItem(**item) for item in normalized["action_items"]]
            technical_terms = [
                AnalysisTechnicalTerm(**item) for item in normalized["technicalTerms"]
            ]
            pain_points = [
                AnalysisPainPoint(**item) for item in normalized["painPoints"]
            ]
            return AnalysisResponse(
                meeting_id=meeting_id,
                summary=normalized["summary"],
                meetingSummary=normalized["meetingSummary"],
                keywords=normalized["keywords"],
                technical_terms=normalized["technical_terms"],
                action_items=action_items,
                businessActionItems=[
                    ActionItem(**item) for item in normalized["businessActionItems"]
                ],
                keyDecisions=normalized["keyDecisions"],
                risks=normalized["risks"],
                blockers=normalized["blockers"],
                questions=normalized["questions"],
                deadlines=normalized["deadlines"],
                owners=normalized["owners"],
                nextSteps=normalized["nextSteps"],
                businessImpact=normalized["businessImpact"],
                customerImpact=normalized["customerImpact"],
                technicalImpact=normalized["technicalImpact"],
                confidence=normalized["confidence"],
                promptVersion=normalized["promptVersion"],
                schemaVersion=normalized["schemaVersion"],
                created_at=datetime.now(timezone.utc),
                technicalTerms=technical_terms,
                painPoints=pain_points,
                actionItems=normalized["actionItems"],
                domainMode=normalized["domainMode"],
                status=(
                    str(job_state.get("status") or "COMPLETED")
                    if isinstance(job_state, dict)
                    else "COMPLETED"
                ),
                source=normalized["source"] or "job_state",
                transcript_hash=normalized["transcript_hash"],
            )

        if pipeline is None:
            raise HTTPException(
                status_code=503,
                detail="Processing pipeline dependencies are not available",
            )

        analysis = pipeline.get_analysis(meeting_id, db)
        if not analysis:
            raise HTTPException(status_code=404, detail="Analysis not found")

        raw_analysis: dict[str, Any] = {
            "summary": analysis.summary or "",
            "keywords": analysis.keywords or [],
            "action_items": analysis.action_items or [],
        }
        technical_terms_value = analysis.technical_terms or []
        if isinstance(technical_terms_value, dict):
            raw_analysis.update(technical_terms_value)
            raw_analysis["technical_terms"] = (
                technical_terms_value.get("technical_terms")
                or technical_terms_value.get("terms")
                or []
            )
        else:
            raw_analysis["technical_terms"] = technical_terms_value

        normalized = _normalize_analysis_payload(raw_analysis)
        action_items = [ActionItem(**item) for item in normalized["action_items"]]
        technical_terms = [
            AnalysisTechnicalTerm(**item) for item in normalized["technicalTerms"]
        ]
        pain_points = [AnalysisPainPoint(**item) for item in normalized["painPoints"]]
        return AnalysisResponse(
            meeting_id=meeting_id,
            summary=normalized["summary"],
            meetingSummary=normalized["meetingSummary"],
            keywords=normalized["keywords"],
            technical_terms=normalized["technical_terms"],
            action_items=action_items,
            businessActionItems=[
                ActionItem(**item) for item in normalized["businessActionItems"]
            ],
            keyDecisions=normalized["keyDecisions"],
            risks=normalized["risks"],
            blockers=normalized["blockers"],
            questions=normalized["questions"],
            deadlines=normalized["deadlines"],
            owners=normalized["owners"],
            nextSteps=normalized["nextSteps"],
            businessImpact=normalized["businessImpact"],
            customerImpact=normalized["customerImpact"],
            technicalImpact=normalized["technicalImpact"],
            confidence=normalized["confidence"],
            promptVersion=normalized["promptVersion"],
            schemaVersion=normalized["schemaVersion"],
            created_at=analysis.created_at or datetime.now(timezone.utc),
            technicalTerms=technical_terms,
            painPoints=pain_points,
            actionItems=normalized["actionItems"],
            domainMode=normalized["domainMode"],
            status="COMPLETED",
            source=normalized["source"] or "database",
            transcript_hash=normalized["transcript_hash"],
        )

    except HTTPException:
        raise
    except Exception as e:
        request_id = uuid4().hex
        logger.error(
            "event=REQUEST_FAILED requestId={} path=/api/meeting/{}/analysis errorCode={} error={}",
            request_id,
            meeting_id,
            type(e).__name__,
            safe_error_message(e),
        )
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error. request_id={request_id}",
        )


@app.post(
    "/api/internal/realtime-analysis",
    response_model=RealtimeTranscriptAnalysisResponse,
)
async def analyze_realtime_transcript(
    request: RealtimeTranscriptAnalysisRequest,
    db: Session = Depends(get_db),
):
    try:
        meeting_id = int(request.meeting_id)
        source = str(request.source or "realtime").strip().lower() or "realtime"
        transcript_text = _normalize_transcript_text(request.transcript)
        if not transcript_text:
            logger.warning(
                "event=REALTIME_ANALYSIS_FAILED meetingId={} source={} errorCode=EMPTY_TRANSCRIPT",
                meeting_id,
                source,
            )
            raise HTTPException(
                status_code=422,
                detail="Empty transcript",
            )

        transcript_hash = _compute_transcript_hash(
            transcript_text, request.transcript_hash
        )
        prompt_version = _normalize_analysis_version(
            request.prompt_version, AIAnalyzer.PROMPT_VERSION
        )
        schema_version = _normalize_analysis_version(
            request.schema_version, AIAnalyzer.SCHEMA_VERSION
        )
        analysis_cache_key = _analysis_cache_key(
            transcript_hash, prompt_version, schema_version
        )
        existing = db.query(Analysis).filter(Analysis.meeting_id == meeting_id).first()
        if _is_matching_completed_analysis(
            existing,
            transcript_hash=transcript_hash,
            prompt_version=prompt_version,
            schema_version=schema_version,
        ):
            logger.info(
                "REALTIME_ANALYSIS_SKIPPED reason=already_exists meetingId={} promptVersion={} schemaVersion={}",
                meeting_id,
                prompt_version,
                schema_version,
            )
            return RealtimeTranscriptAnalysisResponse(
                meeting_id=meeting_id,
                status="skipped",
                reason="already_exists",
                transcript_hash=transcript_hash,
                source=source,
                promptVersion=prompt_version,
                schemaVersion=schema_version,
            )

        (
            allowed,
            skip_reason,
            skip_error_code,
            retry_after_seconds,
            lock_token,
        ) = _try_begin_realtime_analysis(
            meeting_id,
            analysis_cache_key,
            source,
            prompt_version,
            schema_version,
        )
        if not allowed:
            if skip_reason in {"in_progress", "already_exists"}:
                existing_now = (
                    db.query(Analysis).filter(Analysis.meeting_id == meeting_id).first()
                )
                if _is_matching_completed_analysis(
                    existing_now,
                    transcript_hash=transcript_hash,
                    prompt_version=prompt_version,
                    schema_version=schema_version,
                ):
                    logger.info(
                        "REALTIME_ANALYSIS_SKIPPED reason=already_exists meetingId={} promptVersion={} schemaVersion={}",
                        meeting_id,
                        prompt_version,
                        schema_version,
                    )
                    return RealtimeTranscriptAnalysisResponse(
                        meeting_id=meeting_id,
                        status="skipped",
                        reason="already_exists",
                        transcript_hash=transcript_hash,
                        source=source,
                        promptVersion=prompt_version,
                        schemaVersion=schema_version,
                    )
            logger.info(
                "event=REALTIME_ANALYSIS_SKIPPED reason={} meetingId={} retryAfterSeconds={}",
                skip_reason,
                meeting_id,
                retry_after_seconds,
            )
            if skip_reason == "cooldown_active":
                return RealtimeTranscriptAnalysisResponse(
                    meeting_id=meeting_id,
                    status="failed",
                    reason=skip_reason,
                    transcript_hash=transcript_hash,
                    source=source,
                    promptVersion=prompt_version,
                    schemaVersion=schema_version,
                    retryAfterSeconds=retry_after_seconds,
                    errorCode=skip_error_code or "GEMINI_ANALYSIS_FAILED",
                )
            return RealtimeTranscriptAnalysisResponse(
                meeting_id=meeting_id,
                status="skipped",
                reason=skip_reason,
                transcript_hash=transcript_hash,
                source=source,
                promptVersion=prompt_version,
                schemaVersion=schema_version,
                retryAfterSeconds=retry_after_seconds or None,
                errorCode=skip_error_code,
            )

        logger.info(
            "event=REALTIME_ANALYSIS_TRIGGERED meetingId={} source={}",
            meeting_id,
            source,
        )
        success = False
        finish_error_code: str | None = None
        finish_error_reason: str | None = None
        finish_retry_after_seconds = 0
        try:
            response = _analyze_and_persist_realtime_transcript(
                meeting_id=meeting_id,
                transcript_text=transcript_text,
                transcript_hash=transcript_hash,
                prompt_version=prompt_version,
                schema_version=schema_version,
                source=source,
                domain_mode=request.domain_mode,
                db=db,
            )
            success = True
            return response
        except AnalysisParseError as analysis_error:
            db.rollback()
            logger.warning(
                "event=REALTIME_ANALYSIS_FAILED meetingId={} source={} errorCode=GEMINI_ANALYSIS_FAILED error={}",
                meeting_id,
                source,
                safe_error_message(analysis_error),
            )
            finish_error_code = "GEMINI_ANALYSIS_FAILED"
            finish_error_reason = safe_error_message(analysis_error)
            finish_retry_after_seconds = int(
                _REALTIME_ANALYSIS_FAILURE_COOLDOWN_SECONDS
            )
            raise HTTPException(
                status_code=502,
                detail="Gemini analysis failed",
            ) from analysis_error
        except (AnalysisConfigError, AnalysisUnavailableError) as analysis_error:
            db.rollback()
            logger.warning(
                "event=REALTIME_ANALYSIS_FAILED meetingId={} source={} errorCode=GEMINI_UNAVAILABLE error={}",
                meeting_id,
                source,
                safe_error_message(analysis_error),
            )
            finish_error_code = "GEMINI_UNAVAILABLE"
            finish_error_reason = safe_error_message(analysis_error)
            finish_retry_after_seconds = int(
                _REALTIME_ANALYSIS_FAILURE_COOLDOWN_SECONDS
            )
            raise HTTPException(
                status_code=503,
                detail="Gemini service unavailable",
            ) from analysis_error
        except Exception as analysis_error:
            db.rollback()
            logger.warning(
                "event=REALTIME_ANALYSIS_FAILED meetingId={} source={} errorCode=GEMINI_ANALYSIS_FAILED error={}",
                meeting_id,
                source,
                safe_error_message(analysis_error),
            )
            finish_error_code = "GEMINI_ANALYSIS_FAILED"
            finish_error_reason = safe_error_message(analysis_error)
            finish_retry_after_seconds = int(
                _REALTIME_ANALYSIS_FAILURE_COOLDOWN_SECONDS
            )
            raise HTTPException(
                status_code=502,
                detail="Gemini analysis failed",
            ) from analysis_error
        finally:
            _finish_realtime_analysis(
                meeting_id,
                analysis_cache_key,
                success=success,
                source=source,
                lock_token=lock_token,
                prompt_version=prompt_version,
                schema_version=schema_version,
                error_code=finish_error_code,
                error_reason=finish_error_reason,
                retry_after_seconds=finish_retry_after_seconds,
            )

    except HTTPException:
        raise
    except Exception as e:
        request_id = uuid4().hex
        logger.error(
            "event=REQUEST_FAILED requestId={} path=/api/internal/realtime-analysis errorCode={} error={}",
            request_id,
            type(e).__name__,
            safe_error_message(e),
        )
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


def _iso_utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _dependency_state(is_up: bool) -> str:
    return "UP" if is_up else "DOWN"


def _health_payload(
    *,
    status: str,
    dependencies: dict[str, str],
    legacy_status: str,
    extras: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "status": status,
        "service": "ai-service",
        "timestamp": _iso_utc_timestamp(),
        "dependencies": dependencies,
        "legacyStatus": legacy_status,
    }
    if extras:
        payload.update(extras)
    return payload


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    await _cleanup_stale_stt_actors()
    return _health_payload(
        status="UP",
        dependencies={},
        legacy_status="healthy",
        extras={
            "analysisProvider": settings.analysis_provider,
            "sttProvider": settings.stt_provider,
            "whisper_model": settings.whisper_model,
            "device": get_runtime_device(),
            "lazy_load_models": settings.lazy_load_models,
            "enable_speaker_diarization": settings.enable_speaker_diarization,
            "stt_actor_registry": _stt_registry_summary(),
        },
    )


@app.get("/metrics")
async def metrics() -> Response:
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/ready")
async def readiness_check():
    await _cleanup_stale_stt_actors()
    dependencies: dict[str, str] = {}
    ready = True

    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        dependencies["database"] = "UP"
    except Exception as exc:
        logger.warning("Readiness database check failed: {}", safe_error_message(exc))
        dependencies["database"] = "DOWN"
        ready = False

    try:
        _get_client().ping()
        dependencies["redis"] = "UP"
    except Exception as exc:
        logger.warning("Readiness redis check failed: {}", safe_error_message(exc))
        dependencies["redis"] = "DOWN"
        ready = False

    pipeline_ready = pipeline is not None
    dependencies["pipeline"] = _dependency_state(pipeline_ready)
    if not pipeline_ready:
        ready = False

    deepgram_required = (settings.stt_provider or "").strip().lower() == "deepgram"
    deepgram_configured = bool((settings.deepgram_api_key or "").strip())
    dependencies["deepgramConfigured"] = _dependency_state(deepgram_configured)
    if deepgram_required and not deepgram_configured:
        ready = False

    analysis_provider = (settings.analysis_provider or "").strip().lower()
    gemini_required = analysis_provider == "gemini"
    gemini_configured = bool((settings.gemini_api_key or "").strip())
    dependencies["geminiConfigured"] = _dependency_state(gemini_configured)
    if gemini_required and not gemini_configured:
        ready = False

    payload = _health_payload(
        status="UP" if ready else "DOWN",
        dependencies=dependencies,
        legacy_status="ready" if ready else "not_ready",
        extras={
            "analysisProvider": analysis_provider,
            "sttProvider": (settings.stt_provider or "").strip().lower(),
            "stt_actor_registry": _stt_registry_summary(),
        },
    )
    if not ready:
        return JSONResponse(status_code=503, content=payload)
    return payload


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    error, message, details = _map_http_exception(request, exc)
    headers = dict(exc.headers or {})
    return build_error_response(
        error=error,
        message=message,
        status=int(exc.status_code),
        request=request,
        details=details,
        headers=headers,
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    errors: list[dict[str, object]] = []
    for item in list(exc.errors())[:10]:
        errors.append(
            {
                "loc": [str(part) for part in item.get("loc", [])],
                "msg": str(item.get("msg", "")),
                "type": str(item.get("type", "")),
            }
        )
    return build_error_response(
        error="VALIDATION_ERROR",
        message=_default_error_message("VALIDATION_ERROR"),
        status=422,
        request=request,
        details={"errors": errors},
    )


@app.exception_handler(AnalysisProviderError)
async def analysis_provider_exception_handler(
    request: Request, exc: AnalysisProviderError
):
    provider = _normalize_error_text(getattr(exc, "provider", ""))
    if isinstance(exc, AnalysisParseError) and provider == "gemini":
        error = "GEMINI_ANALYSIS_FAILED"
        status_code = 502
    elif provider == "deepgram":
        error = "DEEPGRAM_UNAVAILABLE"
        status_code = 503
    elif provider == "gemini":
        error = "GEMINI_UNAVAILABLE"
        status_code = 503
    elif isinstance(exc, AnalysisRateLimitError):
        error = "SERVICE_UNAVAILABLE"
        status_code = 503
    elif isinstance(exc, AnalysisNotImplementedError):
        error = "SERVICE_UNAVAILABLE"
        status_code = 503
    elif isinstance(exc, (AnalysisConfigError, AnalysisUnavailableError)):
        error = "SERVICE_UNAVAILABLE"
        status_code = 503
    else:
        error = "SERVICE_UNAVAILABLE"
        status_code = 503

    return build_error_response(
        error=error,
        message=_default_error_message(error),
        status=status_code,
        request=request,
        details={"provider": provider} if provider else None,
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.exception(
        "Unhandled exception trace_id={}: {}",
        _resolve_trace_id(request),
        safe_error_message(exc),
    )
    return build_error_response(
        error="INTERNAL_ERROR",
        message=_default_error_message("INTERNAL_ERROR"),
        status=500,
        request=request,
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
        logger.error(
            "event=REQUEST_FAILED requestId={} path=/api/process errorCode={} error={}",
            request_id,
            type(e).__name__,
            safe_error_message(e),
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
        logger.error(
            "event=REQUEST_FAILED requestId={} path=/api/upload-audio errorCode={} error={}",
            request_id,
            type(e).__name__,
            safe_error_message(e),
        )
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
    language: str = Form(default=""),
    speaker_mode: str = Form(default=""),
    is_final: bool = Form(default=False),
    request: Request = None,
):
    started_at = time.time()
    trace_id = (
        getattr(getattr(request, "state", None), "trace_id", None)
        if request is not None
        else None
    ) or uuid4().hex
    request_id = (
        getattr(getattr(request, "state", None), "request_id", None)
        if request is not None
        else None
    ) or trace_id
    normalized_language = _normalize_stt_language(language)
    normalized_speaker_mode = _normalize_speaker_mode(
        speaker_mode if isinstance(speaker_mode, str) else None
    )
    effective_diarize = _resolve_effective_diarize(normalized_speaker_mode)
    endpointing_resolution = _resolve_realtime_endpointing(normalized_language)
    chunk_bytes = await audio_chunk.read()
    realtime_model = _resolve_realtime_model()
    endpointing_value = (
        endpointing_resolution.endpointing
        if endpointing_resolution.endpointing is not None
        else "omitted"
    )
    request_language = language or ""
    interim_results_enabled = True
    smart_format_enabled = not settings.deepgram_simplify_streaming_url
    utterances_enabled = not settings.deepgram_simplify_streaming_url
    detect_language_enabled = False
    sample_rate = 16000
    encoding = "webm"
    channels = "unknown"
    logger.info(
        "event=REALTIME_STT_DIAGNOSTIC_START traceId={} requestId={} meetingId={} source=realtime requestedLanguage={} effectiveLanguage={} deepgramLanguage={} model={}",
        trace_id,
        request_id,
        meeting_id,
        request_language,
        normalized_language,
        normalized_language,
        realtime_model,
    )
    logger.info(
        "event=REALTIME_STT_DIAGNOSTIC_CONFIG traceId={} requestId={} meetingId={} source=realtime requestedLanguage={} effectiveLanguage={} deepgramLanguage={} model={} endpointing={} interimResults={} smartFormat={} utterances={} diarize={} detectLanguage={} encoding={} sampleRate={} channels={}",
        trace_id,
        request_id,
        meeting_id,
        request_language,
        normalized_language,
        normalized_language,
        realtime_model,
        endpointing_value,
        interim_results_enabled,
        smart_format_enabled,
        utterances_enabled,
        effective_diarize,
        detect_language_enabled,
        encoding,
        sample_rate,
        channels,
    )
    logger.info(
        "event=DEEPGRAM_STT_REQUEST traceId={} requestId={} meetingId={} source=realtime requestedLanguage={} path=/api/v1/stt/stream",
        trace_id,
        request_id,
        meeting_id,
        request_language,
    )
    logger.info(
        "event=DEEPGRAM_STT_CONFIG traceId={} requestId={} meetingId={} source=realtime provider=deepgram language={} model={} endpointing={}",
        trace_id,
        request_id,
        meeting_id,
        normalized_language,
        realtime_model,
        endpointing_value,
    )
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
    logger.info(
        "STT_STREAM_EFFECTIVE_CONFIG meeting_id={} seq={} language={} speaker_mode={} diarize={} model={} endpointing={} endpointing_source={} endpointing_env={}",
        meeting_id,
        seq,
        normalized_language,
        normalized_speaker_mode,
        effective_diarize,
        _resolve_realtime_model(),
        endpointing_value,
        endpointing_resolution.source,
        endpointing_resolution.env_name or "omitted",
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

    if (
        (not is_final)
        and guard.requires_new_stream
        and not (seq == 1 and _is_webm_header_chunk(chunk_bytes))
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
                "error": "webm_continuation_after_reconnect_blocked",
                "reason": "new recording lifecycle required",
                "reset_required": True,
                "last_ack_seq": guard.last_terminal_seq,
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

    if is_final and guard.requires_new_stream:
        logger.warning(
            "FINALIZE_PARTIAL_TRANSCRIPT meeting_id={} seq={} last_ack_seq={} reason={}",
            meeting_key,
            seq,
            guard.last_terminal_seq,
            guard.last_terminal_close_error or "stream previously closed",
        )
        return SttStreamResponse(
            transcript="",
            is_final=True,
            confidence=None,
            finalized=False,
            partial=True,
            reset_required=True,
        )

    try:
        actor = await _get_or_create_stt_actor(
            meeting_key,
            normalized_language,
            normalized_speaker_mode,
            seq=seq,
            chunk_bytes=chunk_bytes,
            endpointing=endpointing_resolution.endpointing,
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
            logger.exception(
                "Failed to create STT session: {}", safe_error_message(exc)
            )
        logger.warning(
            "event=DEEPGRAM_STT_FAILED traceId={} requestId={} meetingId={} source=realtime errorCode={} error={}",
            trace_id,
            request_id,
            meeting_id,
            type(exc).__name__,
            safe_error_message(exc),
        )
        logger.warning(
            "event=REALTIME_STT_DIAGNOSTIC_FAILED traceId={} requestId={} meetingId={} source=realtime requestedLanguage={} effectiveLanguage={} deepgramLanguage={} model={} endpointing={} finalSegmentCount={} speechFinalCount={} isFinalCount={} transcriptLength={} transcriptHashPrefix={} durationMs={} errorCode={} error={}",
            trace_id,
            request_id,
            meeting_id,
            request_language,
            normalized_language,
            normalized_language,
            realtime_model,
            endpointing_value,
            0,
            0,
            0,
            0,
            transcript_hash_prefix(""),
            int((time.time() - started_at) * 1000),
            type(exc).__name__,
            safe_error_message(exc),
        )
        raise HTTPException(
            status_code=503,
            detail=f"Failed to initialize STT: {safe_error_message(exc)}",
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
        realtime_diagnostics = _resolve_realtime_session_diagnostics(actor)
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
                safe_error_message(exc),
            )
            logger.warning(
                "event=DEEPGRAM_STT_FAILED traceId={} requestId={} meetingId={} source=realtime errorCode={} error={}",
                trace_id,
                request_id,
                meeting_key,
                type(exc).__name__,
                safe_error_message(exc),
            )
            logger.warning(
                "event=REALTIME_STT_DIAGNOSTIC_FAILED traceId={} requestId={} meetingId={} source=realtime requestedLanguage={} effectiveLanguage={} deepgramLanguage={} model={} endpointing={} finalSegmentCount={} speechFinalCount={} isFinalCount={} transcriptLength={} transcriptHashPrefix={} durationMs={} errorCode={} error={}",
                trace_id,
                request_id,
                meeting_key,
                request_language,
                normalized_language,
                normalized_language,
                realtime_model,
                endpointing_value,
                realtime_diagnostics.get("final_segment_count", 0),
                realtime_diagnostics.get("speech_final_count", 0),
                realtime_diagnostics.get("is_final_count", 0),
                realtime_diagnostics.get("transcript_length", 0),
                realtime_diagnostics.get("transcript_hash_prefix", ""),
                int((time.time() - started_at) * 1000),
                type(exc).__name__,
                safe_error_message(exc),
            )
            if is_final:
                logger.warning(
                    "FINALIZE_PARTIAL_TRANSCRIPT meeting_id={} seq={} last_ack_seq={} reason={}",
                    meeting_key,
                    seq,
                    guard.last_terminal_seq,
                    guard.last_terminal_close_error or error_name,
                )
                fallback_response = getattr(actor, "_last_persisted_response", None)
                fallback_transcript = ""
                fallback_confidence = None
                if isinstance(fallback_response, SttStreamResponse):
                    fallback_transcript = str(fallback_response.transcript or "")
                    fallback_confidence = fallback_response.confidence
                return SttStreamResponse(
                    transcript=fallback_transcript,
                    is_final=True,
                    confidence=fallback_confidence,
                    finalized=False,
                    partial=True,
                    reset_required=True,
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
                            else f"STT stream failed: {safe_error_message(exc)}"
                        )
                    )
                ),
                "retry_after_seconds": (
                    max(1, int(guard.cooldown_until - time.time() + 0.999))
                    if guard.cooldown_until > time.time()
                    else None
                ),
            }
            if guard.requires_new_stream or isinstance(exc, SttOwnershipLost):
                detail["error"] = "webm_continuation_after_reconnect_blocked"
                detail["reset_required"] = True
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
            safe_error_message(exc),
        )
        logger.warning(
            "event=DEEPGRAM_STT_FAILED traceId={} requestId={} meetingId={} source=realtime errorCode={} error={}",
            trace_id,
            request_id,
            meeting_key,
            type(exc).__name__,
            safe_error_message(exc),
        )
        logger.warning(
            "event=REALTIME_STT_DIAGNOSTIC_FAILED traceId={} requestId={} meetingId={} source=realtime requestedLanguage={} effectiveLanguage={} deepgramLanguage={} model={} endpointing={} finalSegmentCount={} speechFinalCount={} isFinalCount={} transcriptLength={} transcriptHashPrefix={} durationMs={} errorCode={} error={}",
            trace_id,
            request_id,
            meeting_key,
            request_language,
            normalized_language,
            normalized_language,
            realtime_model,
            endpointing_value,
            realtime_diagnostics.get("final_segment_count", 0),
            realtime_diagnostics.get("speech_final_count", 0),
            realtime_diagnostics.get("is_final_count", 0),
            realtime_diagnostics.get("transcript_length", 0),
            realtime_diagnostics.get("transcript_hash_prefix", ""),
            int((time.time() - started_at) * 1000),
            type(exc).__name__,
            safe_error_message(exc),
        )
        raise HTTPException(
            status_code=502,
            detail=f"STT stream failed for meeting_id={meeting_id}: {safe_error_message(exc)}",
        ) from exc

    if is_final:
        realtime_diagnostics = _resolve_realtime_session_diagnostics(
            actor, fallback_transcript=response.transcript
        )
        _store_final_response(meeting_key, response)
        _stt_stream_sessions.pop(meeting_key, None)
        _clear_stream_retry_guard(meeting_key)
        logger.info(
            "event=DEEPGRAM_STT_COMPLETED traceId={} requestId={} meetingId={} source=realtime durationMs={} transcriptLength={}",
            trace_id,
            request_id,
            meeting_key,
            int((time.time() - started_at) * 1000),
            len(response.transcript),
        )
        logger.info(
            "event=REALTIME_STT_SEGMENT_FINAL traceId={} requestId={} meetingId={} source=realtime isFinal={} speechFinal={} segmentTextLength={} segmentHashPrefix={} finalSegmentCount={} speechFinalCount={} isFinalCount={}",
            trace_id,
            request_id,
            meeting_key,
            bool(response.is_final),
            bool(response.is_final),
            len(response.transcript or ""),
            transcript_hash_prefix(response.transcript or ""),
            realtime_diagnostics.get("final_segment_count", 0),
            realtime_diagnostics.get("speech_final_count", 0),
            realtime_diagnostics.get("is_final_count", 0),
        )
        logger.info(
            "event=REALTIME_STT_DIAGNOSTIC_COMPLETED traceId={} requestId={} meetingId={} source=realtime requestedLanguage={} effectiveLanguage={} deepgramLanguage={} model={} endpointing={} finalSegmentCount={} speechFinalCount={} isFinalCount={} transcriptLength={} transcriptHashPrefix={} durationMs={}",
            trace_id,
            request_id,
            meeting_key,
            request_language,
            normalized_language,
            normalized_language,
            realtime_model,
            endpointing_value,
            realtime_diagnostics.get("final_segment_count", 0),
            realtime_diagnostics.get("speech_final_count", 0),
            realtime_diagnostics.get("is_final_count", 0),
            realtime_diagnostics.get(
                "transcript_length", len(response.transcript or "")
            ),
            realtime_diagnostics.get(
                "transcript_hash_prefix",
                transcript_hash_prefix(response.transcript or ""),
            ),
            int((time.time() - started_at) * 1000),
        )
        logger.info(
            "STT_FINALIZATION_END meeting_id={} session_id={} seq={} transcript_length={}",
            meeting_key,
            actor.session_id,
            seq,
            len(response.transcript),
        )
        return response

    realtime_diagnostics = _resolve_realtime_session_diagnostics(
        actor, fallback_transcript=response.transcript or ""
    )
    logger.info(
        "event=DEEPGRAM_STT_COMPLETED traceId={} requestId={} meetingId={} source=realtime durationMs={} transcriptLength={}",
        trace_id,
        request_id,
        meeting_key,
        int((time.time() - started_at) * 1000),
        len(response.transcript or ""),
    )
    logger.info(
        "event=REALTIME_STT_DIAGNOSTIC_COMPLETED traceId={} requestId={} meetingId={} source=realtime requestedLanguage={} effectiveLanguage={} deepgramLanguage={} model={} endpointing={} finalSegmentCount={} speechFinalCount={} isFinalCount={} transcriptLength={} transcriptHashPrefix={} durationMs={}",
        trace_id,
        request_id,
        meeting_key,
        request_language,
        normalized_language,
        normalized_language,
        realtime_model,
        endpointing_value,
        realtime_diagnostics.get("final_segment_count", 0),
        realtime_diagnostics.get("speech_final_count", 0),
        realtime_diagnostics.get("is_final_count", 0),
        realtime_diagnostics.get("transcript_length", len(response.transcript or "")),
        realtime_diagnostics.get(
            "transcript_hash_prefix",
            transcript_hash_prefix(response.transcript or ""),
        ),
        int((time.time() - started_at) * 1000),
    )
    return response
