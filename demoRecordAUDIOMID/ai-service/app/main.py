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
from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
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
from app.realtime_config_guard import (
    evaluate_realtime_config,
    log_realtime_config_guard,
)
from app.database import (
    Base,
    engine,
    ensure_bigint_meeting_id,
    ensure_transcript_canonical_sidecar_columns,
    get_db,
    wait_for_database,
)
from app.ffmpeg_utils import ensure_ffmpeg_on_path
from app.job_status_store import (
    _get_client,
    build_completed_analysis_job_result,
    cleanup_expired_job_statuses,
    get_job_status,
    load_job_statuses,
    set_job_status,
)
from app.metrics import gemini_metrics, stt_metrics
from app.models import Analysis, Transcript
from app.logging_utils import safe_error_message, transcript_hash_prefix
from app.services.ai_analyzer import AIAnalyzer
from app.schemas import (
    ActionItem,
    AnalysisPainPoint,
    AnalysisRerunRequest,
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
from app.services.analysis_versioning import merge_domain_analysis_payload
from app.services.segment_identity import (
    collect_allowed_segment_ids,
    format_aligned_transcript_for_analysis,
    resolve_segment_id_for_read,
)
from app.services.analysis_runs import (
    ANALYSIS_MODE_CACHE_ONLY,
    ANALYSIS_MODE_FAILED_RETRY,
    ANALYSIS_MODE_FORCE,
    ANALYSIS_STATUS_ANALYZING,
    ANALYSIS_STATUS_FAILED,
    ANALYSIS_STATUS_FAILED_RETRYABLE,
    ANALYSIS_STATUS_UNAVAILABLE_FOR_SCOPE,
    analysis_payload_from_run,
    analysis_miss_response_metadata,
    analysis_run_response_metadata,
    begin_analysis_run,
    build_analysis_cache_identity,
    build_analysis_run_idempotency_key_for_identity,
    find_completed_analysis_run_for_identity,
    find_in_progress_analysis_run_for_identity,
    find_latest_analysis_run_for_identity,
    is_analysis_run_retryable,
    latest_completed_analysis_run,
    mark_analysis_run_failed,
    mark_analysis_run_skipped_short,
    normalize_analysis_mode,
    persist_completed_analysis_run,
)
from app.services.analysis_lock import (
    acquire_analysis_lock,
    holder_trace_id,
    is_ai_owned_lock,
    lock_token_from_raw,
    release_analysis_lock,
)
from app.services.analysis_retry_scheduler import (
    ANALYSIS_LOCK_TTL_SECONDS,
    enqueue_background_retry,
    is_retryable_error_code,
)
from app.services.gemini_context_budget import estimate_text_tokens
from app.services.gemini_cost_guard import GeminiCostGuard
from app.services.transcript_quality_gate import evaluate_transcript_quality
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
from app.services.stt_persistence import (
    TranscriptPersistenceRepository,
    validate_transcript_provenance,
)
from app.services.transcript_canonicalizer import build_raw_transcript_hash
from app.services.stt_session_actor import MeetingSessionActor, MeetingSessionState
from app.upload_validation_policy import (
    effective_allowed_extensions,
    effective_max_upload_bytes,
)
from app.routes.stt_stream import validate_stream_chunk
from app.routes.upload import validate_upload_mime
from app.routes.internal_meetings import router as internal_meetings_router
from app.routes.config_lexicon import router as config_lexicon_router
from app.study_routes import router as study_router
from app.tasks import process_meeting
from app.otel_setup import bind_trace_id_attribute, instrument_fastapi_app

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
        ensure_transcript_canonical_sidecar_columns()
    except Exception as e:
        if is_production:
            raise RuntimeError(
                "Canonical transcript sidecar migration failed during production startup"
            ) from e
        logger.warning(
            "Canonical transcript sidecar migration skipped: {}",
            safe_error_message(e),
        )

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
    if _legacy_local_stt_enabled_for_startup_log():
        logger.info(f"Whisper Model: {settings.whisper_model}")
        logger.info(f"Device: {get_runtime_device()}")
    else:
        logger.info(
            "Legacy local STT disabled; cloud STT provider={}", settings.stt_provider
        )
    logger.info(
        "STT CONFIG api_key_exists={} realtime_model={} batch_model={} language={} base_url={}",
        bool(settings.deepgram_api_key),
        _resolve_realtime_model(),
        _resolve_batch_model(),
        _normalize_stt_language(None),
        settings.deepgram_base_url,
    )
    guard_report = evaluate_realtime_config(settings)
    log_realtime_config_guard(guard_report)
    if guard_report.has_errors() and is_production:
        raise RuntimeError(
            "Realtime config guard failed with ERROR findings; see REALTIME_CONFIG_GUARD logs"
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
instrument_fastapi_app(app)

app.include_router(internal_meetings_router)
app.include_router(config_lexicon_router)

app.include_router(study_router)

_stt_adapter: DeepgramSTTAdapter | None = None
_stt_stream_sessions: dict[str, MeetingSessionActor] = {}
_stt_stream_registry_lock = asyncio.Lock()
_stt_stream_retry_guards: dict[str, "MeetingStreamRetryGuard"] = {}
_stt_finalized_responses: dict[str, tuple[SttStreamResponse, float]] = {}
_STT_FINALIZED_RESPONSE_TTL_SECONDS = 300.0
_REALTIME_ANALYSIS_GUARD_TTL_SECONDS = 30.0 * 60.0
_REALTIME_ANALYSIS_LOCK_TTL_SECONDS = float(ANALYSIS_LOCK_TTL_SECONDS)
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


def _as_optional_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return ""


def _normalize_stream_key(meeting_id: int | str, stream_id: str | None = "") -> str:
    base = _normalize_meeting_key(meeting_id)
    normalized_stream = _as_optional_text(stream_id).strip().lower()
    if normalized_stream in {"tab", "mic"}:
        return f"{base}:{normalized_stream}"
    return base


def _stt_actor_registry_key(
    meeting_key: str,
    *,
    recording_session_id: int | None = None,
    attempt_id: int | None = None,
) -> str:
    provenance = validate_transcript_provenance(recording_session_id, attempt_id)
    if not provenance.is_v2:
        return meeting_key
    return (
        f"{meeting_key}|recording_session_id={provenance.recording_session_id}"
        f"|attempt_id={provenance.attempt_id}"
    )


def _resolve_speaker_prefix(stream_id: str | None) -> str | None:
    normalized = _as_optional_text(stream_id).strip().lower()
    if normalized == "tab":
        return "TAB"
    if normalized == "mic":
        return "MIC"
    return None


def _parse_stream_id_from_key(meeting_key: str) -> str:
    parts = str(meeting_key).split(":", 1)
    return parts[1].strip().lower() if len(parts) == 2 else ""


def _parse_meeting_id_from_key(meeting_key: str) -> int:
    base = str(meeting_key).split(":", 1)[0].strip()
    return int(base) if base.isdigit() else 0


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
        or "nova-3"
    )


def _legacy_local_stt_allowed() -> bool:
    return bool(getattr(settings, "allow_legacy_local_stt", False))


def _legacy_local_stt_enabled_for_startup_log() -> bool:
    return bool(
        _legacy_local_stt_allowed()
        and (
            getattr(settings, "stt_provider", "") == "local_whisper"
            or getattr(settings, "local_whisper_enabled", False)
        )
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
    registry_key: str | None = None,
    recording_session_id: int | None = None,
    attempt_id: int | None = None,
) -> MeetingSessionActor:
    await _cleanup_stale_stt_actors()
    actor_key = registry_key or _stt_actor_registry_key(
        meeting_key,
        recording_session_id=recording_session_id,
        attempt_id=attempt_id,
    )
    guard = _get_stream_retry_guard(actor_key)
    now = time.time()
    stt_adapter = _get_stt_adapter(endpointing=endpointing)
    if stt_adapter is None:
        raise RuntimeError("Deepgram STT adapter is unavailable")

    ownership_manager = get_stt_ownership_manager()
    shared_cooldown_until = 0.0
    if ownership_manager is not None:
        try:
            shared_cooldown_until = ownership_manager.get_cooldown_until(actor_key)
        except Exception as exc:
            logger.warning(
                "STT_OWNERSHIP_COOLDOWN_READ_ERROR meeting_id={} error={}",
                actor_key,
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
                "meeting_id": actor_key,
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
            _clear_stream_retry_guard(actor_key)
        else:
            raise HTTPException(
                status_code=409,
                detail={
                    "meeting_id": actor_key,
                    "seq": seq,
                    "reason": "new recording lifecycle required",
                },
            )

    async with _stt_stream_registry_lock:
        existing_actor = _stt_stream_sessions.get(actor_key)
        if existing_actor is not None and existing_actor.state not in {
            MeetingSessionState.CLOSED,
            MeetingSessionState.FAILED,
        }:
            if not existing_actor._owns_meeting():
                _stt_stream_sessions.pop(actor_key, None)
                asyncio.create_task(_retire_stt_actor(actor_key, existing_actor))
            else:
                return existing_actor

        lease: SttLease | None = None
        if ownership_manager is not None:
            try:
                lease = ownership_manager.acquire(actor_key)
            except Exception as exc:
                logger.warning(
                    "STT_OWNERSHIP_ACQUIRE_ERROR meeting_id={} error={}",
                    actor_key,
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
                        "meeting_id": actor_key,
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
                recording_session_id=recording_session_id,
                attempt_id=attempt_id,
            )
        except Exception:
            if lease is not None and ownership_manager is not None:
                try:
                    ownership_manager.release(lease)
                except Exception:
                    pass
            raise
        _stt_stream_sessions[actor_key] = actor
        logger.info(
            "STT_OWNERSHIP_ACQUIRED meeting_id={} owner_id={} fencing_token={}",
            actor_key,
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
        smart_format=bool(getattr(settings, "deepgram_smart_format", True)),
        utterances=bool(getattr(settings, "deepgram_utterances", True)),
        paragraphs=bool(getattr(settings, "deepgram_paragraphs", True)),
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


class _AnalysisCacheMetadataAnalyzer:
    PROMPT_VERSION = AIAnalyzer.PROMPT_VERSION
    SCHEMA_VERSION = AIAnalyzer.SCHEMA_VERSION

    def __init__(self, provider: str, model: str):
        self.provider = provider
        self.model = model


def _analysis_cache_metadata_analyzer():
    provider = (settings.analysis_provider or "gemini").strip().lower()
    if provider in {"ollama", "local"}:
        return _AnalysisCacheMetadataAnalyzer("ollama", settings.ollama_model)
    return _AnalysisCacheMetadataAnalyzer("gemini", settings.gemini_analysis_model)


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
    bind_trace_id_attribute(trace_id)
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
    from app.config import get_settings
    from app.errors.error_catalog import get_catalog_entry

    settings = get_settings()
    if settings.error_ux_enabled:
        entry = get_catalog_entry(error)
        if entry is not None:
            return entry["message"]

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
        "GEMINI_RATE_LIMITED": "Gemini rate limit reached",
        "GEMINI_QUOTA_EXHAUSTED": "Gemini quota exhausted",
        "GEMINI_MODEL_UNAVAILABLE": "Gemini model is unavailable for all configured API keys",
        "GEMINI_KEY_POOL_UNAVAILABLE": "Gemini key pool is unavailable",
        "GEMINI_BILLING_CREDITS_DEPLETED": (
            "Dịch vụ AI hiện tạm dừng do project Gemini đã hết billing credit. "
            "Vui lòng bổ sung credit hoặc cập nhật API key thuộc project còn "
            "khả dụng. Yêu cầu này không được tự động thử lại để tránh "
            "phát sinh request lặp."
        ),
        "GEMINI_FREE_TIER_TOKEN_QUOTA_EXHAUSTED": "Gemini free-tier token quota is exhausted",
        "GEMINI_DAILY_QUOTA_EXHAUSTED": "Gemini daily project quota is exhausted",
        "GEMINI_COST_GUARD_UNAVAILABLE": "Gemini cost guard is unavailable; request was blocked safely",
        "GEMINI_COST_LIMIT_EXCEEDED": "Gemini usage budget has been reached",
        "GEMINI_ANALYSIS_FAILED": "Gemini analysis failed",
        "INVALID_LANGUAGE": "Invalid language",
        "EMPTY_TRANSCRIPT": "Transcript is empty",
        "DUPLICATE_REQUEST_SKIPPED": "Duplicate request skipped",
        "VALIDATION_ERROR": "Request validation failed",
        "INTERNAL_ERROR": "Unexpected server error",
    }
    return defaults.get(error, "Unexpected server error")


def _attach_error_ux_details(
    error: str, details: dict[str, object] | None
) -> dict[str, object] | None:
    from app.config import get_settings
    from app.errors.error_catalog import resolve_cta

    if not get_settings().error_ux_enabled:
        return details

    cta = resolve_cta(error)
    if cta is None and details is None:
        return None

    merged: dict[str, object] = dict(details or {})
    if cta is not None:
        merged["cta"] = cta
    return merged if merged else None


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
        "errorCode": error,
        "message": _sanitize_message(message, _default_error_message(error)),
        "status": status,
        "timestamp": _utc_now_iso8601(),
        "traceId": trace_id,
    }
    path = str(request.url.path or "").strip()
    if path:
        payload["path"] = path

    safe_details = _sanitize_details(_attach_error_ux_details(error, details))
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

    if status_code == 413:
        if detail_text == "REALTIME_CHUNK_TOO_LARGE":
            return (
                "REALTIME_CHUNK_TOO_LARGE",
                _default_error_message("REALTIME_CHUNK_TOO_LARGE"),
                details,
            )
        return ("UPLOAD_TOO_LARGE", _default_error_message("UPLOAD_TOO_LARGE"), details)

    if status_code == 415:
        if detail_text == "REALTIME_UNSUPPORTED_ENCODING":
            return (
                "REALTIME_UNSUPPORTED_ENCODING",
                _default_error_message("REALTIME_UNSUPPORTED_ENCODING"),
                details,
            )
        if "mime" in normalized_detail or detail_text == "UPLOAD_MIME_MISMATCH":
            return (
                "UPLOAD_MIME_MISMATCH",
                _default_error_message("UPLOAD_MIME_MISMATCH"),
                details,
            )
        return (
            "UPLOAD_UNSUPPORTED_FORMAT",
            _default_error_message("UPLOAD_UNSUPPORTED_FORMAT"),
            details,
        )

    if status_code in {400, 422}:
        if detail_text == "REALTIME_INVALID_PAYLOAD":
            return (
                "REALTIME_INVALID_PAYLOAD",
                _default_error_message("REALTIME_INVALID_PAYLOAD"),
                details,
            )
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

    if status_code == 429:
        structured_error = ""
        structured_details: dict[str, object] | None = None
        if isinstance(exc.detail, dict):
            structured_error = str(
                exc.detail.get("error") or exc.detail.get("errorCode") or ""
            ).strip()
            nested_details = exc.detail.get("details")
            if isinstance(nested_details, dict):
                structured_details = _sanitize_details(nested_details)
                if not structured_error:
                    structured_error = str(
                        nested_details.get("errorCode")
                        or nested_details.get("error")
                        or ""
                    ).strip()

        normalized_error = structured_error.strip().upper()
        if normalized_error in {"GEMINI_RATE_LIMITED", "GEMINI_QUOTA_EXHAUSTED"}:
            return (
                normalized_error,
                _default_error_message(normalized_error),
                structured_details or details,
            )

        normalized_details = _normalize_error_text(details or {})
        if "gemini" in normalized_detail or "gemini" in normalized_details:
            return (
                "GEMINI_RATE_LIMITED",
                _default_error_message("GEMINI_RATE_LIMITED"),
                structured_details or details,
            )

        return (
            "SERVICE_UNAVAILABLE",
            _default_error_message("SERVICE_UNAVAILABLE"),
            details,
        )

    if status_code == 503:
        structured_error = ""
        structured_details: dict[str, object] | None = None
        if isinstance(exc.detail, dict):
            structured_error = str(
                exc.detail.get("error") or exc.detail.get("errorCode") or ""
            ).strip()
            nested_details = exc.detail.get("details")
            if isinstance(nested_details, dict):
                structured_details = _sanitize_details(nested_details)
                if not structured_error:
                    structured_error = str(
                        nested_details.get("errorCode")
                        or nested_details.get("error")
                        or ""
                    ).strip()
            message = str(exc.detail.get("message") or "").strip()
        else:
            message = ""

        normalized_error = structured_error.strip().upper()
        known_gemini_codes = {
            "GEMINI_UNAVAILABLE",
            "GEMINI_MODEL_UNAVAILABLE",
            "GEMINI_KEY_POOL_UNAVAILABLE",
            "GEMINI_BILLING_CREDITS_DEPLETED",
            "GEMINI_FREE_TIER_TOKEN_QUOTA_EXHAUSTED",
            "GEMINI_DAILY_QUOTA_EXHAUSTED",
            "GEMINI_COST_GUARD_UNAVAILABLE",
            "GEMINI_COST_LIMIT_EXCEEDED",
            "GEMINI_INVALID_KEY",
            "GEMINI_INVALID_REQUEST",
            "GEMINI_REGION_BLOCKED",
            "GEMINI_PROXY_CONNECT_FAILED",
        }
        if normalized_error in known_gemini_codes:
            return (
                normalized_error,
                message or _default_error_message(normalized_error),
                structured_details or details,
            )

        if "deepgram" in normalized_detail:
            return (
                "DEEPGRAM_UNAVAILABLE",
                _default_error_message("DEEPGRAM_UNAVAILABLE"),
                details,
            )
        if "gemini" in normalized_detail or normalized_error.startswith("GEMINI_"):
            return (
                normalized_error or "GEMINI_UNAVAILABLE",
                message
                or _default_error_message(normalized_error or "GEMINI_UNAVAILABLE"),
                structured_details or details,
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
    from app.services.server_audio_roots import get_upload_dir_candidates

    candidates = get_upload_dir_candidates()
    for upload_dir in candidates:
        try:
            upload_dir.mkdir(parents=True, exist_ok=True)
            probe_file = upload_dir / ".write_probe"
            with probe_file.open("wb") as probe:
                probe.write(b"ok")
            probe_file.unlink(missing_ok=True)
            return upload_dir.resolve(strict=False)
        except OSError as write_error:
            logger.warning(
                "Upload directory candidate unavailable name=%s error=%s",
                upload_dir.name,
                type(write_error).__name__,
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
    status_map = {
        "pending": "open",
        "completed": "done",
        "cancelled": "blocked",
    }
    valid_statuses = {"open", "in_progress", "blocked", "done"}
    valid_priorities = {"low", "medium", "high"}
    for item in values:
        if isinstance(item, dict):
            task = str(item.get("task") or item.get("text") or "").strip()
            if not task:
                continue
            owner = str(item.get("owner") or "").strip() or None
            due_date = (
                str(
                    item.get("dueDate")
                    or item.get("due_date")
                    or item.get("deadline")
                    or ""
                ).strip()
                or None
            )
            priority_raw = str(item.get("priority") or "").strip().lower()
            priority = priority_raw if priority_raw in valid_priorities else None
            status_raw = str(item.get("status") or "").strip().lower()
            status = (
                status_raw
                if status_raw in valid_statuses
                else status_map.get(status_raw, "open")
            )
            evidence = str(item.get("evidence") or "").strip() or None
            evidence_quote = (
                str(
                    item.get("evidenceQuote") or item.get("evidence_quote") or ""
                ).strip()
                or None
            )
            evidence_keywords = _coerce_string_list(
                item.get("evidenceKeywords") or item.get("evidence_keywords") or []
            )[:5]
            normalized.append(
                {
                    "task": task,
                    "owner": owner,
                    "dueDate": due_date,
                    "deadline": due_date,
                    "priority": priority,
                    "status": status,
                    "evidence": evidence,
                    "evidenceQuote": evidence_quote,
                    "evidenceKeywords": evidence_keywords,
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
                    "status": "open",
                    "evidence": None,
                    "evidenceQuote": None,
                    "evidenceKeywords": [],
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
    if isinstance(confidence_raw, (int, float)) and not isinstance(
        confidence_raw, bool
    ):
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
    analysis_feature_set = (
        str(
            raw_analysis.get("analysisFeatureSet")
            or raw_analysis.get("analysis_feature_set")
            or ""
        ).strip()
        or AIAnalyzer.ANALYSIS_FEATURE_SET
    )
    grouped_action_plan = raw_analysis.get("groupedActionPlan")
    if grouped_action_plan is None:
        grouped_action_plan = raw_analysis.get("grouped_action_plan")
    if not isinstance(grouped_action_plan, dict):
        grouped_action_plan = None
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
        "analysisFeatureSet": analysis_feature_set,
        "groupedActionPlan": grouped_action_plan,
        "transcript_hash": transcript_hash,
        "transcriptHash": transcript_hash,
        "source": source,
        "cacheHit": raw_analysis.get("cacheHit"),
        "analysisStatus": raw_analysis.get("analysisStatus"),
        "stale": raw_analysis.get("stale"),
        "staleReason": raw_analysis.get("staleReason"),
        "retryAfterSeconds": raw_analysis.get("retryAfterSeconds"),
        "educationStudy": (
            raw_analysis.get("educationStudy")
            if isinstance(raw_analysis.get("educationStudy"), dict)
            else None
        ),
        "evidenceUnavailable": (
            True if raw_analysis.get("evidenceUnavailable") is True else None
        ),
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


def _normalize_analysis_feature_set(value: Any) -> str:
    normalized = str(value or "").strip()
    return normalized or AIAnalyzer.ANALYSIS_FEATURE_SET


def _analysis_cache_key(
    transcript_hash: str,
    prompt_version: str,
    schema_version: str,
    analysis_feature_set: str | None = None,
) -> str:
    return (
        f"{str(transcript_hash or '').strip().lower()}|"
        f"{str(prompt_version or '').strip().lower()}|"
        f"{str(schema_version or '').strip().lower()}|"
        f"{_normalize_analysis_feature_set(analysis_feature_set).lower()}"
    )


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
    return is_ai_owned_lock(lock_token)


def _analysis_state_owner(state: dict[str, str]) -> str:
    owner = str(
        state.get("owner") or state.get("managed_by") or state.get("managedBy") or ""
    ).strip()
    return owner.lower()


def _release_realtime_analysis_lock(
    client: Any,
    meeting_id: int,
    lock_token: str | None = None,
) -> None:
    try:
        if lock_token:
            release_analysis_lock(client, _analysis_lock_key(meeting_id), lock_token)
            return
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
    analysis_attempt: int = 1,
    trace_id: str | None = None,
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

    lock_token: str | None = None
    resolved_trace_id = str(trace_id or uuid4().hex[:12])
    trigger_source = (
        "background" if "background" in str(source or "").lower() else "manual"
    )
    try:
        client = _get_client()
        lock_key = _analysis_lock_key(meeting_id)
        acquired, lock_token, holder_payload = acquire_analysis_lock(
            client,
            lock_key=lock_key,
            meeting_id=meeting_id,
            analysis_input_hash=analysis_cache_key,
            trigger_source=trigger_source,
            analysis_attempt=analysis_attempt,
            trace_id=resolved_trace_id,
            ttl_seconds=int(_REALTIME_ANALYSIS_LOCK_TTL_SECONDS),
        )
        if not acquired:
            lock_ttl = client.ttl(lock_key)
            lock_token_value = client.get(lock_key)
            state_snapshot = client.hgetall(_analysis_state_key(meeting_id)) or {}
            status_snapshot = str(state_snapshot.get("status") or "").strip().upper()
            can_recover_foreign_or_orphan_lock = not is_ai_owned_lock(
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
                acquired, lock_token, holder_payload = acquire_analysis_lock(
                    client,
                    lock_key=lock_key,
                    meeting_id=meeting_id,
                    analysis_input_hash=analysis_cache_key,
                    trigger_source=trigger_source,
                    analysis_attempt=analysis_attempt,
                    trace_id=resolved_trace_id,
                    ttl_seconds=int(_REALTIME_ANALYSIS_LOCK_TTL_SECONDS),
                )

            if not acquired:
                retry_after = int(
                    lock_ttl if isinstance(lock_ttl, int) and lock_ttl > 0 else 1
                )
                logger.info(
                    "ANALYSIS_LOCK_DEFERRED meetingId={} triggerSource={} holderTraceId={}",
                    meeting_id,
                    trigger_source,
                    holder_trace_id(holder_payload),
                )
                return False, "in_progress", error_code, retry_after, None

        logger.info(
            "ANALYSIS_LOCK_ACQUIRED meetingId={} triggerSource={} analysisAttempt={} analysisInputHash={} traceId={}",
            meeting_id,
            trigger_source,
            analysis_attempt,
            analysis_cache_key,
            resolved_trace_id,
        )

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
                    _release_realtime_analysis_lock(client, meeting_id, lock_token)
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
        if settings.gemini_cost_guard_enabled:
            return (
                False,
                "guard_unavailable",
                "GEMINI_COST_GUARD_UNAVAILABLE",
                0,
                None,
            )
    return True, None, None, 0, lock_token


def _schedule_background_analysis_retry(
    meeting_id: int,
    *,
    analysis_attempt: int,
    analysis_input_hash: str,
    trace_id: str,
    source: str,
) -> None:
    try:
        client = _get_client()
        enqueue_background_retry(
            client,
            meeting_id=meeting_id,
            analysis_attempt=analysis_attempt,
            analysis_input_hash=analysis_input_hash,
            trace_id=trace_id,
            source=source,
            max_attempts=settings.analysis_background_retry_max_attempts,
            enabled=settings.analysis_background_retry_enabled,
        )
    except Exception as redis_error:
        logger.warning(
            "event=REDIS_OPERATION_FAILED operation=analysis_retry_enqueue meetingId={} errorCode={} error={}",
            meeting_id,
            type(redis_error).__name__,
            safe_error_message(redis_error),
        )


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
    *,
    analysis_retry_count: int | None = None,
    analysis_next_retry_at: str | None = None,
    analysis_trace_id: str | None = None,
    analysis_provider_alias: str | None = None,
    retry_exhausted: bool | None = None,
    error_retryable: bool | None = None,
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
            retryable = is_retryable_error_code(error_code, retryable=error_retryable)
            failure_status = "ANALYSIS_FAILED_RETRYABLE" if retryable else "FAILED"
            max_attempts = settings.analysis_background_retry_max_attempts
            retry_count = int(analysis_retry_count or 0)
            exhausted = (
                retry_exhausted
                if retry_exhausted is not None
                else retry_count >= max_attempts
            )
            failure_mapping = {
                "meeting_id": str(meeting_id),
                "status": failure_status,
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
                "retryable": "true" if retryable else "false",
                "retry_exhausted": "true" if exhausted else "false",
                "analysis_retry_count": str(retry_count),
                "error_code": str(error_code or "GEMINI_ANALYSIS_FAILED"),
                "error_message": str(error_reason or "analysis_failed")[:180],
            }
            if analysis_next_retry_at:
                failure_mapping["analysis_next_retry_at"] = analysis_next_retry_at
            if analysis_trace_id:
                failure_mapping["analysis_trace_id"] = analysis_trace_id
            if analysis_provider_alias:
                failure_mapping["analysis_provider_alias"] = analysis_provider_alias
            client.hset(
                _analysis_state_key(meeting_id),
                mapping=failure_mapping,
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
            release_analysis_lock(client, _analysis_lock_key(meeting_id), lock_token)
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
    analysis_feature_set: str,
    source: str,
    domain_mode: str | None,
    db: Session,
    analysis_run=None,
    rerun_reason: str | None = None,
    reanalysis_generation: int = 0,
    allowed_segment_ids: list[str] | None = None,
    evidence_unavailable: bool = False,
    recording_session_id: int | None = None,
    attempt_id: int | None = None,
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
        "analysisFeatureSet": analysis_feature_set,
        "reanalysisGeneration": max(0, int(reanalysis_generation or 0)),
        "allowedSegmentIds": list(allowed_segment_ids or []),
    }
    if evidence_unavailable:
        metadata["evidenceUnavailable"] = True

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
    prepared_feature_set = (
        prepared.get("analysisFeatureSet")
        or normalized.get("analysisFeatureSet")
        or analysis_feature_set
    )
    action_items_payload = prepared.get("action_items", [])
    grouped_action_plan = (
        prepared.get("groupedActionPlan")
        or normalized.get("groupedActionPlan")
        or _fallback_grouped_action_plan(action_items_payload)
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
        "analysisFeatureSet": prepared_feature_set,
        "groupedActionPlan": grouped_action_plan,
        "source": source,
    }
    if isinstance(prepared.get("educationStudy"), dict):
        technical_terms_payload["educationStudy"] = prepared["educationStudy"]
    elif isinstance(normalized.get("educationStudy"), dict):
        technical_terms_payload["educationStudy"] = normalized["educationStudy"]
    if (
        prepared.get("evidenceUnavailable") is True
        or normalized.get("evidenceUnavailable") is True
        or evidence_unavailable
    ):
        technical_terms_payload["evidenceUnavailable"] = True
    analysis_row = db.query(Analysis).filter(Analysis.meeting_id == meeting_id).first()
    if analysis_row is None:
        analysis_row = Analysis(meeting_id=meeting_id)
        db.add(analysis_row)

    analysis_row.summary = str(prepared.get("summary", ""))
    analysis_row.keywords = clean_keywords
    analysis_row.technical_terms = technical_terms_payload
    analysis_row.action_items = action_items_payload
    analysis_row.created_at = datetime.now(timezone.utc)

    analysis_for_job_state = dict(normalized)
    analysis_for_job_state["transcriptHash"] = transcript_hash
    analysis_for_job_state["transcript_hash"] = transcript_hash
    analysis_for_job_state["promptVersion"] = prompt_version
    analysis_for_job_state["schemaVersion"] = schema_version
    analysis_for_job_state["analysisFeatureSet"] = prepared_feature_set
    analysis_for_job_state["groupedActionPlan"] = grouped_action_plan
    analysis_for_job_state["source"] = source
    if isinstance(technical_terms_payload.get("educationStudy"), dict):
        analysis_for_job_state["educationStudy"] = technical_terms_payload[
            "educationStudy"
        ]
    if technical_terms_payload.get("evidenceUnavailable") is True:
        analysis_for_job_state["evidenceUnavailable"] = True
    analysis_run = persist_completed_analysis_run(
        db=db,
        meeting_id=meeting_id,
        analyzer=analyzer,
        analysis_payload=analysis_for_job_state,
        summary=analysis_row.summary,
        fallback_transcript_hash=transcript_hash,
        fallback_text=transcript_text,
        requested_by=source,
        rerun_reason=rerun_reason,
        run=analysis_run,
    )
    db.commit()
    run_metadata = analysis_run_response_metadata(analysis_run, cache_hit=False)
    job_state_metadata = dict(run_metadata)
    last_analyzed_at = job_state_metadata.get("lastAnalyzedAt")
    if isinstance(last_analyzed_at, datetime):
        job_state_metadata["lastAnalyzedAt"] = last_analyzed_at.isoformat()
    analysis_for_job_state.update(job_state_metadata)

    set_job_status(
        meeting_id=meeting_id,
        status="COMPLETED",
        result=build_completed_analysis_job_result(
            meeting_id=meeting_id,
            analysis=analysis_for_job_state,
            source=source,
            domain_mode=requested_domain_mode,
            recording_session_id=recording_session_id,
            attempt_id=attempt_id,
        ),
        stage="completed",
        progress=100,
    )

    logger.info("REALTIME_ANALYSIS_SAVED meetingId={}", meeting_id)

    return RealtimeTranscriptAnalysisResponse(
        meeting_id=meeting_id,
        status="completed",
        analysis=analysis_for_job_state,
        transcript_hash=transcript_hash,
        source=source,
        promptVersion=prompt_version,
        schemaVersion=schema_version,
        analysisFeatureSet=run_metadata.get("analysisFeatureSet")
        or analysis_feature_set,
        analysisStatus=run_metadata.get("analysisStatus"),
        cacheHit=run_metadata.get("cacheHit"),
        provider=run_metadata.get("provider"),
        model=run_metadata.get("model"),
        canonicalTranscriptHash=run_metadata.get("canonicalTranscriptHash"),
        canonicalTranscriptVersion=run_metadata.get("canonicalTranscriptVersion"),
        analysisInputMode=run_metadata.get("analysisInputMode"),
        lastAnalyzedAt=run_metadata.get("lastAnalyzedAt"),
        stale=run_metadata.get("stale"),
        staleReason=run_metadata.get("staleReason"),
    )


def _fallback_grouped_action_plan(action_items: list[Any]) -> dict[str, Any]:
    normalized_items = []
    for index, item in enumerate((action_items or [])[:8], start=1):
        task = ""
        if isinstance(item, dict):
            task = str(
                item.get("task")
                or item.get("description")
                or item.get("text")
                or item.get("title")
                or ""
            ).strip()
            evidence_keywords = _coerce_string_list(item.get("evidenceKeywords") or [])
            owner = item.get("owner")
            deadline = item.get("deadline") or item.get("dueDate")
            priority = item.get("priority")
            status = item.get("status") or "open"
        else:
            task = str(item or "").strip()
            evidence_keywords = []
            owner = None
            deadline = None
            priority = None
            status = "open"
        if not task:
            continue
        normalized_items.append(
            {
                "id": f"fallback-item-{index}",
                "title": task[:120],
                "description": None,
                "subtasks": [],
                "owner": owner,
                "deadline": deadline,
                "priority": priority,
                "status": status,
                "confidence": "SUPPORTED",
                "evidenceKeywords": evidence_keywords[:8],
                "sourceActionItemIds": [f"action-{index}"],
            }
        )
    if not normalized_items:
        return {
            "version": AIAnalyzer.ANALYSIS_FEATURE_SET,
            "language": "vi",
            "intro": "Chưa có công việc đủ rõ để phân nhóm.",
            "sections": [],
            "notes": [],
        }
    return {
        "version": AIAnalyzer.ANALYSIS_FEATURE_SET,
        "language": "vi",
        "intro": "Dựa trên nội dung cuộc thảo luận trong file audio, dưới đây là danh sách các công việc cần thực hiện, được phân chia theo các nhóm chức năng chính:",
        "sections": [
            {
                "id": "fallback-section-1",
                "order": 1,
                "title": "Công việc chung",
                "summary": None,
                "items": normalized_items,
            }
        ],
        "notes": [],
    }


@app.get("/api/meeting/{meeting_id}/transcript", response_model=TranscriptResponse)
async def get_transcript(
    meeting_id: int,
    recording_session_id: int | None = None,
    attempt_id: int | None = None,
    db: Session = Depends(get_db),
):
    """
    Get transcript for a meeting

    Returns all transcript segments with speaker labels and timestamps
    """

    try:
        transcript_scope = validate_transcript_provenance(
            recording_session_id,
            attempt_id,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "errorCode": "INVALID_PROVENANCE",
                "message": str(exc),
            },
        )

    def _optional_int(value: Any) -> int | None:
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def _build_segment_id(
        *,
        meeting_id_value: int,
        speaker_value: str,
        start_time_value: float,
        explicit_segment_id: Any,
    ) -> str:
        return resolve_segment_id_for_read(
            meeting_id=meeting_id_value,
            speaker=speaker_value,
            start_time=start_time_value,
            explicit_segment_id=explicit_segment_id,
        )

    def _segment_from_mapping(row: dict[str, Any]) -> TranscriptSegment:
        speaker = str(row.get("speaker") or "SPEAKER_1")
        start_time = float(row.get("start_time") or row.get("startTime") or 0.0)
        end_time = float(row.get("end_time") or row.get("endTime") or 0.0)
        text = str(row.get("text") or "")
        return TranscriptSegment(
            speaker=speaker,
            start_time=start_time,
            end_time=end_time,
            text=text,
            segment_id=_build_segment_id(
                meeting_id_value=meeting_id,
                speaker_value=speaker,
                start_time_value=start_time,
                explicit_segment_id=row.get("segment_id"),
            ),
            stream_id=row.get("stream_id") or row.get("streamId"),
            recording_session_id=_optional_int(
                row.get("recording_session_id") or row.get("recordingSessionId")
            ),
            attempt_id=_optional_int(row.get("attempt_id") or row.get("attemptId")),
            seq=_optional_int(row.get("seq")),
            version=_optional_int(row.get("version")),
            is_final=(
                bool(row.get("is_final") or row.get("isFinal"))
                if row.get("is_final") is not None or row.get("isFinal") is not None
                else None
            ),
        )

    def _segment_from_model(row: Transcript) -> TranscriptSegment:
        speaker = str(getattr(row, "speaker", None) or "SPEAKER_1")
        start_time = float(getattr(row, "start_time", None) or 0.0)
        end_time = float(getattr(row, "end_time", None) or 0.0)
        text = str(getattr(row, "text", None) or "")
        return TranscriptSegment(
            speaker=speaker,
            start_time=start_time,
            end_time=end_time,
            text=text,
            segment_id=_build_segment_id(
                meeting_id_value=meeting_id,
                speaker_value=speaker,
                start_time_value=start_time,
                explicit_segment_id=getattr(row, "segment_id", None),
            ),
        )

    def _resolve_canonical_sidecar(
        transcript_rows: list[Transcript],
        raw_rows: list[TranscriptSegment],
    ) -> tuple[list[TranscriptSegment], str, str, datetime | None] | None:
        if not transcript_rows:
            return None

        raw_hash = ""
        if raw_rows:
            raw_hash = build_raw_transcript_hash(
                [
                    {
                        "speaker": segment.speaker,
                        "start_time": segment.start_time,
                        "end_time": segment.end_time,
                        "text": segment.text,
                    }
                    for segment in raw_rows
                ]
            )

        for row in transcript_rows:
            canonical_rows = getattr(row, "canonical_transcript_rows", None)
            if not isinstance(canonical_rows, list) or not canonical_rows:
                continue

            canonical_version = str(
                getattr(row, "canonical_transcript_version", None) or ""
            ).strip()
            canonical_hash = str(
                getattr(row, "canonical_transcript_hash", None) or ""
            ).strip()
            stored_raw_hash = str(
                getattr(row, "raw_transcript_hash", None) or ""
            ).strip()

            if not canonical_version or not canonical_hash:
                continue
            if raw_hash and stored_raw_hash and stored_raw_hash != raw_hash:
                continue

            normalized_rows: list[TranscriptSegment] = []
            for item in canonical_rows:
                if not isinstance(item, dict):
                    continue
                segment = _segment_from_mapping(item)
                if segment.text.strip():
                    normalized_rows.append(segment)

            if not normalized_rows:
                continue

            return (
                normalized_rows,
                canonical_version,
                canonical_hash,
                getattr(row, "canonical_generated_at", None),
            )

        return None

    try:
        logger.info(
            "STT_TRANSCRIPT_GET_STARTED meeting_id={} scope={}",
            meeting_id,
            "v2" if transcript_scope.is_v2 else "legacy",
        )
        if not transcript_scope.is_v2:
            logger.info(
                "event=TRANSCRIPT_LEGACY_SCOPE_DEPRECATED meeting_id={} path=/api/meeting/{{meeting_id}}/transcript",
                meeting_id,
            )

        fragment_segments: list[dict[str, Any]] = []
        try:
            fragment_repository = TranscriptPersistenceRepository(db)
            if transcript_scope.is_v2:
                fragment_segments = (
                    fragment_repository.assemble_attempt_visible_transcript_segments(
                        meeting_id,
                        recording_session_id=transcript_scope.recording_session_id,
                        attempt_id=transcript_scope.attempt_id,
                    )
                )
            else:
                fragment_segments = (
                    fragment_repository.assemble_visible_transcript_segments(meeting_id)
                )
        except AttributeError:
            fragment_segments = []

        transcript_rows: list[Transcript] = []
        if not transcript_scope.is_v2:
            transcript_rows = (
                db.query(Transcript)
                .filter(Transcript.meeting_id == meeting_id)
                .order_by(Transcript.start_time.asc(), Transcript.id.asc())
                .all()
            )

        if fragment_segments:
            raw_segments = [
                _segment_from_mapping(segment)
                for segment in fragment_segments
                if str(segment.get("text") or "").strip()
            ]
            raw_source = (
                "transcript_fragments_attempt_visible"
                if transcript_scope.is_v2
                else "transcript_fragments_visible"
            )
        else:
            raw_segments = [
                _segment_from_model(row)
                for row in transcript_rows
                if str(getattr(row, "text", None) or "").strip()
            ]
            raw_source = "transcripts"

        canonical_payload = None
        if not transcript_scope.is_v2:
            canonical_payload = _resolve_canonical_sidecar(
                transcript_rows, raw_segments
            )
        if canonical_payload is not None:
            (
                canonical_segments,
                canonical_version,
                canonical_hash,
                canonical_generated_at,
            ) = canonical_payload
            logger.info(
                "STT_TRANSCRIPT_GET meeting_id={} source={} rows={}",
                meeting_id,
                "canonical_transcript_sidecar",
                len(canonical_segments),
            )
            return TranscriptResponse(
                meeting_id=meeting_id,
                transcripts=canonical_segments,
                transcriptMode="canonical",
                canonicalTranscriptVersion=canonical_version,
                canonicalTranscriptHash=canonical_hash,
                canonicalGeneratedAt=canonical_generated_at,
                rawTranscripts=raw_segments or None,
            )

        if raw_segments:
            logger.info(
                "STT_TRANSCRIPT_GET meeting_id={} source={} rows={}",
                meeting_id,
                raw_source,
                len(raw_segments),
            )
            return TranscriptResponse(
                meeting_id=meeting_id,
                transcripts=raw_segments,
                transcriptMode="raw",
            )

        logger.info(
            "STT_TRANSCRIPT_GET meeting_id={} source={} rows={} scope={}",
            meeting_id,
            "none",
            0,
            "v2" if transcript_scope.is_v2 else "legacy",
        )
        raise HTTPException(
            status_code=404,
            detail="No transcript found for meeting; no speech was detected or no transcript fragments were persisted",
        )

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


@app.get("/api/meeting/{meeting_id}/transcript-scopes")
async def list_transcript_scopes(meeting_id: int, db: Session = Depends(get_db)):
    try:
        repository = TranscriptPersistenceRepository(db)
        scopes = repository.list_attempt_scopes(meeting_id)
        return {
            "meeting_id": meeting_id,
            "scopes": scopes,
        }
    except Exception as e:
        request_id = uuid4().hex
        logger.error(
            "event=REQUEST_FAILED requestId={} path=/api/meeting/{}/transcript-scopes errorCode={} error={}",
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
async def get_analysis(
    meeting_id: int,
    db: Session = Depends(get_db),
    recording_session_id: int | None = Query(default=None),
    attempt_id: int | None = Query(default=None),
):
    """
    Get AI analysis for a meeting

    Returns summary, keywords, technical terms, and action items
    """
    try:
        provenance = validate_transcript_provenance(recording_session_id, attempt_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "errorCode": "INVALID_PROVENANCE",
                "message": str(exc),
            },
        ) from exc

    try:
        logger.info(
            "Fetching analysis for meeting %s scope=%s",
            meeting_id,
            "legacy" if provenance.recording_session_id is None else "v2",
        )

        if provenance.recording_session_id is not None:
            scoped_run = latest_completed_analysis_run(
                db,
                meeting_id,
                provenance.recording_session_id,
                provenance.attempt_id,
            )
            if scoped_run is None:
                return AnalysisResponse(
                    meeting_id=meeting_id,
                    summary="",
                    keywords=[],
                    technical_terms=[],
                    action_items=[],
                    status="NOT_FOUND",
                    analysisStatus=ANALYSIS_STATUS_UNAVAILABLE_FOR_SCOPE,
                    created_at=datetime.now(timezone.utc),
                )
            normalized = analysis_payload_from_run(scoped_run, cache_hit=True)
            run_metadata = analysis_run_response_metadata(scoped_run, cache_hit=True)
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
                promptVersion=run_metadata.get("promptVersion")
                or normalized["promptVersion"],
                schemaVersion=run_metadata.get("schemaVersion")
                or normalized["schemaVersion"],
                analysisFeatureSet=run_metadata.get("analysisFeatureSet")
                or normalized["analysisFeatureSet"],
                groupedActionPlan=normalized.get("groupedActionPlan"),
                created_at=scoped_run.completed_at or datetime.now(timezone.utc),
                technicalTerms=technical_terms,
                painPoints=pain_points,
                actionItems=normalized["actionItems"],
                domainMode=normalized["domainMode"],
                status="COMPLETED",
                source=normalized.get("source") or "analysis_run",
                transcript_hash=normalized.get("transcript_hash"),
                analysisStatus=run_metadata.get("analysisStatus") or "COMPLETED",
                cacheHit=normalized.get("cacheHit"),
                provider=run_metadata.get("provider"),
                model=run_metadata.get("model"),
                canonicalTranscriptHash=run_metadata.get("canonicalTranscriptHash"),
                canonicalTranscriptVersion=run_metadata.get(
                    "canonicalTranscriptVersion"
                ),
                analysisInputMode=run_metadata.get("analysisInputMode"),
                lastAnalyzedAt=run_metadata.get("lastAnalyzedAt"),
                stale=run_metadata.get("stale") or normalized.get("stale"),
                staleReason=run_metadata.get("staleReason")
                or normalized.get("staleReason"),
                retryAfterSeconds=normalized.get("retryAfterSeconds"),
                educationStudy=normalized.get("educationStudy"),
                evidenceUnavailable=normalized.get("evidenceUnavailable"),
            )

        job_state = get_job_status(meeting_id)
        job_analysis = _extract_analysis_from_job_state(job_state)
        if job_analysis:
            normalized = _normalize_analysis_payload(job_analysis)
            run_metadata = analysis_run_response_metadata(
                latest_completed_analysis_run(db, meeting_id)
            )
            job_status = (
                str(job_state.get("status") or "COMPLETED")
                if isinstance(job_state, dict)
                else "COMPLETED"
            )
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
                promptVersion=run_metadata.get("promptVersion")
                or normalized["promptVersion"],
                schemaVersion=run_metadata.get("schemaVersion")
                or normalized["schemaVersion"],
                analysisFeatureSet=run_metadata.get("analysisFeatureSet")
                or normalized["analysisFeatureSet"],
                groupedActionPlan=normalized.get("groupedActionPlan"),
                created_at=datetime.now(timezone.utc),
                technicalTerms=technical_terms,
                painPoints=pain_points,
                actionItems=normalized["actionItems"],
                domainMode=normalized["domainMode"],
                status=job_status,
                source=normalized["source"] or "job_state",
                transcript_hash=normalized["transcript_hash"],
                analysisStatus=run_metadata.get("analysisStatus") or job_status,
                cacheHit=normalized.get("cacheHit"),
                provider=run_metadata.get("provider"),
                model=run_metadata.get("model"),
                canonicalTranscriptHash=run_metadata.get("canonicalTranscriptHash"),
                canonicalTranscriptVersion=run_metadata.get(
                    "canonicalTranscriptVersion"
                ),
                analysisInputMode=run_metadata.get("analysisInputMode"),
                lastAnalyzedAt=run_metadata.get("lastAnalyzedAt"),
                stale=run_metadata.get("stale") or normalized.get("stale"),
                staleReason=run_metadata.get("staleReason")
                or normalized.get("staleReason"),
                retryAfterSeconds=normalized.get("retryAfterSeconds"),
                educationStudy=normalized.get("educationStudy"),
                evidenceUnavailable=normalized.get("evidenceUnavailable"),
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
        run_metadata = analysis_run_response_metadata(
            latest_completed_analysis_run(db, meeting_id)
        )
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
            promptVersion=run_metadata.get("promptVersion")
            or normalized["promptVersion"],
            schemaVersion=run_metadata.get("schemaVersion")
            or normalized["schemaVersion"],
            analysisFeatureSet=run_metadata.get("analysisFeatureSet")
            or normalized["analysisFeatureSet"],
            groupedActionPlan=normalized.get("groupedActionPlan"),
            created_at=analysis.created_at or datetime.now(timezone.utc),
            technicalTerms=technical_terms,
            painPoints=pain_points,
            actionItems=normalized["actionItems"],
            domainMode=normalized["domainMode"],
            status="COMPLETED",
            source=normalized["source"] or "database",
            transcript_hash=normalized["transcript_hash"],
            analysisStatus=run_metadata.get("analysisStatus") or "COMPLETED",
            cacheHit=normalized.get("cacheHit"),
            provider=run_metadata.get("provider"),
            model=run_metadata.get("model"),
            canonicalTranscriptHash=run_metadata.get("canonicalTranscriptHash"),
            canonicalTranscriptVersion=run_metadata.get("canonicalTranscriptVersion"),
            analysisInputMode=run_metadata.get("analysisInputMode"),
            lastAnalyzedAt=run_metadata.get("lastAnalyzedAt"),
            stale=run_metadata.get("stale") or normalized.get("stale"),
            staleReason=run_metadata.get("staleReason")
            or normalized.get("staleReason"),
            retryAfterSeconds=normalized.get("retryAfterSeconds"),
            educationStudy=normalized.get("educationStudy"),
            evidenceUnavailable=normalized.get("evidenceUnavailable"),
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


def _meeting_transcript_text_for_analysis(
    db: Session,
    meeting_id: int,
    *,
    recording_session_id: int | None = None,
    attempt_id: int | None = None,
) -> str:
    provenance = validate_transcript_provenance(recording_session_id, attempt_id)
    repository = TranscriptPersistenceRepository(db)

    if provenance.is_v2:
        scoped_text = repository.assemble_attempt_transcript_text(
            meeting_id,
            recording_session_id=provenance.recording_session_id,
            attempt_id=provenance.attempt_id,
        )
        if scoped_text.strip():
            segments = repository.assemble_attempt_visible_transcript_segments(
                meeting_id,
                recording_session_id=provenance.recording_session_id,
                attempt_id=provenance.attempt_id,
            )
            labeled: list[str] = []
            for row in sorted(
                segments,
                key=lambda item: (
                    float(item.get("start_time") or 0.0),
                    int(item.get("seq") or 0),
                ),
            ):
                text = str(row.get("text") or "").strip()
                if not text:
                    continue
                speaker = str(row.get("speaker") or "SPEAKER_1").strip() or "SPEAKER_1"
                labeled.append(f"{speaker}: {text}")
            if labeled:
                return "\n".join(labeled)

    latest_canonical = (
        db.query(Transcript)
        .filter(
            Transcript.meeting_id == meeting_id,
            Transcript.canonical_transcript_rows.isnot(None),
        )
        .order_by(Transcript.id.desc())
        .first()
    )
    if latest_canonical and isinstance(
        latest_canonical.canonical_transcript_rows, list
    ):
        canonical_lines = []
        for row in latest_canonical.canonical_transcript_rows:
            if not isinstance(row, dict):
                continue
            text = str(row.get("text") or "").strip()
            if not text:
                continue
            speaker = str(row.get("speaker") or "SPEAKER_1").strip() or "SPEAKER_1"
            canonical_lines.append(f"{speaker}: {text}")
        if canonical_lines:
            return "\n".join(canonical_lines)

    rows = (
        db.query(Transcript)
        .filter(Transcript.meeting_id == meeting_id)
        .order_by(Transcript.start_time.asc(), Transcript.id.asc())
        .all()
    )
    lines = []
    for row in rows:
        text = str(row.text or "").strip()
        if not text:
            continue
        speaker = str(row.speaker or "SPEAKER_1").strip() or "SPEAKER_1"
        lines.append(f"{speaker}: {text}")
    if lines:
        return "\n".join(lines).strip()

    # Realtime meetings may only have v2 fragments (no rows in transcripts yet).
    # Older deployments do not expose the aggregate helper, so retain the
    # empty-transcript behavior until the transcript persistence change lands.
    assemble_realtime = getattr(
        repository, "assemble_meeting_analysis_transcript_text", None
    )
    if callable(assemble_realtime):
        return str(assemble_realtime(meeting_id) or "")
    return ""


def _load_structured_fragments_for_education(
    db: Session,
    meeting_id: int,
    *,
    recording_session_id: int | None = None,
    attempt_id: int | None = None,
) -> list[dict[str, Any]]:
    """Load attempt-scoped (v2) or legacy visible fragments for education evidence."""
    provenance = validate_transcript_provenance(recording_session_id, attempt_id)
    repository = TranscriptPersistenceRepository(db)
    if provenance.is_v2:
        raw_segments = repository.assemble_attempt_visible_transcript_segments(
            meeting_id,
            recording_session_id=provenance.recording_session_id,
            attempt_id=provenance.attempt_id,
        )
    else:
        raw_segments = repository.assemble_meeting_visible_transcript_segments(
            meeting_id
        )

    segments: list[dict[str, Any]] = []
    for row in raw_segments:
        text = str(row.get("text") or "").strip()
        if not text:
            continue
        speaker = str(row.get("speaker") or "SPEAKER_1").strip() or "SPEAKER_1"
        start_time = float(row.get("start_time") or row.get("start") or 0.0)
        end_time = float(row.get("end_time") or row.get("end") or start_time)
        segment_id = resolve_segment_id_for_read(
            meeting_id=meeting_id,
            speaker=speaker,
            start_time=start_time,
            explicit_segment_id=row.get("segment_id") or row.get("event_id"),
        )
        segments.append(
            {
                "segment_id": segment_id,
                "event_id": segment_id,
                "speaker": speaker,
                "start": start_time,
                "start_time": start_time,
                "end": end_time,
                "text": text,
            }
        )
    return segments


def _resolve_education_realtime_transcript_input(
    *,
    db: Session,
    meeting_id: int,
    plain_transcript: str,
    recording_session_id: int | None = None,
    attempt_id: int | None = None,
) -> tuple[str, list[str], bool]:
    """Return transcript text, allowed segment ids, evidence_unavailable."""
    fragments = _load_structured_fragments_for_education(
        db,
        meeting_id,
        recording_session_id=recording_session_id,
        attempt_id=attempt_id,
    )
    allowed = sorted(collect_allowed_segment_ids(fragments))
    if allowed:
        return format_aligned_transcript_for_analysis(fragments), allowed, False
    return plain_transcript, [], True


@app.post("/api/meeting/{meeting_id}/analysis/rerun", response_model=AnalysisResponse)
async def rerun_analysis(
    meeting_id: int,
    request: AnalysisRerunRequest,
    db: Session = Depends(get_db),
):
    supplied_transcript = _normalize_transcript_text(request.transcript)
    transcript_text = supplied_transcript or _meeting_transcript_text_for_analysis(
        db, meeting_id
    )
    if not transcript_text:
        raise HTTPException(
            status_code=404,
            detail="Cannot re-analyze because saved transcript was not found.",
        )

    mode = normalize_analysis_mode(request.mode or ANALYSIS_MODE_FORCE)
    transcript_hash = (request.canonical_transcript_hash or "").strip() or (
        request.transcript_hash or ""
    ).strip()
    realtime_response = await analyze_realtime_transcript(
        RealtimeTranscriptAnalysisRequest(
            meeting_id=meeting_id,
            transcript=transcript_text,
            source="rerun",
            transcript_hash=_compute_transcript_hash(transcript_text, transcript_hash),
            prompt_version=request.prompt_version,
            schema_version=request.schema_version,
            analysis_feature_set=request.analysis_feature_set,
            mode=mode,
            reason=request.reason,
            domain_mode=request.domain_mode,
            owner_user_id=request.owner_user_id,
            reanalysis_generation=request.reanalysis_generation,
        ),
        db,
    )
    if realtime_response.status == "completed":
        return await get_analysis(meeting_id, db)

    return AnalysisResponse(
        meeting_id=meeting_id,
        summary="",
        meetingSummary="",
        keywords=[],
        technical_terms=[],
        action_items=[],
        created_at=datetime.now(timezone.utc),
        status=realtime_response.status,
        source=realtime_response.source,
        transcript_hash=realtime_response.transcript_hash,
        promptVersion=realtime_response.promptVersion,
        schemaVersion=realtime_response.schemaVersion,
        analysisFeatureSet=realtime_response.analysisFeatureSet,
        analysisStatus=realtime_response.analysisStatus,
        cacheHit=realtime_response.cacheHit,
        provider=realtime_response.provider,
        model=realtime_response.model,
        canonicalTranscriptHash=realtime_response.canonicalTranscriptHash,
        canonicalTranscriptVersion=realtime_response.canonicalTranscriptVersion,
        analysisInputMode=realtime_response.analysisInputMode,
        lastAnalyzedAt=realtime_response.lastAnalyzedAt,
        stale=realtime_response.stale,
        staleReason=realtime_response.staleReason,
        retryAfterSeconds=realtime_response.retryAfterSeconds,
    )


@app.post("/api/meeting/{meeting_id}/chat")
async def meeting_chat(
    meeting_id: int,
    payload: dict = Body(...),
):
    settings = get_settings()
    question = str(payload.get("question") or "").strip()
    summary = str(payload.get("summary") or "")
    transcript_excerpt = str(payload.get("transcript_excerpt") or "")
    analysis = (
        payload.get("analysis") if isinstance(payload.get("analysis"), dict) else {}
    )
    source_segments = (
        payload.get("source_segments")
        if isinstance(payload.get("source_segments"), list)
        else []
    )
    from app.services.meeting_chat_service import answer_meeting_question

    cost_guard_redis = None
    if settings.gemini_cost_guard_enabled:
        try:
            cost_guard_redis = _get_client()
        except Exception as redis_error:
            logger.warning(
                "GEMINI_COST_GUARD_UNAVAILABLE workload=chat error_type={} fail_closed=true",
                type(redis_error).__name__,
            )

    result = answer_meeting_question(
        settings=settings,
        question=question,
        summary=summary,
        transcript_excerpt=transcript_excerpt,
        analysis=analysis,
        source_segments=source_segments,
        redis_client=cost_guard_redis,
        meeting_id=meeting_id,
        owner_user_id=payload.get("owner_user_id"),
    )
    return {
        "meetingId": meeting_id,
        "answer": result.get("answer", ""),
        "provider": result.get("provider", "unknown"),
        "source_segments": result.get("source_segments", source_segments),
        "errorCode": result.get("error_code"),
    }


@app.post("/api/search/semantic-rerank")
async def semantic_rerank_endpoint(payload: dict = Body(...)):
    settings = get_settings()
    query = str(payload.get("query") or "").strip()
    candidates = (
        payload.get("candidates") if isinstance(payload.get("candidates"), list) else []
    )
    from app.services.semantic_search_service import semantic_rerank_meetings

    cost_guard_redis = None
    if settings.gemini_cost_guard_enabled:
        try:
            cost_guard_redis = _get_client()
        except Exception as redis_error:
            logger.warning(
                "GEMINI_COST_GUARD_UNAVAILABLE workload=semantic_rerank error_type={} fail_closed=true",
                type(redis_error).__name__,
            )
    result = semantic_rerank_meetings(
        settings=settings,
        query=query,
        candidates=candidates,
        redis_client=cost_guard_redis,
        owner_user_id=payload.get("owner_user_id"),
    )
    return result


@app.post("/api/search/cross-meeting/ask")
async def cross_meeting_ask_endpoint(payload: dict = Body(...)):
    settings = get_settings()
    question = str(payload.get("question") or "").strip()
    meetings = (
        payload.get("meetings") if isinstance(payload.get("meetings"), list) else []
    )
    from app.services.semantic_search_service import ask_cross_meeting

    cost_guard_redis = None
    if settings.gemini_cost_guard_enabled:
        try:
            cost_guard_redis = _get_client()
        except Exception as redis_error:
            logger.warning(
                "GEMINI_COST_GUARD_UNAVAILABLE workload=cross_meeting error_type={} fail_closed=true",
                type(redis_error).__name__,
            )
    return ask_cross_meeting(
        settings=settings,
        question=question,
        meetings=meetings,
        redis_client=cost_guard_redis,
        owner_user_id=payload.get("owner_user_id"),
    )


@app.post("/api/meeting/{meeting_id}/terms/explain")
async def explain_meeting_term_endpoint(
    meeting_id: int,
    payload: dict = Body(...),
):
    settings = get_settings()
    term = str(payload.get("term") or "").strip()
    summary = str(payload.get("summary") or "")
    transcript_excerpt = str(payload.get("transcript_excerpt") or "")
    analysis = (
        payload.get("analysis") if isinstance(payload.get("analysis"), dict) else {}
    )
    from app.services.meeting_chat_service import explain_meeting_term

    cost_guard_redis = None
    if settings.gemini_cost_guard_enabled:
        try:
            cost_guard_redis = _get_client()
        except Exception as redis_error:
            logger.warning(
                "GEMINI_COST_GUARD_UNAVAILABLE workload=term_explain error_type={} fail_closed=true",
                type(redis_error).__name__,
            )
    result = explain_meeting_term(
        settings=settings,
        term=term,
        summary=summary,
        transcript_excerpt=transcript_excerpt,
        analysis=analysis,
        redis_client=cost_guard_redis,
        meeting_id=meeting_id,
        owner_user_id=payload.get("owner_user_id"),
    )
    return {
        "meetingId": meeting_id,
        "term": result.get("term", term),
        "explanation": result.get("explanation", ""),
        "provider": result.get("provider", "unknown"),
        "errorCode": result.get("error_code"),
    }


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
        provenance = validate_transcript_provenance(
            request.recording_session_id,
            request.attempt_id,
        )
        source = str(request.source or "realtime").strip().lower() or "realtime"
        analysis_trace_id = uuid4().hex[:12]
        transcript_text = _normalize_transcript_text(request.transcript or "")
        if not transcript_text:
            transcript_text = _normalize_transcript_text(
                _meeting_transcript_text_for_analysis(
                    db,
                    meeting_id,
                    recording_session_id=request.recording_session_id,
                    attempt_id=request.attempt_id,
                )
            )
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
        mode = normalize_analysis_mode(request.mode)
        reanalysis_generation = (
            max(1, int(request.reanalysis_generation or 1))
            if mode == ANALYSIS_MODE_FORCE
            else 0
        )
        analyzer = (
            _analysis_cache_metadata_analyzer()
            if mode == ANALYSIS_MODE_CACHE_ONLY
            else _get_realtime_analysis_analyzer()
        )
        default_domain = (
            getattr(analyzer, "analysis_domain_mode", "it") if analyzer else "it"
        )
        requested_prompt_version = str(request.prompt_version or "").strip()
        requested_schema_version = str(request.schema_version or "").strip()
        override_payload: dict[str, Any] = {}
        if requested_prompt_version:
            override_payload["promptVersion"] = _normalize_analysis_version(
                request.prompt_version, AIAnalyzer.PROMPT_VERSION
            )
        if requested_schema_version:
            override_payload["schemaVersion"] = _normalize_analysis_version(
                request.schema_version, AIAnalyzer.SCHEMA_VERSION
            )
        if request.analysis_feature_set:
            override_payload["analysisFeatureSet"] = _normalize_analysis_feature_set(
                request.analysis_feature_set
            )
        normalized_domain, domain_payload = merge_domain_analysis_payload(
            request.domain_mode,
            override_payload,
            default_domain=default_domain,
        )
        education_allowed_segment_ids: list[str] = []
        education_evidence_unavailable = False
        if normalized_domain == "education":
            (
                transcript_text,
                education_allowed_segment_ids,
                education_evidence_unavailable,
            ) = _resolve_education_realtime_transcript_input(
                db=db,
                meeting_id=meeting_id,
                plain_transcript=transcript_text,
                recording_session_id=provenance.recording_session_id,
                attempt_id=provenance.attempt_id,
            )
            transcript_hash = _compute_transcript_hash(transcript_text, None)
            if education_evidence_unavailable:
                logger.info(
                    "event=EDUCATION_EVIDENCE_UNAVAILABLE meetingId={} source={} reason=plain_transcript",
                    meeting_id,
                    source,
                )
        prompt_version = str(domain_payload["promptVersion"])
        schema_version = str(domain_payload["schemaVersion"])
        analysis_feature_set = str(domain_payload["analysisFeatureSet"])
        if (
            prompt_version == "gemini-business-v1"
            or schema_version == "gemini-business-v1"
        ):
            logger.info(
                "event=ANALYSIS_VERSION_DOWNGRADE_BLOCKED meetingId={} source={} requestedPromptVersion={} requestedSchemaVersion={} selectedPromptVersion={} selectedSchemaVersion={}",
                meeting_id,
                source,
                requested_prompt_version,
                requested_schema_version,
                AIAnalyzer.PROMPT_VERSION,
                AIAnalyzer.SCHEMA_VERSION,
            )
            prompt_version = AIAnalyzer.PROMPT_VERSION
            schema_version = AIAnalyzer.SCHEMA_VERSION
            domain_payload["promptVersion"] = prompt_version
            domain_payload["schemaVersion"] = schema_version
        logger.info(
            "event=ANALYSIS_VERSION_SELECTED meetingId={} source={} requestedPromptVersion={} requestedSchemaVersion={} selectedPromptVersion={} selectedSchemaVersion={} reason={}",
            meeting_id,
            source,
            requested_prompt_version,
            requested_schema_version,
            prompt_version,
            schema_version,
            (
                "canonical_default"
                if not requested_prompt_version and not requested_schema_version
                else "request_allowed"
            ),
        )
        analysis_cache_key = _analysis_cache_key(
            transcript_hash, prompt_version, schema_version, analysis_feature_set
        )
        quality_verdict = evaluate_transcript_quality(
            transcript_text,
            enabled=settings.analysis_short_transcript_gate_enabled,
        )
        if not quality_verdict.should_analyze:
            logger.info(
                "ANALYSIS_SKIPPED_SHORT_TRANSCRIPT meetingId={} normalizedChars={} wordCount={} skipReason={}",
                meeting_id,
                quality_verdict.normalized_chars,
                quality_verdict.word_count,
                quality_verdict.skip_reason,
            )
            skipped_run = None
            if analyzer is not None:
                cache_identity = build_analysis_cache_identity(
                    db=db,
                    meeting_id=meeting_id,
                    analyzer=analyzer,
                    fallback_transcript_hash=transcript_hash,
                    fallback_text=transcript_text,
                    analysis_payload=domain_payload,
                    recording_session_id=provenance.recording_session_id,
                    attempt_id=provenance.attempt_id,
                    normalized_domain_mode=normalized_domain,
                )
                skipped_run, _ = begin_analysis_run(
                    db=db,
                    identity=cache_identity,
                    mode=mode,
                    requested_by=source,
                    rerun_reason=request.reason,
                    reanalysis_generation=reanalysis_generation,
                )
                mark_analysis_run_skipped_short(
                    run=skipped_run,
                    error_code=quality_verdict.skip_reason
                    or "ANALYSIS_SKIPPED_SHORT_TRANSCRIPT",
                    error_message="Transcript too short for analysis",
                    analysis_input_hash=transcript_hash,
                )
                db.commit()
            skip_metadata = analysis_run_response_metadata(skipped_run, cache_hit=False)
            return RealtimeTranscriptAnalysisResponse(
                meeting_id=meeting_id,
                status="skipped",
                reason="short_transcript",
                transcript_hash=transcript_hash,
                source=source,
                promptVersion=prompt_version,
                schemaVersion=schema_version,
                analysisFeatureSet=analysis_feature_set,
                analysisStatus=skip_metadata.get("analysisStatus") or "NO_ANALYSIS",
                errorCode=quality_verdict.skip_reason
                or "ANALYSIS_SKIPPED_SHORT_TRANSCRIPT",
                cacheHit=False,
                provider=skip_metadata.get("provider"),
                model=skip_metadata.get("model"),
                canonicalTranscriptHash=skip_metadata.get("canonicalTranscriptHash"),
                canonicalTranscriptVersion=skip_metadata.get(
                    "canonicalTranscriptVersion"
                ),
                analysisInputMode=skip_metadata.get("analysisInputMode"),
            )
        cache_identity = None
        active_analysis_run = None
        if analyzer is None and mode == ANALYSIS_MODE_CACHE_ONLY:
            return RealtimeTranscriptAnalysisResponse(
                meeting_id=meeting_id,
                status="no_analysis",
                transcript_hash=transcript_hash,
                source=source,
                promptVersion=prompt_version,
                schemaVersion=schema_version,
                analysisFeatureSet=analysis_feature_set,
                analysisStatus="NO_ANALYSIS",
                cacheHit=False,
                stale=False,
                staleReason=None,
            )
        if analyzer is not None:
            cache_identity = build_analysis_cache_identity(
                db=db,
                meeting_id=meeting_id,
                analyzer=analyzer,
                fallback_transcript_hash=transcript_hash,
                fallback_text=transcript_text,
                analysis_payload=domain_payload,
                recording_session_id=provenance.recording_session_id,
                attempt_id=provenance.attempt_id,
                normalized_domain_mode=normalized_domain,
            )
            analysis_cache_key = build_analysis_run_idempotency_key_for_identity(
                cache_identity
            )
            if mode == ANALYSIS_MODE_FORCE:
                analysis_cache_key = (
                    f"{analysis_cache_key}:force:{reanalysis_generation}"
                )
            cached_analysis_run = (
                None
                if mode == ANALYSIS_MODE_FORCE
                else find_completed_analysis_run_for_identity(db, cache_identity)
            )
            if cached_analysis_run is not None:
                logger.info(
                    "ANALYSIS_CACHE_HIT meetingId={} provider={} model={} promptVersion={} schemaVersion={} canonicalTranscriptHash={} canonicalTranscriptVersion={} analysisInputMode={}",
                    meeting_id,
                    cache_identity.provider,
                    cache_identity.model,
                    cache_identity.prompt_version,
                    cache_identity.schema_version,
                    cache_identity.canonical_transcript_hash,
                    cache_identity.canonical_transcript_version,
                    cache_identity.analysis_input_mode,
                )
                gemini_metrics.cache_hit()
                cached_analysis = analysis_payload_from_run(
                    cached_analysis_run, cache_hit=True
                )
                cached_analysis["transcriptHash"] = (
                    cached_analysis.get("transcriptHash") or transcript_hash
                )
                cached_analysis["transcript_hash"] = (
                    cached_analysis.get("transcript_hash") or transcript_hash
                )
                cached_analysis["promptVersion"] = (
                    cached_analysis.get("promptVersion") or prompt_version
                )
                cached_analysis["schemaVersion"] = (
                    cached_analysis.get("schemaVersion") or schema_version
                )
                cached_analysis["analysisFeatureSet"] = (
                    cached_analysis.get("analysisFeatureSet") or analysis_feature_set
                )
                cached_analysis["source"] = cached_analysis.get("source") or source
                job_state_analysis = dict(cached_analysis)
                last_analyzed_at = job_state_analysis.get("lastAnalyzedAt")
                if isinstance(last_analyzed_at, datetime):
                    job_state_analysis["lastAnalyzedAt"] = last_analyzed_at.isoformat()
                set_job_status(
                    meeting_id=meeting_id,
                    status="COMPLETED",
                    result=build_completed_analysis_job_result(
                        meeting_id=meeting_id,
                        analysis=job_state_analysis,
                        source=source,
                        domain_mode=normalized_domain,
                        recording_session_id=provenance.recording_session_id,
                        attempt_id=provenance.attempt_id,
                    ),
                    stage="completed",
                    progress=100,
                )
                analysis_cache_key = _analysis_cache_key(
                    transcript_hash,
                    prompt_version,
                    schema_version,
                    analysis_feature_set,
                )
                with _realtime_analysis_guard_lock:
                    _realtime_analysis_completed_hash[meeting_id] = (
                        analysis_cache_key,
                        time.time(),
                    )
                return RealtimeTranscriptAnalysisResponse(
                    meeting_id=meeting_id,
                    status="completed",
                    analysis=cached_analysis,
                    transcript_hash=transcript_hash,
                    source=source,
                    promptVersion=cached_analysis.get("promptVersion"),
                    schemaVersion=cached_analysis.get("schemaVersion"),
                    analysisFeatureSet=cached_analysis.get("analysisFeatureSet"),
                    analysisStatus=cached_analysis.get("analysisStatus"),
                    cacheHit=True,
                    provider=cached_analysis.get("provider"),
                    model=cached_analysis.get("model"),
                    canonicalTranscriptHash=cached_analysis.get(
                        "canonicalTranscriptHash"
                    ),
                    canonicalTranscriptVersion=cached_analysis.get(
                        "canonicalTranscriptVersion"
                    ),
                    analysisInputMode=cached_analysis.get("analysisInputMode"),
                    lastAnalyzedAt=cached_analysis.get("lastAnalyzedAt"),
                    stale=cached_analysis.get("stale"),
                    staleReason=cached_analysis.get("staleReason"),
                )

            in_progress_run = find_in_progress_analysis_run_for_identity(
                db, cache_identity
            )
            if in_progress_run is not None:
                run_metadata = analysis_run_response_metadata(
                    in_progress_run, cache_hit=False
                )
                return RealtimeTranscriptAnalysisResponse(
                    meeting_id=meeting_id,
                    status="skipped",
                    reason="in_progress",
                    transcript_hash=transcript_hash,
                    source=source,
                    promptVersion=prompt_version,
                    schemaVersion=schema_version,
                    analysisFeatureSet=analysis_feature_set,
                    retryAfterSeconds=1,
                    analysisStatus=run_metadata.get("analysisStatus"),
                    cacheHit=False,
                    provider=run_metadata.get("provider"),
                    model=run_metadata.get("model"),
                    canonicalTranscriptHash=run_metadata.get("canonicalTranscriptHash"),
                    canonicalTranscriptVersion=run_metadata.get(
                        "canonicalTranscriptVersion"
                    ),
                    analysisInputMode=run_metadata.get("analysisInputMode"),
                    lastAnalyzedAt=run_metadata.get("lastAnalyzedAt"),
                    stale=run_metadata.get("stale"),
                    staleReason=run_metadata.get("staleReason"),
                )

            if mode == ANALYSIS_MODE_CACHE_ONLY:
                miss_metadata = analysis_miss_response_metadata(db, cache_identity)
                return RealtimeTranscriptAnalysisResponse(
                    meeting_id=meeting_id,
                    status=str(
                        miss_metadata.get("analysisStatus") or "NO_ANALYSIS"
                    ).lower(),
                    transcript_hash=transcript_hash,
                    source=source,
                    promptVersion=prompt_version,
                    schemaVersion=schema_version,
                    analysisFeatureSet=analysis_feature_set,
                    analysisStatus=miss_metadata.get("analysisStatus"),
                    cacheHit=False,
                    provider=miss_metadata.get("provider"),
                    model=miss_metadata.get("model"),
                    canonicalTranscriptHash=miss_metadata.get(
                        "canonicalTranscriptHash"
                    ),
                    canonicalTranscriptVersion=miss_metadata.get(
                        "canonicalTranscriptVersion"
                    ),
                    analysisInputMode=miss_metadata.get("analysisInputMode"),
                    lastAnalyzedAt=miss_metadata.get("lastAnalyzedAt"),
                    stale=miss_metadata.get("stale"),
                    staleReason=miss_metadata.get("staleReason"),
                )

            if mode == ANALYSIS_MODE_FAILED_RETRY:
                retry_run = find_latest_analysis_run_for_identity(db, cache_identity)
                if retry_run is not None and not is_analysis_run_retryable(retry_run):
                    # Completed/skipped/in-progress for this identity: do not re-run.
                    miss_metadata = analysis_miss_response_metadata(db, cache_identity)
                    return RealtimeTranscriptAnalysisResponse(
                        meeting_id=meeting_id,
                        status=str(
                            miss_metadata.get("analysisStatus") or "NO_ANALYSIS"
                        ).lower(),
                        transcript_hash=transcript_hash,
                        source=source,
                        promptVersion=prompt_version,
                        schemaVersion=schema_version,
                        analysisFeatureSet=analysis_feature_set,
                        analysisStatus=miss_metadata.get("analysisStatus"),
                        cacheHit=False,
                        provider=miss_metadata.get("provider"),
                        model=miss_metadata.get("model"),
                        canonicalTranscriptHash=miss_metadata.get(
                            "canonicalTranscriptHash"
                        ),
                        canonicalTranscriptVersion=miss_metadata.get(
                            "canonicalTranscriptVersion"
                        ),
                        analysisInputMode=miss_metadata.get("analysisInputMode"),
                        lastAnalyzedAt=miss_metadata.get("lastAnalyzedAt"),
                        stale=miss_metadata.get("stale"),
                        staleReason=miss_metadata.get("staleReason"),
                    )
                # retry_run is None (never analyzed for this scope) OR retryable
                # failure → fall through to normal analysis. This recovers meetings
                # that previously only hit EMPTY_TRANSCRIPT before a run existed.

            logger.info(
                "ANALYSIS_CACHE_MISS meetingId={} provider={} model={} promptVersion={} schemaVersion={} canonicalTranscriptHash={} canonicalTranscriptVersion={} analysisInputMode={}",
                meeting_id,
                cache_identity.provider,
                cache_identity.model,
                cache_identity.prompt_version,
                cache_identity.schema_version,
                cache_identity.canonical_transcript_hash,
                cache_identity.canonical_transcript_version,
                cache_identity.analysis_input_mode,
            )

        analysis_attempt = 1
        if cache_identity is not None:
            latest_run = find_latest_analysis_run_for_identity(db, cache_identity)
            if latest_run is not None:
                analysis_attempt = (
                    int(getattr(latest_run, "analysis_retry_count", 0) or 0) + 1
                )

        cost_guard = None
        cost_reservation = None
        if (
            settings.gemini_cost_guard_enabled
            and analyzer is not None
            and getattr(analyzer, "provider", "") == "gemini"
        ):
            try:
                cost_guard_redis = _get_client()
            except Exception as redis_error:
                logger.warning(
                    "GEMINI_COST_GUARD_UNAVAILABLE error_type={} fail_closed=true",
                    type(redis_error).__name__,
                )
                gemini_metrics.failure("GEMINI_COST_GUARD_UNAVAILABLE")
                return RealtimeTranscriptAnalysisResponse(
                    meeting_id=meeting_id,
                    status="failed",
                    reason="guard_unavailable",
                    transcript_hash=transcript_hash,
                    source=source,
                    promptVersion=prompt_version,
                    schemaVersion=schema_version,
                    analysisFeatureSet=analysis_feature_set,
                    errorCode="GEMINI_COST_GUARD_UNAVAILABLE",
                    retryable=False,
                )
            cost_guard = GeminiCostGuard(
                cost_guard_redis,
                namespace=settings.gemini_cost_guard_namespace,
                daily_request_limit_per_user=(
                    settings.gemini_daily_request_limit_per_user
                ),
                daily_reanalysis_limit_per_meeting=(
                    settings.gemini_daily_reanalyze_limit_per_meeting
                ),
                daily_token_limit_per_user=settings.gemini_daily_token_limit_per_user,
                max_concurrent_requests=settings.gemini_max_concurrent_requests,
            )
            cost_reservation = cost_guard.reserve(
                user_id=request.owner_user_id or "internal-default",
                meeting_id=meeting_id,
                operation_id=analysis_cache_key,
                estimated_tokens=(
                    estimate_text_tokens(transcript_text)
                    + settings.gemini_structured_analysis_max_output_tokens
                ),
                is_reanalysis=mode == ANALYSIS_MODE_FORCE,
            )
            if not cost_reservation.allowed:
                if cost_reservation.duplicate:
                    gemini_metrics.duplicate_suppressed()
                    return RealtimeTranscriptAnalysisResponse(
                        meeting_id=meeting_id,
                        status="skipped",
                        reason="in_progress",
                        transcript_hash=transcript_hash,
                        source=source,
                        promptVersion=prompt_version,
                        schemaVersion=schema_version,
                        analysisFeatureSet=analysis_feature_set,
                        retryAfterSeconds=1,
                        errorCode="DUPLICATE_REQUEST_SKIPPED",
                    )
                error_code = (
                    "GEMINI_COST_GUARD_UNAVAILABLE"
                    if cost_reservation.reason == "guard_unavailable"
                    else "GEMINI_COST_LIMIT_EXCEEDED"
                )
                gemini_metrics.failure(error_code)
                return RealtimeTranscriptAnalysisResponse(
                    meeting_id=meeting_id,
                    status="failed",
                    reason=cost_reservation.reason,
                    transcript_hash=transcript_hash,
                    source=source,
                    promptVersion=prompt_version,
                    schemaVersion=schema_version,
                    analysisFeatureSet=analysis_feature_set,
                    errorCode=error_code,
                    retryable=False,
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
            analysis_attempt=analysis_attempt,
            trace_id=analysis_trace_id,
        )
        if not allowed:
            if cost_guard is not None:
                cost_guard.release(cost_reservation)
            if skip_reason in {"in_progress", "already_exists"}:
                cached_analysis_run = (
                    find_completed_analysis_run_for_identity(db, cache_identity)
                    if cache_identity is not None
                    else None
                )
                if cached_analysis_run is not None:
                    cached_analysis = analysis_payload_from_run(
                        cached_analysis_run, cache_hit=True
                    )
                    logger.info(
                        "ANALYSIS_CACHE_HIT meetingId={} provider={} model={} promptVersion={} schemaVersion={} canonicalTranscriptHash={} canonicalTranscriptVersion={} analysisInputMode={}",
                        meeting_id,
                        cache_identity.provider,
                        cache_identity.model,
                        cache_identity.prompt_version,
                        cache_identity.schema_version,
                        cache_identity.canonical_transcript_hash,
                        cache_identity.canonical_transcript_version,
                        cache_identity.analysis_input_mode,
                    )
                    gemini_metrics.cache_hit()
                    return RealtimeTranscriptAnalysisResponse(
                        meeting_id=meeting_id,
                        status="completed",
                        analysis=cached_analysis,
                        transcript_hash=transcript_hash,
                        source=source,
                        promptVersion=(
                            cached_analysis.get("promptVersion") or prompt_version
                        ),
                        schemaVersion=(
                            cached_analysis.get("schemaVersion") or schema_version
                        ),
                        analysisFeatureSet=(
                            cached_analysis.get("analysisFeatureSet")
                            or analysis_feature_set
                        ),
                        analysisStatus=cached_analysis.get("analysisStatus"),
                        cacheHit=True,
                        provider=cached_analysis.get("provider"),
                        model=cached_analysis.get("model"),
                        canonicalTranscriptHash=cached_analysis.get(
                            "canonicalTranscriptHash"
                        ),
                        canonicalTranscriptVersion=cached_analysis.get(
                            "canonicalTranscriptVersion"
                        ),
                        analysisInputMode=cached_analysis.get("analysisInputMode"),
                        lastAnalyzedAt=cached_analysis.get("lastAnalyzedAt"),
                        stale=cached_analysis.get("stale"),
                        staleReason=cached_analysis.get("staleReason"),
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
                    analysisFeatureSet=analysis_feature_set,
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
                analysisFeatureSet=analysis_feature_set,
                retryAfterSeconds=retry_after_seconds or None,
                errorCode=skip_error_code,
                analysisStatus=(
                    ANALYSIS_STATUS_ANALYZING if skip_reason == "in_progress" else None
                ),
                cacheHit=False if skip_reason == "in_progress" else None,
            )

        logger.info(
            "event=REALTIME_ANALYSIS_TRIGGERED meetingId={} source={}",
            meeting_id,
            source,
        )
        if cache_identity is not None:
            active_analysis_run, began_run = begin_analysis_run(
                db=db,
                identity=cache_identity,
                mode=mode,
                requested_by=source,
                rerun_reason=request.reason,
                reanalysis_generation=reanalysis_generation,
            )
            db.commit()
            if (
                not began_run
                and active_analysis_run.status == ANALYSIS_STATUS_ANALYZING
            ):
                run_metadata = analysis_run_response_metadata(
                    active_analysis_run, cache_hit=False
                )
                try:
                    client = _get_client()
                    if lock_token:
                        current_raw = client.get(_analysis_lock_key(meeting_id))
                        if lock_token_from_raw(current_raw) == lock_token:
                            release_analysis_lock(
                                client, _analysis_lock_key(meeting_id), lock_token
                            )
                except Exception:
                    pass
                if cost_guard is not None:
                    cost_guard.release(cost_reservation)
                return RealtimeTranscriptAnalysisResponse(
                    meeting_id=meeting_id,
                    status="skipped",
                    reason="in_progress",
                    transcript_hash=transcript_hash,
                    source=source,
                    promptVersion=prompt_version,
                    schemaVersion=schema_version,
                    analysisFeatureSet=analysis_feature_set,
                    retryAfterSeconds=1,
                    analysisStatus=run_metadata.get("analysisStatus"),
                    cacheHit=False,
                    provider=run_metadata.get("provider"),
                    model=run_metadata.get("model"),
                    canonicalTranscriptHash=run_metadata.get("canonicalTranscriptHash"),
                    canonicalTranscriptVersion=run_metadata.get(
                        "canonicalTranscriptVersion"
                    ),
                    analysisInputMode=run_metadata.get("analysisInputMode"),
                    lastAnalyzedAt=run_metadata.get("lastAnalyzedAt"),
                    stale=run_metadata.get("stale"),
                    staleReason=run_metadata.get("staleReason"),
                )
            if not began_run:
                if cost_guard is not None:
                    cost_guard.release(cost_reservation)
                try:
                    client = _get_client()
                    if lock_token:
                        current_raw = client.get(_analysis_lock_key(meeting_id))
                        if lock_token_from_raw(current_raw) == lock_token:
                            release_analysis_lock(
                                client, _analysis_lock_key(meeting_id), lock_token
                            )
                except Exception:
                    pass
                if active_analysis_run.status == "COMPLETED":
                    existing_payload = analysis_payload_from_run(
                        active_analysis_run, cache_hit=True
                    )
                    gemini_metrics.cache_hit()
                    return RealtimeTranscriptAnalysisResponse(
                        meeting_id=meeting_id,
                        status="completed",
                        analysis=existing_payload,
                        reason="already_exists",
                        transcript_hash=transcript_hash,
                        source=source,
                        promptVersion=existing_payload.get("promptVersion"),
                        schemaVersion=existing_payload.get("schemaVersion"),
                        analysisFeatureSet=existing_payload.get("analysisFeatureSet"),
                        analysisStatus=existing_payload.get("analysisStatus"),
                        cacheHit=True,
                        provider=existing_payload.get("provider"),
                        model=existing_payload.get("model"),
                        canonicalTranscriptHash=existing_payload.get(
                            "canonicalTranscriptHash"
                        ),
                        canonicalTranscriptVersion=existing_payload.get(
                            "canonicalTranscriptVersion"
                        ),
                        analysisInputMode=existing_payload.get("analysisInputMode"),
                        lastAnalyzedAt=existing_payload.get("lastAnalyzedAt"),
                    )
                run_metadata = analysis_run_response_metadata(
                    active_analysis_run, cache_hit=False
                )
                return RealtimeTranscriptAnalysisResponse(
                    meeting_id=meeting_id,
                    status="failed",
                    reason="already_processed",
                    transcript_hash=transcript_hash,
                    source=source,
                    promptVersion=prompt_version,
                    schemaVersion=schema_version,
                    analysisFeatureSet=analysis_feature_set,
                    errorCode=active_analysis_run.error_code,
                    retryable=is_analysis_run_retryable(active_analysis_run),
                    analysisRetryCount=run_metadata.get("analysisRetryCount"),
                    analysisStatus=run_metadata.get("analysisStatus"),
                    cacheHit=False,
                    provider=run_metadata.get("provider"),
                    model=run_metadata.get("model"),
                )
        success = False
        finish_error_code: str | None = None
        finish_error_reason: str | None = None
        finish_retry_after_seconds = 0
        finish_error_retryable: bool | None = None
        try:
            response = _analyze_and_persist_realtime_transcript(
                meeting_id=meeting_id,
                transcript_text=transcript_text,
                transcript_hash=transcript_hash,
                prompt_version=prompt_version,
                schema_version=schema_version,
                analysis_feature_set=analysis_feature_set,
                source=source,
                domain_mode=normalized_domain,
                db=db,
                analysis_run=active_analysis_run,
                rerun_reason=request.reason,
                reanalysis_generation=reanalysis_generation,
                allowed_segment_ids=education_allowed_segment_ids,
                evidence_unavailable=education_evidence_unavailable,
                recording_session_id=provenance.recording_session_id,
                attempt_id=provenance.attempt_id,
            )
            success = True
            return response
        except AnalysisRateLimitError as analysis_error:
            db.rollback()
            gemini_metrics.failure(
                getattr(analysis_error, "error_code", None) or "rate_limited"
            )
            retry_after_seconds = int(
                getattr(analysis_error, "retry_after_seconds", None)
                or _REALTIME_ANALYSIS_FAILURE_COOLDOWN_SECONDS
            )
            error_code = (
                str(
                    getattr(analysis_error, "error_code", None) or "GEMINI_RATE_LIMITED"
                )
                .strip()
                .upper()
                or "GEMINI_RATE_LIMITED"
            )
            mark_analysis_run_failed(
                run=active_analysis_run,
                status=ANALYSIS_STATUS_FAILED_RETRYABLE,
                error_code=error_code,
                error_message=safe_error_message(analysis_error),
                analysis_retry_count=int(
                    getattr(active_analysis_run, "analysis_retry_count", 0) or 0
                )
                + 1,
                analysis_trace_id=uuid4().hex[:12],
                analysis_input_hash=transcript_hash,
            )
            db.commit()
            logger.warning(
                "event=REALTIME_ANALYSIS_FAILED_RETRYABLE meetingId={} source={} errorCode={} retryAfterSeconds={} error={}",
                meeting_id,
                source,
                error_code,
                retry_after_seconds,
                safe_error_message(analysis_error),
            )
            finish_error_code = error_code
            finish_error_reason = safe_error_message(analysis_error)
            finish_retry_after_seconds = retry_after_seconds
            finish_error_retryable = True
            raise HTTPException(
                status_code=429,
                detail={
                    "error": error_code,
                    "message": _default_error_message(error_code),
                    "details": {
                        "provider": "gemini",
                        "retryable": True,
                        "retryAfterSeconds": retry_after_seconds,
                        "errorCode": error_code,
                    },
                },
            ) from analysis_error
        except AnalysisParseError as analysis_error:
            db.rollback()
            gemini_metrics.failure("schema_invalid")
            mark_analysis_run_failed(
                run=active_analysis_run,
                status=ANALYSIS_STATUS_FAILED,
                error_code="GEMINI_ANALYSIS_FAILED",
                error_message=safe_error_message(analysis_error),
            )
            db.commit()
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
            finish_error_retryable = False
            raise HTTPException(
                status_code=502,
                detail="Gemini analysis failed",
            ) from analysis_error
        except (AnalysisConfigError, AnalysisUnavailableError) as analysis_error:
            db.rollback()
            error_code = (
                str(getattr(analysis_error, "error_code", None) or "GEMINI_UNAVAILABLE")
                .strip()
                .upper()
                or "GEMINI_UNAVAILABLE"
            )
            gemini_metrics.failure(error_code)
            exception_retryable = bool(getattr(analysis_error, "retryable", True))
            if isinstance(analysis_error, AnalysisConfigError):
                exception_retryable = False
            will_retry = is_retryable_error_code(
                error_code, retryable=exception_retryable
            )
            mark_analysis_run_failed(
                run=active_analysis_run,
                status=(
                    ANALYSIS_STATUS_FAILED_RETRYABLE
                    if will_retry
                    else ANALYSIS_STATUS_FAILED
                ),
                error_code=error_code,
                error_message=safe_error_message(analysis_error),
                analysis_retry_count=int(
                    getattr(active_analysis_run, "analysis_retry_count", 0) or 0
                )
                + 1,
                analysis_trace_id=uuid4().hex[:12],
                analysis_input_hash=transcript_hash,
            )
            db.commit()
            logger.warning(
                "event=REALTIME_ANALYSIS_FAILED meetingId={} source={} errorCode={} retryable={} error={}",
                meeting_id,
                source,
                error_code,
                will_retry,
                safe_error_message(analysis_error),
            )
            finish_error_code = error_code
            finish_error_reason = safe_error_message(analysis_error)
            finish_retry_after_seconds = int(
                getattr(analysis_error, "retry_after_seconds", None)
                or _REALTIME_ANALYSIS_FAILURE_COOLDOWN_SECONDS
            )
            finish_error_retryable = exception_retryable
            raise HTTPException(
                status_code=503,
                detail={
                    "error": error_code,
                    "message": _default_error_message(error_code),
                    "details": {
                        "provider": "gemini",
                        "retryable": will_retry,
                        "errorCode": error_code,
                    },
                },
            ) from analysis_error
        except Exception as analysis_error:
            db.rollback()
            mark_analysis_run_failed(
                run=active_analysis_run,
                status=ANALYSIS_STATUS_FAILED,
                error_code="GEMINI_ANALYSIS_FAILED",
                error_message=safe_error_message(analysis_error),
            )
            db.commit()
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
            finish_error_retryable = False
            raise HTTPException(
                status_code=502,
                detail="Gemini analysis failed",
            ) from analysis_error
        finally:
            finish_retry_count = None
            finish_next_retry_at = None
            finish_trace_id = analysis_trace_id
            finish_provider_alias = None
            finish_retry_exhausted = None
            if active_analysis_run is not None:
                finish_retry_count = int(
                    getattr(active_analysis_run, "analysis_retry_count", 0) or 0
                )
                finish_trace_id = str(
                    getattr(active_analysis_run, "analysis_trace_id", None)
                    or analysis_trace_id
                )
                finish_provider_alias = getattr(
                    active_analysis_run, "analysis_provider_alias", None
                )
                next_retry_at = getattr(
                    active_analysis_run, "analysis_next_retry_at", None
                )
                if next_retry_at is not None:
                    finish_next_retry_at = (
                        next_retry_at.isoformat()
                        if hasattr(next_retry_at, "isoformat")
                        else str(next_retry_at)
                    )
                finish_retry_exhausted = (
                    finish_retry_count
                    >= settings.analysis_background_retry_max_attempts
                )
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
                analysis_retry_count=finish_retry_count,
                analysis_next_retry_at=finish_next_retry_at,
                analysis_trace_id=finish_trace_id,
                analysis_provider_alias=finish_provider_alias,
                retry_exhausted=finish_retry_exhausted,
                error_retryable=finish_error_retryable,
            )
            if cost_guard is not None:
                cost_guard.release(cost_reservation, success=success)
            if (
                not success
                and is_retryable_error_code(
                    finish_error_code, retryable=finish_error_retryable
                )
                and active_analysis_run is not None
            ):
                _schedule_background_analysis_retry(
                    meeting_id,
                    analysis_attempt=int(
                        getattr(active_analysis_run, "analysis_retry_count", 0) or 0
                    ),
                    analysis_input_hash=transcript_hash,
                    trace_id=str(
                        getattr(active_analysis_run, "analysis_trace_id", None)
                        or uuid4().hex[:12]
                    ),
                    source="background_retry",
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


def _runtime_metadata() -> dict[str, Any]:
    stt_provider = (settings.stt_provider or "deepgram").strip().lower()
    analysis_provider = (settings.analysis_provider or "gemini").strip().lower()
    legacy_offline_stt_enabled = _legacy_local_stt_enabled_for_startup_log()

    metadata: dict[str, Any] = {
        "analysis_provider": analysis_provider,
        "stt_provider": stt_provider,
        "analysisProvider": analysis_provider,
        "sttProvider": stt_provider,
        "local_stt_enabled": legacy_offline_stt_enabled,
        "offline_stt_enabled": legacy_offline_stt_enabled,
        "legacy_offline_stt": {
            "enabled": legacy_offline_stt_enabled,
            "whisper_model": settings.whisper_model,
            "device": get_runtime_device(),
        },
        "lazy_load_models": settings.lazy_load_models,
        "enable_speaker_diarization": settings.enable_speaker_diarization,
        "stt_actor_registry": _stt_registry_summary(),
    }

    return metadata


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    await _cleanup_stale_stt_actors()
    return _health_payload(
        status="UP",
        dependencies={},
        legacy_status="healthy",
        extras=_runtime_metadata(),
    )


@app.get("/liveness")
async def liveness_check():
    """Process liveness only — no dependency checks."""
    return _health_payload(
        status="UP",
        dependencies={},
        legacy_status="alive",
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

    native_deepgram_diarization = bool(
        settings.enable_speaker_diarization and settings.deepgram_diarize
    )
    local_diarization_requires_hf = bool(
        settings.enable_speaker_diarization and not native_deepgram_diarization
    )
    hf_configured = bool((settings.huggingface_token or "").strip())
    dependencies["huggingfaceConfigured"] = _dependency_state(hf_configured)
    if local_diarization_requires_hf and not hf_configured:
        ready = False

    analysis_provider = (settings.analysis_provider or "").strip().lower()
    gemini_required = analysis_provider == "gemini"
    gemini_test_mode = (settings.gemini_client_test_mode or "").strip().lower()
    gemini_configured = bool((settings.gemini_api_key or "").strip()) or (
        gemini_test_mode == "fault_injection"
    )
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
    if isinstance(exc, AnalysisRateLimitError) and provider == "gemini":
        error = getattr(exc, "error_code", None) or "GEMINI_RATE_LIMITED"
        status_code = 429
    elif isinstance(exc, AnalysisParseError) and provider == "gemini":
        error = "GEMINI_ANALYSIS_FAILED"
        status_code = 502
    elif provider == "deepgram":
        error = "DEEPGRAM_UNAVAILABLE"
        status_code = 503
    elif provider == "gemini":
        error = (
            str(getattr(exc, "error_code", None) or "GEMINI_UNAVAILABLE")
            .strip()
            .upper()
            or "GEMINI_UNAVAILABLE"
        )
        status_code = 503
    elif isinstance(exc, AnalysisRateLimitError):
        error = "SERVICE_UNAVAILABLE"
        status_code = 503
    elif isinstance(exc, AnalysisNotImplementedError):
        error = "SERVICE_UNAVAILABLE"
        status_code = 503
    elif isinstance(exc, (AnalysisConfigError, AnalysisUnavailableError)):
        error = (
            str(getattr(exc, "error_code", None) or "SERVICE_UNAVAILABLE")
            .strip()
            .upper()
            or "SERVICE_UNAVAILABLE"
        )
        status_code = 503
    else:
        error = "SERVICE_UNAVAILABLE"
        status_code = 503

    details = {"provider": provider} if provider else {}
    retry_after_seconds = getattr(exc, "retry_after_seconds", None)
    error_code = getattr(exc, "error_code", None)
    if retry_after_seconds is not None:
        details["retryAfterSeconds"] = retry_after_seconds
    if error_code:
        details["errorCode"] = error_code
    details["retryable"] = bool(getattr(exc, "retryable", False))

    return build_error_response(
        error=error,
        message=_default_error_message(error),
        status=status_code,
        request=request,
        details=details or None,
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
        error_type = type(e).__name__
        logger.error(
            "event=REQUEST_FAILED requestId={} path=/api/process errorCode={} error={}",
            request_id,
            error_type,
            safe_error_message(e),
        )
        if (
            error_type in {"OperationalError", "ConnectionError"}
            or "kombu" in str(type(e).__module__).lower()
        ):
            raise HTTPException(
                status_code=503,
                detail="Task broker unavailable. request_id={request_id}",
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
        allowed_extensions = effective_allowed_extensions(
            strict=settings.upload_validation_strict,
            legacy_extensions=settings.allowed_upload_extensions,
        )
        if extension not in allowed_extensions:
            raise HTTPException(
                status_code=415,
                detail="UPLOAD_UNSUPPORTED_FORMAT",
            )
        saved_name = f"{uuid4().hex}{extension}"
        saved_path = uploads_dir / saved_name

        total_bytes = 0
        chunk_size = 1024 * 1024
        max_upload_bytes = effective_max_upload_bytes(
            strict=settings.upload_validation_strict,
            legacy_max_bytes=settings.max_upload_size_bytes,
        )
        sniff_buffer = bytearray()
        mime_checked = False

        with saved_path.open("wb") as output_file:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break
                if settings.mime_sniff_enabled and not mime_checked:
                    sniff_buffer.extend(chunk)
                    if len(sniff_buffer) >= min(64 * 1024, max(1, max_upload_bytes)):
                        validate_upload_mime(
                            bytes(sniff_buffer[: 64 * 1024]),
                            extension,
                            len(sniff_buffer),
                            enabled=True,
                        )
                        mime_checked = True
                total_bytes += len(chunk)
                if total_bytes > max_upload_bytes:
                    output_file.close()
                    saved_path.unlink(missing_ok=True)
                    raise HTTPException(status_code=413, detail="UPLOAD_TOO_LARGE")
                output_file.write(chunk)

        if settings.mime_sniff_enabled and not mime_checked and total_bytes > 0:
            validate_upload_mime(
                bytes(sniff_buffer[: 64 * 1024]),
                extension,
                total_bytes,
                enabled=True,
            )

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


@app.post("/api/v1/stt/final-audio-fallback")
async def final_audio_fallback(
    http_request: Request,
    meeting_id: int = Form(...),
    audio_path: str = Form(...),
    language: str = Form(default="vi"),
):
    from app.services.final_audio_fallback import run_final_audio_fallback
    from app.services.final_audio_path_validation import FinalAudioPathError
    from app.services.internal_service_auth import (
        FinalAudioAuthError,
        raise_http_for_auth_error,
        require_internal_service_token,
    )

    try:
        require_internal_service_token(http_request)
    except FinalAudioAuthError as auth_exc:
        raise_http_for_auth_error(auth_exc)

    # Trusted internal callers (processing-service) may pass a raw server path.
    # TODO(security): migrate to upload/file ID binding so meeting ownership is proven
    # without trusting client-supplied absolute paths (even from internal callers).
    trace_id = getattr(http_request.state, "trace_id", None)
    request_id = getattr(http_request.state, "request_id", None)
    try:
        result = await asyncio.to_thread(
            run_final_audio_fallback,
            meeting_id=meeting_id,
            audio_path=audio_path,
            language=language,
            trace_id=trace_id,
            request_id=request_id,
        )
    except FinalAudioPathError as exc:
        status = (
            503
            if exc.code
            in {
                "FINAL_AUDIO_PROBE_UNAVAILABLE",
                "FINAL_AUDIO_PROBE_TIMEOUT",
            }
            else 400
        )
        raise HTTPException(
            status_code=status,
            detail={"error_code": exc.code, "message": exc.safe_message},
        ) from None
    return {
        "meeting_id": meeting_id,
        **result,
    }


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
    stream_id: str = Form(default=""),
    recording_session_id: int | None = Form(default=None),
    attempt_id: int | None = Form(default=None),
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
    validate_stream_chunk(
        chunk_bytes,
        seq=seq,
        is_final=is_final,
        enabled=settings.realtime_validation_enabled,
    )
    stream_id = _as_optional_text(stream_id)
    try:
        provenance = validate_transcript_provenance(
            recording_session_id,
            attempt_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    realtime_model = _resolve_realtime_model()
    endpointing_value = (
        endpointing_resolution.endpointing
        if endpointing_resolution.endpointing is not None
        else "omitted"
    )
    request_language = language or ""
    interim_results_enabled = True
    smart_format_enabled = bool(
        (not settings.deepgram_simplify_streaming_url)
        and getattr(settings, "deepgram_smart_format", True)
    )
    utterances_enabled = bool(
        (not settings.deepgram_simplify_streaming_url)
        and getattr(settings, "deepgram_utterances", True)
    )
    paragraphs_enabled = False
    detect_language_enabled = False
    sample_rate_included = False
    sample_rate = "omitted"
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
        "event=REALTIME_STT_DIAGNOSTIC_CONFIG traceId={} requestId={} meetingId={} source=realtime provider=deepgram requestedLanguage={} effectiveLanguage={} deepgramLanguage={} recognitionMode={} model={} endpointing={} interimResults={} smartFormat={} utterances={} paragraphs={} diarize={} detectLanguage={} encoding={} sampleRateIncluded={} sampleRate={} channels={}",
        trace_id,
        request_id,
        meeting_id,
        request_language,
        normalized_language,
        normalized_language,
        normalized_language,
        realtime_model,
        endpointing_value,
        interim_results_enabled,
        smart_format_enabled,
        utterances_enabled,
        paragraphs_enabled,
        effective_diarize,
        detect_language_enabled,
        encoding,
        sample_rate_included,
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
        "event=DEEPGRAM_STT_CONFIG traceId={} requestId={} meetingId={} source=realtime provider=deepgram language={} recognitionMode={} model={} endpointing={} diarization={} utterances={} paragraphs={} path=realtime",
        trace_id,
        request_id,
        meeting_id,
        normalized_language,
        normalized_language,
        realtime_model,
        endpointing_value,
        effective_diarize,
        utterances_enabled,
        paragraphs_enabled,
    )
    logger.info(
        "stream_stt_chunk received meeting_id={} seq={} byteLength={}",
        meeting_id,
        seq,
        len(chunk_bytes),
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

    meeting_key = _normalize_stream_key(meeting_id, stream_id)
    actor_key = _stt_actor_registry_key(
        meeting_key,
        recording_session_id=provenance.recording_session_id,
        attempt_id=provenance.attempt_id,
    )
    now = time.time()
    guard = _get_stream_retry_guard(actor_key)
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
        _clear_stream_retry_guard(actor_key)
        guard = _get_stream_retry_guard(actor_key)

    cached_response = _get_cached_final_response(actor_key)
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
            registry_key=actor_key,
            recording_session_id=provenance.recording_session_id,
            attempt_id=provenance.attempt_id,
        )
    except HTTPException:
        raise
    except Exception as exc:
        if (
            "unavailable" in str(exc).lower()
            and pipeline is not None
            and getattr(pipeline, "speech_recognizer", None) is not None
            and _legacy_local_stt_allowed()
            and bool(getattr(settings, "local_whisper_enabled", False))
        ):
            logger.info(
                "STT_LOCAL_FALLBACK meeting_id={} seq={} reason=deepgram_unavailable",
                meeting_key,
                seq,
            )
            return _transcribe_locally(chunk_bytes, normalized_language, is_final)
        if "unavailable" in str(exc).lower():
            logger.warning(
                "STT_LOCAL_FALLBACK_SKIPPED meeting_id={} seq={} reason=legacy_local_stt_disabled localWhisperEnabled={} allowLegacyLocalStt={}",
                meeting_key,
                seq,
                bool(getattr(settings, "local_whisper_enabled", False)),
                _legacy_local_stt_allowed(),
            )
        logger.exception(
            "event=DEEPGRAM_STT_FAILED_TRACE traceId={} requestId={} meetingId={} source=realtime seq={} errorCode={}",
            trace_id,
            request_id,
            meeting_id,
            seq,
            type(exc).__name__,
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
                        actor_key, guard.cooldown_until
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
            _update_stream_retry_guard_from_actor(actor_key, actor)
            await _retire_stt_actor(actor_key, actor)
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
        _store_final_response(actor_key, response)
        _stt_stream_sessions.pop(actor_key, None)
        _clear_stream_retry_guard(actor_key)
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
