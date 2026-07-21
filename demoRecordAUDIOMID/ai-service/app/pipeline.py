import json
import hashlib
import re
import time
from datetime import datetime
from pathlib import Path, PureWindowsPath
from typing import Dict, List, Optional

from loguru import logger
from sqlalchemy.orm import Session

from app.config import get_runtime_device, get_settings
from app.job_status_store import _get_client
from app.logging_utils import safe_error_message, transcript_hash_prefix
from app.metrics import gemini_metrics
from app.models import Analysis, Transcript, TranscriptFragment
from app.services.analysis_errors import AnalysisUnavailableError
from app.services.analysis_runs import (
    ANALYSIS_MODE_CACHE_ONLY,
    ANALYSIS_MODE_FAILED_RETRY,
    ANALYSIS_MODE_FORCE,
    ANALYSIS_STATUS_ANALYZING,
    analysis_payload_from_run,
    analysis_miss_response_metadata,
    analysis_run_response_metadata,
    begin_analysis_run,
    build_analysis_cache_identity,
    find_completed_analysis_run_for_identity,
    find_in_progress_analysis_run_for_identity,
    find_latest_analysis_run_for_identity,
    is_analysis_run_retryable,
    mark_analysis_run_failed,
    mark_analysis_run_skipped_short,
    persist_completed_analysis_run,
    normalize_analysis_mode,
)
from app.services.analysis_factory import build_analysis_analyzer
from app.services.analysis_versioning import merge_domain_analysis_payload
from app.services.gemini_context_budget import estimate_text_tokens
from app.services.gemini_cost_guard import GeminiCostGuard
from app.services.segment_identity import (
    assign_stable_segment_ids,
    format_aligned_transcript_for_analysis,
    collect_allowed_segment_ids,
)
from app.services.audio_enhancement_service import prepare_audio_for_stt
from app.services.audio_processor import AudioProcessor
from app.services.stt_adapter import (
    DeepgramSTTAdapter,
    normalize_deepgram_speaker_label,
)
from app.services.stt_persistence import (
    TranscriptFragmentInput,
    TranscriptPersistenceRepository,
)

settings = get_settings()
ALLOWED_BATCH_LANGUAGES = {"vi", "en", "multi"}
OFFLINE_STT_DEPENDENCIES_ERROR = (
    "Offline Whisper dependencies are not installed. "
    "Build with INSTALL_OFFLINE_STT=true."
)


def _legacy_local_stt_allowed() -> bool:
    return bool(getattr(settings, "allow_legacy_local_stt", False))


def _normalized_stt_provider() -> str:
    provider = (settings.stt_provider or "deepgram").strip().lower()
    if provider == "whisper":
        return "local_whisper"
    return provider


class ProcessingPipeline:
    """
    Main processing pipeline orchestrating all services
    """

    def __init__(self):
        """Initialize all processing components"""

        logger.info("Initializing Processing Pipeline")

        # Lightweight components are initialized immediately.
        self.audio_processor = AudioProcessor(target_sr=16000)

        self.speech_recognizer = None
        self.speaker_diarizer = None
        self.ai_analyzer = None
        self.diarization_available = True

        if not settings.lazy_load_models:
            self._ensure_models_loaded()

        logger.info("Processing Pipeline initialized successfully")

    def _ensure_models_loaded(self):
        """Load heavy models only when needed."""
        runtime_device = get_runtime_device()
        preferred_device = (settings.device or "auto").strip().lower()
        stt_provider = _normalized_stt_provider()

        if preferred_device == "cuda" and runtime_device != "cuda":
            logger.warning(
                "Configured DEVICE=cuda but CUDA is unavailable. Falling back to CPU."
            )

        load_local_whisper = self._should_load_local_whisper(stt_provider)
        if load_local_whisper:
            logger.info(
                f"Runtime device selected for legacy local STT models: {runtime_device} (preferred={preferred_device})"
            )
            self._ensure_speech_recognizer_loaded(runtime_device)
        else:
            if not _legacy_local_stt_allowed():
                logger.info("Legacy local STT disabled")
            logger.info(
                "STT provider {}: no Whisper model loaded",
                stt_provider,
            )

        if self.ai_analyzer is None:
            self.ai_analyzer = build_analysis_analyzer(settings)

        if self._should_use_native_deepgram_diarization():
            return

        diarization_enabled = self._should_enable_diarization(runtime_device)
        if diarization_enabled and self.speaker_diarizer is None:
            if not load_local_whisper:
                logger.info(
                    f"Runtime device selected for local diarization: {runtime_device} (preferred={preferred_device})"
                )
            try:
                from app.services.speaker_diarizer import SpeakerDiarizer

                self.speaker_diarizer = SpeakerDiarizer(
                    hf_token=settings.huggingface_token, device=runtime_device
                )
                self.diarization_available = True
            except Exception as e:
                # Fallback gracefully to single-speaker mode when model/token is unavailable.
                self.diarization_available = False
                self.speaker_diarizer = None
                logger.warning(
                    f"Speaker diarization auto-disabled due to initialization failure: {repr(e)}"
                )

    def _should_load_local_whisper(self, stt_provider: Optional[str] = None) -> bool:
        provider = stt_provider or _normalized_stt_provider()
        local_whisper_enabled = bool(getattr(settings, "local_whisper_enabled", False))
        return bool(
            _legacy_local_stt_allowed()
            and (provider == "local_whisper" or local_whisper_enabled)
        )

    def _ensure_speech_recognizer_loaded(self, runtime_device: Optional[str] = None):
        """Load Whisper only after the local STT opt-in gate is satisfied."""
        stt_provider = _normalized_stt_provider()
        if not self._should_load_local_whisper(stt_provider):
            logger.info(
                "STT provider {}: no Whisper model loaded",
                stt_provider,
            )
            raise RuntimeError(
                "LEGACY_LOCAL_STT_DISABLED: set ALLOW_LEGACY_LOCAL_STT=true to use local Whisper"
            )

        if self.speech_recognizer is not None:
            return self.speech_recognizer

        try:
            from app.services.speech_recognizer import SpeechRecognizer
        except ModuleNotFoundError as exc:
            missing_module = (exc.name or "").split(".")[0]
            if missing_module in {"whisper", "torch", "torchaudio"}:
                raise RuntimeError(OFFLINE_STT_DEPENDENCIES_ERROR) from exc
            raise

        selected_device = runtime_device or get_runtime_device()
        self.speech_recognizer = SpeechRecognizer(
            model_name=settings.whisper_model,
            device=selected_device,
            no_speech_threshold=settings.whisper_no_speech_threshold,
            logprob_threshold=settings.whisper_logprob_threshold,
            cpu_chunk_duration_seconds=settings.whisper_cpu_chunk_seconds,
            gpu_chunk_duration_seconds=settings.whisper_gpu_chunk_seconds,
        )
        return self.speech_recognizer

    def _should_enable_diarization(self, runtime_device: str) -> bool:
        # GPU defaults to diarization enabled; CPU follows config toggle.
        if runtime_device == "cuda":
            return True
        return settings.enable_speaker_diarization

    def _should_use_native_deepgram_diarization(self) -> bool:
        return bool(settings.enable_speaker_diarization and settings.deepgram_diarize)

    def _record_baseline_snapshot(self, meeting_id: int, runtime_device: str) -> None:
        stt_provider = _normalized_stt_provider()
        analysis_provider = (settings.analysis_provider or "gemini").strip().lower()
        payload = {
            "meeting_id": meeting_id,
            "stt_provider": stt_provider,
            "analysis_provider": analysis_provider,
            "legacy_local_stt_enabled": self._should_load_local_whisper(stt_provider),
            "enable_speaker_diarization": settings.enable_speaker_diarization,
            "deepgram_diarize": settings.deepgram_diarize,
            "diarization_available": self.diarization_available,
            "timestamp": datetime.utcnow().isoformat(),
        }
        if payload["legacy_local_stt_enabled"]:
            payload["runtime_device"] = runtime_device
            payload["whisper_model"] = settings.whisper_model
            payload["local_diarization_enabled"] = self._should_enable_diarization(
                runtime_device
            )
        if analysis_provider in {"ollama", "local"} and bool(
            getattr(settings, "allow_legacy_local_ai", False)
        ):
            payload["ollama_timeout_seconds"] = settings.ollama_timeout_seconds

        logger.info(f"Processing baseline snapshot: {payload}")

        logs_dir = Path(__file__).resolve().parent.parent / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        baseline_path = logs_dir / f"baseline_{meeting_id}.json"
        baseline_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _normalize_speaker_labels(self, segments: List[Dict]) -> List[Dict]:
        speaker_map: Dict[str, str] = {}
        normalized = []

        for seg in segments:
            raw_speaker = normalize_deepgram_speaker_label(
                seg.get("speaker"), default=None
            )
            if raw_speaker is None:
                raw_speaker = str(seg.get("speaker", "UNKNOWN")).strip() or "UNKNOWN"
            canonical = speaker_map.get(raw_speaker)
            if canonical is None:
                canonical = f"SPEAKER_{len(speaker_map) + 1}"
                speaker_map[raw_speaker] = canonical

            normalized_segment = dict(seg)
            normalized_segment.update(
                {
                    "speaker": canonical,
                    "start": seg.get("start"),
                    "end": seg.get("end"),
                    "text": seg.get("text", ""),
                }
            )
            normalized.append(normalized_segment)

        return normalized

    def _deduplicate_repeated_segments(
        self,
        segments: List[Dict],
        repeat_threshold: int = 3,
        max_short_text_len: int = 40,
        max_time_gap_seconds: float = 2.5,
    ) -> List[Dict]:
        if not segments:
            return segments

        # Collapse runs like "Chuyên là..." repeated many short consecutive segments.
        deduped: List[Dict] = []
        idx = 0
        total_removed = 0

        while idx < len(segments):
            current = segments[idx]
            current_text = str(current.get("text", "")).strip()
            normalized_text = re.sub(r"\s+", " ", current_text.lower())

            run_end = idx
            while run_end + 1 < len(segments):
                nxt = segments[run_end + 1]
                next_text = re.sub(
                    r"\s+", " ", str(nxt.get("text", "")).strip().lower()
                )
                time_gap = float(nxt.get("start", 0.0)) - float(
                    segments[run_end].get("end", 0.0)
                )
                if next_text != normalized_text or time_gap > max_time_gap_seconds:
                    break
                run_end += 1

            run_length = run_end - idx + 1
            is_short_loop = (
                bool(normalized_text) and len(normalized_text) <= max_short_text_len
            )

            if is_short_loop and run_length > repeat_threshold:
                deduped.append(current)
                total_removed += run_length - 1
            else:
                deduped.extend(segments[idx : run_end + 1])

            idx = run_end + 1

        if total_removed > 0:
            logger.warning(
                f"Removed {total_removed} repeated transcript segments before DB save"
            )

        return deduped

    def _resolve_audio_path(self, audio_path: str) -> str:
        """Resolve incoming path from other services to an existing local file path."""

        def _decode_mojibake(value: str) -> str:
            try:
                return value.encode("latin-1").decode("utf-8")
            except UnicodeError:
                return value

        path_variants = [audio_path]
        repaired_audio_path = _decode_mojibake(audio_path)
        if repaired_audio_path != audio_path:
            path_variants.append(repaired_audio_path)

        raw_paths = [Path(item) for item in path_variants]

        windows_raw_paths = [PureWindowsPath(item) for item in path_variants]

        project_root = Path(__file__).resolve().parent.parent
        workspace_root = project_root.parent

        candidates: list[Path] = []
        for raw_path in raw_paths:
            if raw_path.is_absolute():
                candidates.append(raw_path)
            else:
                candidates.extend(
                    [
                        project_root / raw_path,
                        workspace_root / raw_path,
                        Path.cwd() / raw_path,
                    ]
                )

        upload_roots = [
            Path("/app/uploads"),
            Path.cwd() / "uploads",
            project_root / "uploads",
            workspace_root / "uploads",
            workspace_root / "meeting-service" / "uploads",
        ]

        # Fallback lookup: keep only filename and search common upload locations.
        audio_names = list(
            {
                name
                for name in (
                    [path.name for path in raw_paths]
                    + [path.name for path in windows_raw_paths]
                )
                if name
            }
        )
        for audio_name in audio_names:
            for root in upload_roots:
                candidates.append(root / audio_name)

        checked = []
        seen = set()
        for candidate in candidates:
            candidate_str = str(candidate)
            if candidate_str in seen:
                continue
            seen.add(candidate_str)
            checked.append(candidate_str)
            if candidate.exists() and candidate.is_file():
                resolved = str(candidate.resolve())
                logger.info(f"Resolved audio path: {audio_path} -> {resolved}")
                return resolved

        raise FileNotFoundError(
            f"Audio file not found for input path '{audio_path}'. Checked: {checked}"
        )

    @staticmethod
    def _normalize_glossary_terms(*candidates: object) -> List[str]:
        """Normalize glossary inputs to a safe list for len()/iteration/STT pass-through."""
        for candidate in candidates:
            if candidate is None:
                continue
            if isinstance(candidate, (list, tuple)):
                normalized: List[str] = []
                for term in candidate:
                    clean = str(term).strip()
                    if clean:
                        normalized.append(clean)
                return normalized
            if isinstance(candidate, str):
                clean = candidate.strip()
                return [clean] if clean else []
            logger.warning(
                "event=BATCH_PIPELINE_GLOSSARY_IGNORED glossaryType={}",
                type(candidate).__name__,
            )
            return []
        return []

    def _build_initial_prompt(
        self,
        topic: Optional[str] = None,
        glossary_terms: Optional[List[str]] = None,
        topic_defaults: Optional[Dict[str, List[str]]] = None,
    ) -> str:
        """Build a concise prompt to bias Whisper toward domain terms."""
        topic_key = (topic or "").strip().lower()
        defaults = topic_defaults or {}

        merged_terms = []
        seen = set()

        for term in defaults.get(topic_key, []):
            key = term.lower()
            if key not in seen:
                seen.add(key)
                merged_terms.append(term)

        for term in glossary_terms or []:
            clean_term = str(term).strip()
            if not clean_term:
                continue
            key = clean_term.lower()
            if key not in seen:
                seen.add(key)
                merged_terms.append(clean_term)

        base = (
            "Meeting transcript may contain Vietnamese mixed with English technical terms. "
            "Do not transliterate English terms into Vietnamese phonetics; keep original English spelling."
        )
        if not merged_terms:
            return base

        return (
            f"{base} Keep original spelling for these terms: {', '.join(merged_terms)}."
        )

    def _build_normalization_map(
        self,
        topic: Optional[str] = None,
        glossary_terms: Optional[List[str]] = None,
        glossary_normalization_map: Optional[Dict[str, str]] = None,
    ) -> Dict[str, str]:
        """Build normalization map from glossary service plus explicit request terms."""
        _ = topic  # Topic-specific defaults are now supplied by glossary service.
        normalization_map: Dict[str, str] = dict(glossary_normalization_map or {})

        for term in glossary_terms or []:
            clean = str(term).strip()
            if not clean:
                continue
            # Keep explicit canonical terms safe against accidental spacing in transcript.
            letters_spaced_pattern = (
                r"\\b" + r"\\s*".join(re.escape(ch) for ch in clean) + r"\\b"
            )
            normalization_map.setdefault(letters_spaced_pattern, clean)

        return normalization_map

    def _normalize_transcript_segments(
        self,
        segments: List[Dict],
        topic: Optional[str] = None,
        glossary_terms: Optional[List[str]] = None,
        glossary_normalization_map: Optional[Dict[str, str]] = None,
    ) -> List[Dict]:
        """Normalize common misrecognized terms while preserving timestamps/speakers."""
        replacements = self._build_normalization_map(
            topic=topic,
            glossary_terms=glossary_terms,
            glossary_normalization_map=glossary_normalization_map,
        )
        normalized = []

        for seg in segments:
            text = str(seg.get("text", ""))
            for pattern, target in replacements.items():
                text = re.sub(pattern, target, text, flags=re.IGNORECASE)

            normalized_segment = dict(seg)
            normalized_segment["start"] = seg.get("start")
            normalized_segment["end"] = seg.get("end")
            normalized_segment["text"] = text
            normalized_segment["words"] = seg.get("words", [])
            normalized.append(normalized_segment)

        return normalized

    def _transcribe_with_provider_selection(
        self,
        audio_path: str,
        language: Optional[str] = "vi",
        initial_prompt: Optional[str] = None,
        meeting_id: Optional[int] = None,
        trace_id: Optional[str] = None,
    ) -> List[Dict]:
        """
        Select STT provider and transcribe audio.

        Provider selection order:
        1. If STT_PROVIDER=deepgram and DEEPGRAM_API_KEY exists: use Deepgram batch
        2. If Deepgram fails and legacy local STT is explicitly allowed: fallback to Whisper
        3. If STT_PROVIDER=local_whisper and ALLOW_LEGACY_LOCAL_STT=true: use Whisper
        4. Otherwise: raise error

        Args:
            audio_path: Path to audio file
            language: Language code (e.g., 'vi')
            initial_prompt: Initial prompt for Whisper

        Returns:
            List of transcript segments with timing
        """
        stt_provider = _normalized_stt_provider()
        deepgram_api_key = (settings.deepgram_api_key or "").strip()
        deepgram_batch_model = (
            settings.deepgram_batch_model or settings.deepgram_model or "nova-3"
        ).strip() or "nova-3"
        deepgram_language = self._normalize_batch_language(language)
        local_whisper_enabled = bool(getattr(settings, "local_whisper_enabled", False))
        legacy_local_stt_allowed = _legacy_local_stt_allowed()
        local_whisper_requested = stt_provider == "local_whisper"
        local_whisper_runtime_enabled = bool(
            legacy_local_stt_allowed
            and (local_whisper_requested or local_whisper_enabled)
        )
        deepgram_timeout_seconds = int(settings.deepgram_timeout_seconds)

        transcript_segments = []
        audio_bytes = -1
        try:
            audio_bytes = max(0, int(Path(audio_path).stat().st_size))
        except OSError:
            audio_bytes = -1

        if local_whisper_requested and not legacy_local_stt_allowed:
            logger.error(
                "STT_PROVIDER_UNAVAILABLE provider=local_whisper reason=legacy_local_stt_disabled allowLegacyLocalStt={}",
                legacy_local_stt_allowed,
            )
            raise RuntimeError(
                "LEGACY_LOCAL_STT_DISABLED: set ALLOW_LEGACY_LOCAL_STT=true to use local Whisper"
            )

        if stt_provider == "deepgram" and not deepgram_api_key:
            logger.error(
                "STT_PROVIDER_UNAVAILABLE provider=deepgram reason=missing_api_key fallbackAllowed={} localWhisperEnabled={} allowLegacyLocalStt={}",
                local_whisper_runtime_enabled,
                local_whisper_enabled,
                legacy_local_stt_allowed,
            )
            if not local_whisper_runtime_enabled:
                raise RuntimeError(
                    "DEEPGRAM_STT_CONFIG_MISSING: DEEPGRAM_API_KEY is required when STT_PROVIDER=deepgram"
                )

        # Try Deepgram if configured
        if stt_provider == "deepgram" and deepgram_api_key:
            diagnostic_started_at = time.time()
            requested_language = str(language or "")
            request_id = trace_id or (
                f"job-{meeting_id}" if meeting_id is not None else ""
            )
            effective_diarize = bool(
                settings.enable_speaker_diarization and settings.deepgram_diarize
            )

            def _resolve_batch_failure_diagnostics(
                exc: BaseException,
            ) -> tuple[str, str]:
                timeout_type = "none"
                provider_status = "unavailable"
                seen: set[int] = set()
                current: BaseException | None = exc
                while current is not None and id(current) not in seen:
                    seen.add(id(current))
                    name = type(current).__name__.lower()
                    text = str(current).lower()
                    if timeout_type == "none":
                        if "writetimeout" in name or "write timeout" in text:
                            timeout_type = "write"
                        elif "readtimeout" in name or "read timeout" in text:
                            timeout_type = "read"
                        elif "timeout" in name or "timed out" in text:
                            timeout_type = "timeout"

                    response = getattr(current, "response", None)
                    status_code = getattr(response, "status_code", None)
                    if isinstance(status_code, int):
                        provider_status = str(status_code)
                        break

                    current_status_code = getattr(current, "status_code", None)
                    if isinstance(current_status_code, int):
                        provider_status = str(current_status_code)
                        break

                    current = current.__cause__ or current.__context__
                return timeout_type, provider_status

            try:
                logger.info(
                    "event=BATCH_STT_DIAGNOSTIC_START traceId={} requestId={} jobId={} meetingId={} source=upload requestedLanguage={} effectiveLanguage={} deepgramLanguage={} model={} audioBytes={} deepgramTimeoutSeconds={}",
                    trace_id or "",
                    request_id,
                    meeting_id if meeting_id is not None else "unknown",
                    meeting_id if meeting_id is not None else "unknown",
                    requested_language,
                    deepgram_language,
                    deepgram_language,
                    deepgram_batch_model,
                    audio_bytes,
                    deepgram_timeout_seconds,
                )
                logger.info(
                    "event=BATCH_STT_DIAGNOSTIC_CONFIG traceId={} requestId={} jobId={} meetingId={} source=upload provider=deepgram requestedLanguage={} effectiveLanguage={} deepgramLanguage={} recognitionMode={} model={} endpointing={} detectLanguage={} smartFormat={} utterances={} paragraphs={} diarize={} punctuate={} audioBytes={} deepgramTimeoutSeconds={}",
                    trace_id or "",
                    request_id,
                    meeting_id if meeting_id is not None else "unknown",
                    meeting_id if meeting_id is not None else "unknown",
                    requested_language,
                    deepgram_language,
                    deepgram_language,
                    deepgram_language,
                    deepgram_batch_model,
                    "omitted",
                    False,
                    bool(getattr(settings, "deepgram_smart_format", True)),
                    bool(getattr(settings, "deepgram_utterances", True)),
                    bool(getattr(settings, "deepgram_paragraphs", True)),
                    effective_diarize,
                    "omitted",
                    audio_bytes,
                    deepgram_timeout_seconds,
                )
                log_parts = [
                    (
                        f"jobId={meeting_id}"
                        if meeting_id is not None
                        else "jobId=unknown"
                    ),
                ]
                if trace_id:
                    log_parts.append(f"traceId={trace_id}")
                log_parts.extend(
                    [
                        f"model={deepgram_batch_model}",
                        f"language={deepgram_language}",
                        f"audioBytes={audio_bytes}",
                        f"deepgramTimeoutSeconds={deepgram_timeout_seconds}",
                    ]
                )
                logger.info("BATCH_STT_EFFECTIVE_CONFIG " + " ".join(log_parts))
                logger.info(
                    f"STT_PROVIDER_SELECTED provider=deepgram model={deepgram_batch_model} language={deepgram_language}"
                )
                deepgram_adapter = DeepgramSTTAdapter(
                    api_key=deepgram_api_key,
                    model=deepgram_batch_model,
                    base_url=settings.deepgram_base_url,
                    timeout_seconds=deepgram_timeout_seconds,
                    enable_speaker_diarization=settings.enable_speaker_diarization,
                    deepgram_diarize=settings.deepgram_diarize,
                    smart_format=bool(getattr(settings, "deepgram_smart_format", True)),
                    utterances=bool(getattr(settings, "deepgram_utterances", True)),
                    paragraphs=bool(getattr(settings, "deepgram_paragraphs", True)),
                )
                result = deepgram_adapter.batch_transcribe_file(
                    file_path=audio_path,
                    language=deepgram_language,
                    model=deepgram_batch_model,
                )

                transcript_segments = result.get("segments", [])
                transcript_text = " ".join(
                    str(item.get("text", ""))
                    for item in transcript_segments
                    if isinstance(item, dict)
                ).strip()
                logger.info(
                    "event=BATCH_STT_DIAGNOSTIC_COMPLETED traceId={} requestId={} jobId={} meetingId={} source=upload requestedLanguage={} effectiveLanguage={} deepgramLanguage={} model={} transcriptLength={} transcriptHashPrefix={} providerStatus={} errorCode={} timeoutType={} audioBytes={} deepgramTimeoutSeconds={} durationMs={}",
                    trace_id or "",
                    request_id,
                    meeting_id if meeting_id is not None else "unknown",
                    meeting_id if meeting_id is not None else "unknown",
                    requested_language,
                    deepgram_language,
                    deepgram_language,
                    deepgram_batch_model,
                    len(transcript_text),
                    transcript_hash_prefix(transcript_text),
                    "ok",
                    "none",
                    "none",
                    audio_bytes,
                    deepgram_timeout_seconds,
                    int((time.time() - diagnostic_started_at) * 1000),
                )
                logger.info(
                    f"DEEPGRAM_BATCH_SUCCESS segments={len(transcript_segments)}"
                )
                return transcript_segments
            except Exception as e:
                timeout_type, provider_status = _resolve_batch_failure_diagnostics(e)
                provider_error_code = type(e).__name__
                logger.warning(
                    "event=BATCH_STT_DIAGNOSTIC_FAILED traceId={} requestId={} jobId={} meetingId={} source=upload requestedLanguage={} effectiveLanguage={} deepgramLanguage={} model={} providerStatus={} errorCode={} timeoutType={} audioBytes={} deepgramTimeoutSeconds={} durationMs={} error={}",
                    trace_id or "",
                    request_id,
                    meeting_id if meeting_id is not None else "unknown",
                    meeting_id if meeting_id is not None else "unknown",
                    requested_language,
                    deepgram_language,
                    deepgram_language,
                    deepgram_batch_model,
                    provider_status,
                    provider_error_code,
                    timeout_type,
                    audio_bytes,
                    deepgram_timeout_seconds,
                    int((time.time() - diagnostic_started_at) * 1000),
                    safe_error_message(e),
                )
                logger.warning(
                    f"Deepgram batch transcription failed: {repr(e)}. Fallback decision: LOCAL_WHISPER_ENABLED={local_whisper_enabled} ALLOW_LEGACY_LOCAL_STT={legacy_local_stt_allowed}"
                )

                if deepgram_language == "multi":
                    logger.warning(
                        "event=BATCH_STT_FALLBACK_SKIPPED traceId={} requestId={} jobId={} meetingId={} source=upload fallbackSkipped={} fallbackReason={} requestedLanguage={} effectiveLanguage={} deepgramLanguage={} providerStatus={} errorCode={} timeoutType={} audioBytes={} deepgramTimeoutSeconds={}",
                        trace_id or "",
                        request_id,
                        meeting_id if meeting_id is not None else "unknown",
                        meeting_id if meeting_id is not None else "unknown",
                        True,
                        "multi_not_supported_by_local_whisper",
                        requested_language,
                        deepgram_language,
                        deepgram_language,
                        provider_status,
                        provider_error_code,
                        timeout_type,
                        audio_bytes,
                        deepgram_timeout_seconds,
                    )
                    raise RuntimeError(
                        "STT_PROVIDER_UNAVAILABLE: DEEPGRAM_STT_FAILED (fallbackSkipped=true reason=multi_not_supported_by_local_whisper)"
                    ) from e

                if not local_whisper_runtime_enabled:
                    logger.error(
                        "STT_PROVIDER=deepgram but legacy local STT fallback is disabled. Cannot continue."
                    )
                    raise RuntimeError(
                        "DEEPGRAM_STT_FAILED: Deepgram batch failed and legacy local STT fallback disabled"
                    )

                # Fall through to Whisper

        # Fallback to Whisper if enabled or explicitly selected
        if local_whisper_requested or local_whisper_enabled:
            if not legacy_local_stt_allowed:
                logger.error(
                    "STT_PROVIDER_UNAVAILABLE provider=local_whisper reason=legacy_local_stt_disabled localWhisperEnabled={} allowLegacyLocalStt={}",
                    local_whisper_enabled,
                    legacy_local_stt_allowed,
                )
                raise RuntimeError(
                    "LEGACY_LOCAL_STT_DISABLED: set ALLOW_LEGACY_LOCAL_STT=true to use local Whisper"
                )
            if deepgram_language == "multi":
                logger.warning(
                    "event=BATCH_STT_FALLBACK_SKIPPED traceId={} requestId={} jobId={} meetingId={} source=upload fallbackSkipped={} fallbackReason={} requestedLanguage={} effectiveLanguage={} deepgramLanguage={} providerStatus={} errorCode={} timeoutType={} audioBytes={} deepgramTimeoutSeconds={}",
                    trace_id or "",
                    trace_id or (f"job-{meeting_id}" if meeting_id is not None else ""),
                    meeting_id if meeting_id is not None else "unknown",
                    meeting_id if meeting_id is not None else "unknown",
                    True,
                    "multi_not_supported_by_local_whisper",
                    str(language or ""),
                    deepgram_language,
                    deepgram_language,
                    "unavailable",
                    "LOCAL_WHISPER_LANGUAGE_UNSUPPORTED",
                    "none",
                    audio_bytes,
                    deepgram_timeout_seconds,
                )
                raise RuntimeError(
                    "STT_PROVIDER_UNAVAILABLE: LOCAL_WHISPER_LANGUAGE_UNSUPPORTED (language=multi)"
                )
            logger.info(
                f"STT_PROVIDER_SELECTED provider=local_whisper model={settings.whisper_model} language={deepgram_language}"
            )
            self._ensure_speech_recognizer_loaded()

            transcript_result = self.speech_recognizer.transcribe(
                audio_path,
                language=deepgram_language,
                initial_prompt=initial_prompt,
            )
            transcript_segments = self.speech_recognizer.format_transcript(
                transcript_result
            )
            logger.info(f"WHISPER_BATCH_SUCCESS segments={len(transcript_segments)}")
            return transcript_segments

        # No provider available
        raise RuntimeError(
            f"No STT provider available: STT_PROVIDER={stt_provider}, "
            f"DEEPGRAM_API_KEY_PRESENT={bool(deepgram_api_key)}, "
            f"LOCAL_WHISPER_ENABLED={local_whisper_enabled}, "
            f"ALLOW_LEGACY_LOCAL_STT={legacy_local_stt_allowed}"
        )

    def _normalize_batch_language(self, language: Optional[str]) -> str:
        candidate = (language or "").strip().lower()
        if candidate in ALLOWED_BATCH_LANGUAGES:
            return candidate
        return "vi"

    def process_meeting(
        self,
        audio_path: str,
        meeting_id: int,
        db: Session,
        topic: Optional[str] = None,
        glossary_terms: Optional[List[str]] = None,
        glossary_context: Optional[Dict] = None,
        language: Optional[str] = "vi",
        precomputed_transcript_segments: Optional[List[Dict]] = None,
        trace_id: Optional[str] = None,
        analysis_mode: str = "auto",
        requested_by: Optional[str] = None,
        rerun_reason: Optional[str] = None,
        owner_user_id: Optional[int] = None,
        domain_mode: Optional[str] = None,
    ) -> Dict:
        """
        Complete processing pipeline for a meeting

        Pipeline:
        1. Load and preprocess audio
        2. Speech-to-text transcription
        3. Speaker diarization
        4. Align transcript with speakers
        5. AI analysis
        6. Save to database

        Args:
            audio_path: Path to audio file
            meeting_id: Meeting ID from meeting-service
            db: Database session

        Returns:
            Processing result dictionary
        """
        active_analysis_run = None
        cost_guard = None
        cost_reservation = None
        analysis_persisted = False
        enhanced_path: Path | None = None
        try:
            logger.info(f"Starting processing pipeline for meeting {meeting_id}")
            runtime_device = get_runtime_device()
            self._ensure_models_loaded()
            resolved_audio_path = self._resolve_audio_path(audio_path)
            native_deepgram_diarization = self._should_use_native_deepgram_diarization()
            local_diarization_will_run = bool(
                self._should_enable_diarization(runtime_device)
                and not native_deepgram_diarization
                and self.diarization_available
                and self.speaker_diarizer is not None
            )
            should_enhance_audio = bool(
                settings.audio_enhancement_enabled
                and (
                    precomputed_transcript_segments is None
                    or local_diarization_will_run
                )
            )
            prepared_audio_path = Path(resolved_audio_path)
            if should_enhance_audio:
                prepared_audio_path, enhanced_path = prepare_audio_for_stt(
                    resolved_audio_path,
                    enabled=True,
                    provider_name=settings.audio_enhancement_provider,
                    keep_enhanced=settings.audio_keep_enhanced_file,
                    timeout_seconds=settings.audio_enhancement_timeout_seconds,
                    temp_dir=Path(settings.temp_storage_path),
                )
            else:
                logger.info(
                    "AUDIO_ENHANCEMENT_SKIPPED meetingId={} reason={}",
                    meeting_id,
                    (
                        "disabled"
                        if not settings.audio_enhancement_enabled
                        else "precomputed_transcript_without_local_diarization"
                    ),
                )
            glossary_context = glossary_context or {}
            effective_glossary_terms = self._normalize_glossary_terms(
                glossary_context.get("terms"),
                glossary_terms,
            )

            self._record_baseline_snapshot(meeting_id, runtime_device)

            # Step 1: Load audio
            logger.info("Step 1: Loading audio")
            try:
                self.audio_processor.load_audio(resolved_audio_path)
            except Exception as e:
                logger.warning(
                    f"Step 1 failed but pipeline will continue with Whisper direct input: {repr(e)}"
                )

            # Step 2: Speech-to-text
            logger.info("Step 2: Speech recognition")
            if precomputed_transcript_segments is not None:
                transcript_segments = list(precomputed_transcript_segments)
                logger.info(
                    f"Using precomputed transcript segments from chunk fan-out: {len(transcript_segments)}"
                )
            else:
                initial_prompt = self._build_initial_prompt(
                    topic=topic,
                    glossary_terms=effective_glossary_terms,
                    topic_defaults=glossary_context.get("topic_defaults"),
                )
                logger.info(
                    "Initial STT prompt prepared length={} glossary_term_count={}",
                    len(initial_prompt),
                    len(effective_glossary_terms),
                )

                transcript_segments = self._transcribe_with_provider_selection(
                    audio_path=str(prepared_audio_path),
                    language=language,
                    initial_prompt=initial_prompt,
                    meeting_id=meeting_id,
                    trace_id=trace_id,
                )
                transcript_segments = self._normalize_transcript_segments(
                    transcript_segments,
                    topic=topic,
                    glossary_terms=effective_glossary_terms,
                    glossary_normalization_map=glossary_context.get(
                        "normalization_map"
                    ),
                )

            logger.info(f"Transcription complete: {len(transcript_segments)} segments")

            diarization_enabled = (
                self._should_enable_diarization(runtime_device)
                and self.diarization_available
            )
            if native_deepgram_diarization:
                logger.info("Step 3/4: Native Deepgram speaker diarization enabled")
                aligned_segments = self._normalize_speaker_labels(transcript_segments)
                speaker_count = (
                    len(
                        {
                            str(segment.get("speaker") or "SPEAKER_1")
                            for segment in aligned_segments
                        }
                    )
                    or 1
                )
                logger.info(f"Diarization complete: {speaker_count} speakers detected")
            elif diarization_enabled and self.speaker_diarizer is not None:
                # Step 3: Speaker diarization
                logger.info("Step 3: Speaker diarization")
                diarization = self.speaker_diarizer.diarize(str(prepared_audio_path))
                speaker_segments = self.speaker_diarizer.format_diarization(diarization)

                speaker_count = self.speaker_diarizer.get_speaker_count(diarization)
                logger.info(f"Diarization complete: {speaker_count} speakers detected")

                # Step 4: Align transcript with speakers
                logger.info("Step 4: Aligning transcript with speakers")
                aligned_segments = self.speaker_diarizer.align_transcript_with_speakers(
                    transcript_segments, speaker_segments
                )
                aligned_segments = self._normalize_speaker_labels(aligned_segments)
            else:
                logger.info("Step 3/4: Speaker diarization disabled (low-memory mode)")
                speaker_count = 1
                aligned_segments = [
                    {
                        "speaker": "SPEAKER_1",
                        "start": seg["start"],
                        "end": seg["end"],
                        "text": seg["text"],
                    }
                    for seg in transcript_segments
                ]

            if enhanced_path is not None and not settings.audio_keep_enhanced_file:
                try:
                    enhanced_path.unlink(missing_ok=True)
                except OSError:
                    logger.warning(
                        "AUDIO_ENHANCEMENT_CLEANUP_FAILED meetingId={} file={}",
                        meeting_id,
                        enhanced_path.name,
                    )

            aligned_segments = self._deduplicate_repeated_segments(aligned_segments)
            aligned_segments = assign_stable_segment_ids(meeting_id, aligned_segments)

            # Persist transcript before Gemini so analysis failures still leave
            # rerunable saved transcript for "Phân tích lại".
            self._persist_aligned_transcript_segments(meeting_id, aligned_segments, db)
            db.commit()
            logger.info(
                "event=BATCH_TRANSCRIPT_PERSISTED_BEFORE_ANALYSIS meetingId={} segments={}",
                meeting_id,
                len(aligned_segments),
            )

            # Step 5: AI Analysis
            logger.info("Step 5: AI analysis")
            mode = normalize_analysis_mode(analysis_mode)
            normalized_domain, domain_payload = merge_domain_analysis_payload(
                domain_mode,
                default_domain=self.ai_analyzer.analysis_domain_mode,
            )
            formatted_transcript = format_aligned_transcript_for_analysis(
                aligned_segments
            )
            analysis_identity = build_analysis_cache_identity(
                db=db,
                meeting_id=meeting_id,
                analyzer=self.ai_analyzer,
                fallback_transcript_hash=None,
                fallback_text=formatted_transcript,
                analysis_payload=domain_payload,
                recognition_mode=_normalized_stt_provider(),
                transcript_language=self._normalize_batch_language(language),
                normalized_domain_mode=normalized_domain,
            )
            cached_analysis_run = (
                None
                if mode == ANALYSIS_MODE_FORCE
                else find_completed_analysis_run_for_identity(db, analysis_identity)
            )
            if cached_analysis_run is not None:
                gemini_metrics.cache_hit()
                logger.info(
                    "ANALYSIS_CACHE_HIT meetingId={} provider={} model={} promptVersion={} schemaVersion={} canonicalTranscriptHash={} canonicalTranscriptVersion={} analysisInputMode={}",
                    meeting_id,
                    analysis_identity.provider,
                    analysis_identity.model,
                    analysis_identity.prompt_version,
                    analysis_identity.schema_version,
                    analysis_identity.canonical_transcript_hash,
                    analysis_identity.canonical_transcript_version,
                    analysis_identity.analysis_input_mode,
                )
                analysis_result = analysis_payload_from_run(
                    cached_analysis_run, cache_hit=True
                )
            else:
                in_progress_run = find_in_progress_analysis_run_for_identity(
                    db, analysis_identity
                )
                if in_progress_run is not None:
                    run_metadata = analysis_run_response_metadata(
                        in_progress_run, cache_hit=False
                    )
                    return {
                        "meeting_id": meeting_id,
                        "status": "analyzing",
                        "transcript_segments": len(aligned_segments),
                        "speaker_count": speaker_count,
                        "diarization_enabled": diarization_enabled,
                        "analysis": run_metadata,
                    }

                if mode == ANALYSIS_MODE_CACHE_ONLY:
                    miss_metadata = analysis_miss_response_metadata(
                        db, analysis_identity
                    )
                    return {
                        "meeting_id": meeting_id,
                        "status": str(
                            miss_metadata.get("analysisStatus") or "NO_ANALYSIS"
                        ).lower(),
                        "transcript_segments": len(aligned_segments),
                        "speaker_count": speaker_count,
                        "diarization_enabled": diarization_enabled,
                        "analysis": miss_metadata,
                    }

                if mode == ANALYSIS_MODE_FAILED_RETRY:
                    retry_run = find_latest_analysis_run_for_identity(
                        db, analysis_identity
                    )
                    if retry_run is not None and not is_analysis_run_retryable(
                        retry_run
                    ):
                        # Completed/skipped/in-progress: do not re-run under
                        # failed_retry. None (never analyzed) falls through so
                        # background recovery can analyze after EMPTY_TRANSCRIPT.
                        miss_metadata = analysis_miss_response_metadata(
                            db, analysis_identity
                        )
                        return {
                            "meeting_id": meeting_id,
                            "status": str(
                                miss_metadata.get("analysisStatus") or "NO_ANALYSIS"
                            ).lower(),
                            "transcript_segments": len(aligned_segments),
                            "speaker_count": speaker_count,
                            "diarization_enabled": diarization_enabled,
                            "analysis": miss_metadata,
                        }

                active_analysis_run, began_run = begin_analysis_run(
                    db=db,
                    identity=analysis_identity,
                    mode=mode,
                    requested_by=requested_by or "batch",
                    rerun_reason=rerun_reason,
                )
                db.commit()
                if (
                    not began_run
                    and active_analysis_run.status == ANALYSIS_STATUS_ANALYZING
                ):
                    run_metadata = analysis_run_response_metadata(
                        active_analysis_run, cache_hit=False
                    )
                    return {
                        "meeting_id": meeting_id,
                        "status": "analyzing",
                        "transcript_segments": len(aligned_segments),
                        "speaker_count": speaker_count,
                        "diarization_enabled": diarization_enabled,
                        "analysis": run_metadata,
                    }
                if not began_run:
                    if active_analysis_run.status == "COMPLETED":
                        return {
                            "meeting_id": meeting_id,
                            "status": "completed",
                            "transcript_segments": len(aligned_segments),
                            "speaker_count": speaker_count,
                            "diarization_enabled": diarization_enabled,
                            "analysis": analysis_payload_from_run(
                                active_analysis_run, cache_hit=True
                            ),
                        }
                    return {
                        "meeting_id": meeting_id,
                        "status": "failed",
                        "transcript_segments": len(aligned_segments),
                        "speaker_count": speaker_count,
                        "diarization_enabled": diarization_enabled,
                        "analysis": analysis_run_response_metadata(
                            active_analysis_run, cache_hit=False
                        ),
                    }

                logger.info(
                    "ANALYSIS_CACHE_MISS meetingId={} provider={} model={} promptVersion={} schemaVersion={} canonicalTranscriptHash={} canonicalTranscriptVersion={} analysisInputMode={}",
                    meeting_id,
                    analysis_identity.provider,
                    analysis_identity.model,
                    analysis_identity.prompt_version,
                    analysis_identity.schema_version,
                    analysis_identity.canonical_transcript_hash,
                    analysis_identity.canonical_transcript_version,
                    analysis_identity.analysis_input_mode,
                )
                from app.config import get_settings
                from app.services.transcript_quality_gate import (
                    evaluate_transcript_quality,
                )

                quality_verdict = evaluate_transcript_quality(
                    formatted_transcript,
                    transcript_rows=len(aligned_segments),
                    enabled=get_settings().analysis_short_transcript_gate_enabled,
                )
                if not quality_verdict.should_analyze:
                    logger.info(
                        "ANALYSIS_SKIPPED_SHORT_TRANSCRIPT meetingId={} normalizedChars={} wordCount={} skipReason={}",
                        meeting_id,
                        quality_verdict.normalized_chars,
                        quality_verdict.word_count,
                        quality_verdict.skip_reason,
                    )
                    mark_analysis_run_skipped_short(
                        run=active_analysis_run,
                        error_code=quality_verdict.skip_reason
                        or "ANALYSIS_SKIPPED_SHORT_TRANSCRIPT",
                        analysis_input_hash=analysis_identity.canonical_transcript_hash,
                    )
                    db.commit()
                    run_metadata = analysis_run_response_metadata(
                        active_analysis_run, cache_hit=False
                    )
                    return {
                        "meeting_id": meeting_id,
                        "status": "completed",
                        "transcript_segments": len(aligned_segments),
                        "speaker_count": speaker_count,
                        "diarization_enabled": diarization_enabled,
                        "analysis": run_metadata,
                    }
                from app.services.user_quota_client import enforce_gemini_quota

                enforce_gemini_quota(owner_user_id, formatted_transcript)
                allowed_segment_ids = sorted(
                    collect_allowed_segment_ids(aligned_segments)
                )
                analysis_metadata = {
                    "source": "upload",
                    "domainMode": normalized_domain,
                    "meetingId": meeting_id,
                    "allowedSegmentIds": allowed_segment_ids,
                    "language": language,
                }
                if (
                    settings.gemini_cost_guard_enabled
                    and getattr(self.ai_analyzer, "provider", "") == "gemini"
                ):
                    try:
                        cost_guard_redis = _get_client()
                    except Exception as redis_error:
                        logger.warning(
                            "GEMINI_COST_GUARD_UNAVAILABLE workload=structured_analysis error_type={} fail_closed=true",
                            type(redis_error).__name__,
                        )
                        cost_guard_redis = None
                    cost_guard = GeminiCostGuard(
                        cost_guard_redis,
                        namespace=settings.gemini_cost_guard_namespace,
                        daily_request_limit_per_user=(
                            settings.gemini_daily_request_limit_per_user
                        ),
                        daily_reanalysis_limit_per_meeting=(
                            settings.gemini_daily_reanalyze_limit_per_meeting
                        ),
                        daily_token_limit_per_user=(
                            settings.gemini_daily_token_limit_per_user
                        ),
                        max_concurrent_requests=(
                            settings.gemini_max_concurrent_requests
                        ),
                    )
                    cost_reservation = cost_guard.reserve(
                        user_id=owner_user_id or "internal-default",
                        meeting_id=meeting_id,
                        operation_id=active_analysis_run.idempotency_key,
                        estimated_tokens=(
                            estimate_text_tokens(formatted_transcript)
                            + settings.gemini_structured_analysis_max_output_tokens
                        ),
                        is_reanalysis=mode == ANALYSIS_MODE_FORCE,
                    )
                    if not cost_reservation.allowed:
                        if cost_reservation.duplicate:
                            gemini_metrics.duplicate_suppressed()
                            return {
                                "meeting_id": meeting_id,
                                "status": "analyzing",
                                "transcript_segments": len(aligned_segments),
                                "speaker_count": speaker_count,
                                "diarization_enabled": diarization_enabled,
                                "analysis": analysis_run_response_metadata(
                                    active_analysis_run, cache_hit=False
                                ),
                            }
                        error_code = (
                            "GEMINI_COST_GUARD_UNAVAILABLE"
                            if cost_reservation.reason == "guard_unavailable"
                            else "GEMINI_COST_LIMIT_EXCEEDED"
                        )
                        gemini_metrics.failure(error_code)
                        raise AnalysisUnavailableError(
                            "Gemini request blocked by the distributed cost guard",
                            provider="gemini",
                            error_code=error_code,
                            retryable=False,
                        )
                analysis_result = self.ai_analyzer.analyze_meeting(
                    formatted_transcript,
                    metadata=analysis_metadata,
                )

            # Step 6: Save to database
            logger.info("Step 6: Saving to database")
            analysis_metadata = self._save_results(
                meeting_id,
                aligned_segments,
                analysis_result,
                db,
                glossary_context=glossary_context,
                language=language,
                analysis_input_text=formatted_transcript,
                cached_analysis_run=cached_analysis_run,
                analysis_run=active_analysis_run,
                requested_by=requested_by,
                rerun_reason=rerun_reason,
            )
            if analysis_metadata:
                analysis_result = dict(analysis_result or {})
                analysis_result.update(analysis_metadata)
            analysis_persisted = True

            logger.info(f"Processing complete for meeting {meeting_id}")

            return {
                "meeting_id": meeting_id,
                "status": "completed",
                "transcript_segments": len(aligned_segments),
                "speaker_count": speaker_count,
                "diarization_enabled": diarization_enabled,
                "analysis": analysis_result,
            }

        except Exception as e:
            if active_analysis_run is not None:
                provider_error_code = (
                    str(getattr(e, "error_code", None) or "").strip()
                    or type(e).__name__
                )
                if str(getattr(e, "provider", "")).strip().lower() == "gemini":
                    gemini_metrics.failure(provider_error_code)
                mark_analysis_run_failed(
                    run=active_analysis_run,
                    error_code=provider_error_code,
                    error_message=safe_error_message(e),
                )
                db.commit()
            logger.exception(
                f"Processing pipeline error for meeting {meeting_id}: {repr(e)}"
            )
            raise
        finally:
            if cost_guard is not None:
                cost_guard.release(cost_reservation, success=analysis_persisted)
            if enhanced_path is not None and not settings.audio_keep_enhanced_file:
                try:
                    enhanced_path.unlink(missing_ok=True)
                except OSError:
                    logger.warning(
                        "AUDIO_ENHANCEMENT_CLEANUP_FAILED meetingId={} file={}",
                        meeting_id,
                        enhanced_path.name,
                    )

    def _persist_aligned_transcript_segments(
        self,
        meeting_id: int,
        aligned_segments: List[Dict],
        db: Session,
    ) -> None:
        """Persist aligned STT segments independently of analysis success."""

        def _to_builtin(value):
            if value is None or isinstance(value, (str, int, float, bool, datetime)):
                return value
            if hasattr(value, "item"):
                try:
                    return _to_builtin(value.item())
                except Exception:
                    pass
            if isinstance(value, dict):
                return {str(k): _to_builtin(v) for k, v in value.items()}
            if isinstance(value, (list, tuple)):
                return [_to_builtin(v) for v in value]
            return str(value)

        transcript_repository = TranscriptPersistenceRepository(db)
        for index, segment in enumerate(aligned_segments, start=1):
            seq_raw = segment.get("seq")
            seq = int(_to_builtin(seq_raw)) if seq_raw is not None else index
            if seq <= 0:
                seq = index
            fragment_input = TranscriptFragmentInput(
                meeting_id=meeting_id,
                seq=seq,
                speaker=str(segment.get("speaker", "UNKNOWN")),
                start_time=float(_to_builtin(segment.get("start", 0.0))),
                end_time=float(_to_builtin(segment.get("end", 0.0))),
                text=str(segment.get("text", "")),
                event_id=(
                    str(segment.get("segment_id") or segment.get("event_id"))
                    if (segment.get("segment_id") or segment.get("event_id"))
                    else None
                ),
                # Batch STT segments are complete once aligned.
                is_final=bool(segment.get("is_final", True)),
                confidence=(
                    float(_to_builtin(segment.get("confidence")))
                    if segment.get("confidence") is not None
                    else None
                ),
            )
            transcript_repository.append_fragment(fragment_input)

    def _save_results(
        self,
        meeting_id: int,
        aligned_segments: List[Dict],
        analysis_result: Dict,
        db: Session,
        glossary_context: Optional[Dict] = None,
        language: Optional[str] = None,
        analysis_input_text: Optional[str] = None,
        cached_analysis_run=None,
        analysis_run=None,
        requested_by: Optional[str] = None,
        rerun_reason: Optional[str] = None,
    ) -> dict:
        """
        Save processing results to database

        Args:
            meeting_id: Meeting ID
            aligned_segments: Aligned transcript segments
            analysis_result: AI analysis results
            db: Database session
        """
        try:

            def _to_builtin(value):
                if value is None or isinstance(
                    value, (str, int, float, bool, datetime)
                ):
                    return value

                # numpy scalar types support .item()
                if hasattr(value, "item"):
                    try:
                        return _to_builtin(value.item())
                    except Exception:
                        pass

                if isinstance(value, dict):
                    return {str(k): _to_builtin(v) for k, v in value.items()}

                if isinstance(value, (list, tuple)):
                    return [_to_builtin(v) for v in value]

                return str(value)

            # Save transcripts (idempotent via fragment dedupe if already
            # persisted before analysis).
            self._persist_aligned_transcript_segments(meeting_id, aligned_segments, db)

            # Save analysis
            clean_analysis = _to_builtin(analysis_result or {})
            readable_transcript_text = "\n".join(
                str(segment.get("text", "")) for segment in aligned_segments
            )
            analysis_input_text = str(analysis_input_text or readable_transcript_text)
            if self.ai_analyzer is not None:
                clean_analysis = self.ai_analyzer.prepare_analysis_for_storage(
                    transcript=analysis_input_text,
                    data=clean_analysis,
                )

            clean_keywords = clean_analysis.get("keywords", [])
            clean_technical_terms = clean_analysis.get("technical_terms", [])
            if self.ai_analyzer is not None:
                clean_technical_terms = self.ai_analyzer.sanitize_technical_terms(
                    transcript=analysis_input_text,
                    technical_terms=clean_technical_terms,
                    keywords=clean_keywords,
                )
            transcript_hash = (
                hashlib.sha256(analysis_input_text.encode("utf-8")).hexdigest()
                if analysis_input_text.strip()
                else None
            )
            prompt_version = str(
                clean_analysis.get("promptVersion")
                or getattr(self.ai_analyzer, "PROMPT_VERSION", "")
                or ""
            ).strip()
            schema_version = str(
                clean_analysis.get("schemaVersion")
                or getattr(self.ai_analyzer, "SCHEMA_VERSION", "")
                or ""
            ).strip()
            technical_terms_payload: object = clean_technical_terms
            if isinstance(clean_analysis, dict):
                technical_terms_payload = {
                    "technical_terms": clean_technical_terms,
                    "technicalTerms": clean_analysis.get("technicalTerms", []),
                    "painPoints": clean_analysis.get("painPoints", []),
                    "meetingSummary": str(
                        clean_analysis.get("meetingSummary")
                        or clean_analysis.get("summary")
                        or ""
                    ).strip(),
                    "keyDecisions": clean_analysis.get("keyDecisions", []),
                    "risks": clean_analysis.get("risks", []),
                    "blockers": clean_analysis.get("blockers", []),
                    "questions": clean_analysis.get("questions", []),
                    "deadlines": clean_analysis.get("deadlines", []),
                    "owners": clean_analysis.get("owners", []),
                    "nextSteps": clean_analysis.get("nextSteps", []),
                    "businessImpact": str(clean_analysis.get("businessImpact") or ""),
                    "customerImpact": str(clean_analysis.get("customerImpact") or ""),
                    "technicalImpact": str(clean_analysis.get("technicalImpact") or ""),
                    "confidence": clean_analysis.get("confidence"),
                    "domainMode": str(
                        clean_analysis.get("domainMode")
                        or clean_analysis.get("domain_mode")
                        or "it"
                    ),
                    "transcript_hash": str(
                        clean_analysis.get("transcriptHash") or transcript_hash or ""
                    ).strip()
                    or None,
                    "promptVersion": prompt_version or None,
                    "schemaVersion": schema_version or None,
                    "source": str(clean_analysis.get("source") or "batch"),
                }
                if isinstance(clean_analysis.get("educationStudy"), dict):
                    technical_terms_payload["educationStudy"] = clean_analysis[
                        "educationStudy"
                    ]
                if clean_analysis.get("evidenceUnavailable") is True:
                    technical_terms_payload["evidenceUnavailable"] = True
                if clean_analysis.get("analysisFeatureSet"):
                    technical_terms_payload["analysisFeatureSet"] = clean_analysis[
                        "analysisFeatureSet"
                    ]
                if clean_analysis.get("groupedActionPlan") is not None:
                    technical_terms_payload["groupedActionPlan"] = clean_analysis[
                        "groupedActionPlan"
                    ]
            analysis_run_payload = dict(clean_analysis)
            analysis_run_payload["transcriptHash"] = (
                str(
                    clean_analysis.get("transcriptHash") or transcript_hash or ""
                ).strip()
                or None
            )
            analysis_run_payload["promptVersion"] = prompt_version or None
            analysis_run_payload["schemaVersion"] = schema_version or None
            analysis_run_payload["source"] = str(
                clean_analysis.get("source") or "batch"
            )
            analysis = (
                db.query(Analysis).filter(Analysis.meeting_id == meeting_id).first()
            )
            if analysis is None:
                analysis = Analysis(meeting_id=meeting_id)
                db.add(analysis)
            analysis.summary = str(clean_analysis.get("summary", ""))
            analysis.keywords = clean_keywords
            analysis.technical_terms = technical_terms_payload
            analysis.action_items = clean_analysis.get("action_items", [])
            analysis.glossary_domain = (glossary_context or {}).get("domain")
            analysis.glossary_version_id = (glossary_context or {}).get("version_id")
            analysis.glossary_version_hash = (glossary_context or {}).get(
                "version_hash"
            )
            if cached_analysis_run is not None:
                run_metadata = analysis_run_response_metadata(
                    cached_analysis_run, cache_hit=True
                )
            else:
                analysis_run = persist_completed_analysis_run(
                    db=db,
                    meeting_id=meeting_id,
                    analyzer=self.ai_analyzer,
                    analysis_payload=analysis_run_payload,
                    summary=analysis.summary,
                    fallback_transcript_hash=transcript_hash,
                    fallback_text=analysis_input_text,
                    recognition_mode=_normalized_stt_provider(),
                    transcript_language=self._normalize_batch_language(language),
                    requested_by=requested_by,
                    rerun_reason=rerun_reason,
                    run=analysis_run,
                )
                run_metadata = analysis_run_response_metadata(
                    analysis_run, cache_hit=False
                )

            # Commit
            db.commit()

            logger.info(
                f"Saved {len(aligned_segments)} transcript segments and analysis"
            )
            logger.info(f"ANALYSIS_SAVED meetingId={meeting_id}")
            return run_metadata

        except Exception as e:
            db.rollback()
            logger.error(f"Database save error: {e}")
            raise

    def get_transcript(self, meeting_id: int, db: Session) -> List[Transcript]:
        """
        Retrieve transcript for a meeting

        Args:
            meeting_id: Meeting ID
            db: Database session

        Returns:
            List of transcript segments
        """
        fragment_rows = (
            db.query(TranscriptFragment)
            .filter(TranscriptFragment.meeting_id == meeting_id)
            .order_by(
                TranscriptFragment.seq.asc(),
                TranscriptFragment.version.asc(),
                TranscriptFragment.created_at.asc(),
            )
            .all()
        )
        if fragment_rows:
            # When live fragments exist, prefer fragments (raw) as before
            return fragment_rows

        transcripts = (
            db.query(Transcript)
            .filter(Transcript.meeting_id == meeting_id)
            .order_by(Transcript.start_time)
            .all()
        )

        return transcripts

    def get_analysis(self, meeting_id: int, db: Session) -> Analysis:
        """
        Retrieve analysis for a meeting

        Args:
            meeting_id: Meeting ID
            db: Database session

        Returns:
            Analysis object
        """
        analysis = db.query(Analysis).filter(Analysis.meeting_id == meeting_id).first()

        return analysis
