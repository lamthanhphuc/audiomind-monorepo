"""Batch STT fallback for realtime when live stream did not produce transcript rows."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from app.config import get_settings
from app.database import SessionLocal
from app.services.audio_enhancement_service import prepare_audio_for_stt
from app.services.final_audio_path_validation import (
    FinalAudioPathError,
    validate_final_audio_fallback_path,
)
from app.services.stt_adapter import DeepgramSTTAdapter
from app.services.stt_persistence import (
    TranscriptFragmentInput,
    TranscriptPersistenceRepository,
)

logger = logging.getLogger(__name__)

FALLBACK_EVENT_PREFIX = "final-audio-fallback"


def _build_adapter() -> DeepgramSTTAdapter:
    settings = get_settings()
    api_key = settings.deepgram_api_key
    if not api_key:
        raise RuntimeError("DEEPGRAM_API_KEY is required for final audio fallback")
    return DeepgramSTTAdapter(
        api_key=api_key,
        model=settings.deepgram_batch_model,
        base_url=settings.deepgram_base_url,
        timeout_seconds=settings.deepgram_timeout_seconds,
        enable_speaker_diarization=settings.enable_speaker_diarization,
        deepgram_diarize=settings.deepgram_diarize,
        smart_format=bool(getattr(settings, "deepgram_smart_format", True)),
        utterances=bool(getattr(settings, "deepgram_utterances", True)),
        paragraphs=bool(getattr(settings, "deepgram_paragraphs", True)),
    )


def run_final_audio_fallback(
    *,
    meeting_id: int,
    audio_path: str,
    language: str,
    trace_id: str | None,
    request_id: str | None,
) -> dict[str, Any]:
    resolved_trace = trace_id or f"final-audio-fallback-{meeting_id}"
    resolved_request = request_id or resolved_trace
    settings = get_settings()

    try:
        path = validate_final_audio_fallback_path(
            audio_path,
            settings=settings,
            require_audio_probe=True,
        )
    except FinalAudioPathError as exc:
        logger.warning(
            "STT_FINAL_AUDIO_FALLBACK_FAILED meeting_id=%s traceId=%s requestId=%s errorCode=%s",
            meeting_id,
            resolved_trace,
            resolved_request,
            exc.code,
        )
        raise

    audio_bytes = path.stat().st_size
    logger.info(
        "STT_FINAL_AUDIO_FALLBACK_STARTED meeting_id=%s traceId=%s requestId=%s audioBytes=%s language=%s name=%s",
        meeting_id,
        resolved_trace,
        resolved_request,
        audio_bytes,
        language,
        path.name,
    )

    # Idempotency BEFORE enhancement / STT so retries are cheap.
    db = SessionLocal()
    try:
        repository = TranscriptPersistenceRepository(db)
        existing = repository.list_fragments(meeting_id)
        fallback_existing = [
            row
            for row in existing
            if str(row.event_id or "").startswith(FALLBACK_EVENT_PREFIX)
        ]
        if fallback_existing:
            logger.info(
                "STT_FINAL_AUDIO_FALLBACK_IDEMPOTENT_REPLAY meeting_id=%s traceId=%s requestId=%s transcriptCount=%s",
                meeting_id,
                resolved_trace,
                resolved_request,
                len(fallback_existing),
            )
            db.commit()
            return {
                "status": "completed",
                "error_code": None,
                "transcript_count": len(fallback_existing),
                "idempotent_replay": True,
            }

        prepared_path, enhanced_path = prepare_audio_for_stt(
            path,
            enabled=settings.audio_enhancement_enabled,
            provider_name=settings.audio_enhancement_provider,
            keep_enhanced=settings.audio_keep_enhanced_file,
            timeout_seconds=settings.audio_enhancement_timeout_seconds,
            temp_dir=Path(settings.temp_storage_path),
        )
        try:
            adapter = _build_adapter()
            effective_language = language or settings.deepgram_language
            result = adapter.batch_transcribe_file(
                file_path=str(prepared_path),
                language=effective_language,
                model=settings.deepgram_batch_model,
            )
            segments = result.get("segments", []) if isinstance(result, dict) else []
            persisted = 0
            base_seq = len(existing)
            for index, segment in enumerate(segments, start=1):
                if not isinstance(segment, dict):
                    continue
                text = str(segment.get("text", "")).strip()
                if not text:
                    continue
                fragment = TranscriptFragmentInput(
                    meeting_id=meeting_id,
                    seq=base_seq + index,
                    speaker=str(segment.get("speaker", "SPEAKER_1")),
                    start_time=float(segment.get("start", 0.0)),
                    end_time=float(segment.get("end", 0.0)),
                    text=text,
                    event_id=f"{FALLBACK_EVENT_PREFIX}-{meeting_id}-{index}",
                    is_final=True,
                    confidence=(
                        float(segment["confidence"])
                        if segment.get("confidence") is not None
                        else None
                    ),
                )
                repository.append_fragment(fragment)
                persisted += 1

            db.commit()
            if persisted > 0:
                logger.info(
                    "STT_FINAL_AUDIO_FALLBACK_SUCCEEDED meeting_id=%s traceId=%s requestId=%s transcriptCount=%s",
                    meeting_id,
                    resolved_trace,
                    resolved_request,
                    persisted,
                )
                return {
                    "status": "completed",
                    "error_code": None,
                    "transcript_count": persisted,
                    "idempotent_replay": False,
                }

            logger.info(
                "STT_FINAL_AUDIO_FALLBACK_SUCCEEDED meeting_id=%s traceId=%s requestId=%s transcriptCount=0 errorCode=NO_TRANSCRIPT",
                meeting_id,
                resolved_trace,
                resolved_request,
            )
            return {
                "status": "completed",
                "error_code": "NO_TRANSCRIPT",
                "transcript_count": 0,
                "idempotent_replay": False,
            }
        finally:
            if enhanced_path is not None and not settings.audio_keep_enhanced_file:
                try:
                    enhanced_path.unlink(missing_ok=True)
                except OSError:
                    logger.warning(
                        "AUDIO_ENHANCEMENT_CLEANUP_FAILED input=%s",
                        enhanced_path.name,
                    )
    except Exception as exc:
        db.rollback()
        logger.warning(
            "STT_FINAL_AUDIO_FALLBACK_FAILED meeting_id=%s traceId=%s requestId=%s errorCode=%s error=%s",
            meeting_id,
            resolved_trace,
            resolved_request,
            type(exc).__name__,
            str(exc),
        )
        return {
            "status": "failed",
            "error_code": type(exc).__name__,
            "transcript_count": 0,
            "idempotent_replay": False,
        }
    finally:
        db.close()
