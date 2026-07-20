from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

from pydantic import AliasChoices, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        case_sensitive=False,
        extra="ignore",
    )

    app_env: str = "development"
    # api | worker | beat — beat is broker-only and must not require DB/provider secrets.
    app_component: str = "api"

    # Database
    database_url: str = "postgresql://postgres:postgres@db:5432/audiomind"

    # Gemini
    gemini_api_key: str = ""
    gemini_api_keys: str = ""
    gemini_multi_key_enabled: bool = False
    gemini_shared_cooldown_enabled: bool = False
    gemini_shared_state_namespace: str = ""
    gemini_model_unsupported_ttl_seconds: int = 21600
    gemini_max_attempts: int = 3
    gemini_key_cooldown_seconds: float = 90.0
    gemini_key_hard_cooldown_seconds: float = 900.0
    gemini_backoff_base_ms: float = 500.0
    gemini_backoff_max_ms: float = 10000.0
    gemini_backoff_jitter: bool = True
    gemini_fail_fast_seconds: float = 30.0
    gemini_analysis_model: str = "gemini-2.5-flash"
    gemini_summary_model: str = "gemini-2.5-flash"
    gemini_analysis_domain_mode: str = "it"
    gemini_analysis_max_input_tokens: int = 12000
    gemini_analysis_max_output_tokens: int = 8192
    gemini_analysis_thinking_budget: int = 0
    gemini_analysis_retry_max_attempts: int = 3
    gemini_timeout_seconds: int = 300
    gemini_rate_limit_retry_base_seconds: float = 30.0
    gemini_rate_limit_retry_max_seconds: float = 90.0
    gemini_retry_quota_exceeded: bool = False
    gemini_max_tokens_retry_enabled: bool = True
    gemini_max_single_request_chars: int = 50000
    gemini_request_delay_seconds: float = 15.0
    gemini_http_proxy: str = ""

    # Analysis recovery (PR2)
    analysis_background_retry_enabled: bool = True
    analysis_background_retry_max_attempts: int = 4
    analysis_short_transcript_gate_enabled: bool = True
    gemini_client_test_mode: str = ""
    internal_api_base_url: str = "http://127.0.0.1:8000"
    user_api_base_url: str = Field(
        default="http://user-api:8083",
        validation_alias=AliasChoices(
            "USER_API_BASE_URL",
            "AUDIOMIND_USER_API_BASE_URL",
        ),
    )
    internal_service_token: str = Field(
        default="",
        validation_alias=AliasChoices(
            "INTERNAL_SERVICE_TOKEN",
            "GOOGLE_INTERNAL_SERVICE_TOKEN",
        ),
    )
    quota_fail_open: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "QUOTA_FAIL_OPEN",
        ),
    )

    # Deepgram
    deepgram_api_key: str = ""
    deepgram_model: str = "nova-3"
    deepgram_realtime_model: str = "nova-3"
    deepgram_batch_model: str = "nova-3"
    deepgram_language: str = "vi"
    deepgram_smart_format: bool = True
    deepgram_utterances: bool = True
    deepgram_paragraphs: bool = True
    deepgram_base_url: str = "https://api.deepgram.com/v1/listen"
    deepgram_timeout_seconds: int = 30
    deepgram_simplify_streaming_url: bool = False
    deepgram_debug_raw_messages: bool = False
    deepgram_diarize: bool = False
    deepgram_realtime_endpointing_default: str | None = None
    deepgram_realtime_endpointing_vi: str | None = None
    deepgram_realtime_endpointing_en: str | None = None
    deepgram_realtime_endpointing_multi: str | None = None
    deepgram_endpointing: str | None = None

    # Provider selection (MVP defaults)
    stt_provider: str = "deepgram"
    analysis_provider: str = "gemini"
    ai_provider: str = "gemini"  # Backward-compatible legacy setting.
    local_whisper_enabled: bool = False
    ollama_enabled: bool = False
    allow_legacy_local_stt: bool = False
    allow_legacy_local_ai: bool = False

    # Ollama (local LLM)
    ollama_base_url: str = "http://ollama-service:11434"
    ollama_model: str = "qwen2.5:3b-instruct"
    ollama_timeout_seconds: int = 300

    # Hugging Face
    huggingface_token: str = ""

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    cors_allowed_origins: str = "http://localhost:5173"
    max_upload_size_bytes: int = 524288000
    allowed_upload_extensions: str = ".wav,.mp3,.m4a,.aac,.flac,.ogg,.webm,.mp4"
    upload_validation_strict: bool = False
    mime_sniff_enabled: bool = False
    realtime_validation_enabled: bool = False

    # Storage
    audio_storage_path: str = "./storage/audio"
    temp_storage_path: str = "./storage/temp"
    # Comma-separated absolute/relative roots for final-audio-fallback paths.
    # When set, this list is the exact allowlist (defaults are not merged).
    # When empty, defaults include /app/uploads, /app/storage/uploads,
    # ./storage/uploads plus configured audio/temp storage paths.
    final_audio_allowed_roots: str = ""

    # Optional FFmpeg audio enhancement (STT profile only in this release)
    audio_enhancement_enabled: bool = False
    audio_enhancement_provider: str = "ffmpeg"
    audio_enhancement_timeout_seconds: int = 120
    audio_keep_enhanced_file: bool = False

    # Model Settings
    whisper_model: str = "base"
    device: str = "auto"  # auto | cpu | cuda
    enable_speaker_diarization: bool = False
    lazy_load_models: bool = True
    whisper_no_speech_threshold: float = 0.7
    whisper_logprob_threshold: float = -0.8
    whisper_cpu_chunk_seconds: int = 30
    whisper_gpu_chunk_seconds: int = 60

    # Processing
    max_chunk_duration: int = 30
    vad_threshold: float = 0.5
    job_status_ttl_hours: int = 168
    job_state_redis_url: str = "redis://redis:6379/2"
    job_state_ttl_seconds: int = 86400
    chunk_state_ttl_seconds: int = 3600
    redis_max_connections: int = 10
    glossary_cache_ttl_seconds: int = 300

    # Epic 2 — error UX
    error_ux_enabled: bool = True

    # Epic 3 — transcript quality / evidence / lexicon
    transcript_quality_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "EPIC3_TRANSCRIPT_QUALITY_ENABLED",
            "TRANSCRIPT_QUALITY_ENABLED",
        ),
    )
    domain_lexicon_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "EPIC3_DOMAIN_LEXICON_ENABLED",
            "DOMAIN_LEXICON_ENABLED",
        ),
    )
    evidence_qa_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "EPIC3_EVIDENCE_QA_ENABLED",
            "EVIDENCE_QA_ENABLED",
        ),
    )
    search_verify_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "EPIC3_SEARCH_VERIFY_ENABLED",
            "SEARCH_VERIFY_ENABLED",
        ),
    )
    export_verify_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "EPIC3_EXPORT_VERIFY_ENABLED",
            "EXPORT_VERIFY_ENABLED",
        ),
    )

    # Deepgram STT hardening
    stt_audio_queue_max_items: int = 64
    stt_audio_queue_max_bytes: int = 8 * 1024 * 1024
    stt_recv_queue_max_items: int = 256
    stt_recv_queue_max_bytes: int = 4 * 1024 * 1024
    stt_persist_queue_max_items: int = 512
    stt_persist_queue_max_bytes: int = 16 * 1024 * 1024
    stt_enqueue_timeout_seconds: float = 2.0
    stt_gap_timeout_seconds: float = 1.0
    stt_recv_drain_timeout_seconds: float = 0.1
    stt_final_recv_drain_timeout_seconds: float = 2.0
    stt_transient_retry_base_seconds: float = 0.25
    stt_transient_retry_cap_seconds: float = 2.0
    stt_reconnect_budget: int = 2
    stt_reconnect_window_seconds: float = 60.0
    stt_reconnect_cooldown_seconds: float = 60.0
    stt_queue_pressure_ratio: float = 0.85
    stt_overload_policy: str = "drop_newest"
    stt_watchdog_interval_seconds: float = 5.0
    stt_recv_stall_seconds: float = 30.0
    stt_persist_stall_seconds: float = 30.0
    stt_half_open_stall_seconds: float = 15.0
    stt_shutdown_grace_seconds: float = 15.0
    stt_ownership_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "STT_ENABLE_DISTRIBUTED_OWNERSHIP",
            "STT_OWNERSHIP_ENABLED",
        ),
    )
    stt_ownership_redis_url: str = ""
    stt_replica_id: str = ""
    stt_ownership_lease_ttl_seconds: float = 30.0
    stt_ownership_cooldown_ttl_seconds: float = 300.0

    # Async processing
    celery_broker_url: str = "redis://redis:6379/0"
    celery_result_backend: str = "redis://redis:6379/1"
    celery_task_queue: str = "audio_processing"
    celery_task_time_limit_seconds: int = 3600
    celery_task_soft_time_limit_seconds: int = 3300
    celery_chunk_max_retries: int = 5
    celery_main_max_retries: int = 5
    celery_retry_backoff_max_seconds: int = 32
    celery_retry_jitter: bool = True
    celery_prefetch_multiplier: int = 1
    celery_concurrency: int = 4

    # Worker monitor
    timeout_monitor_interval_seconds: int = 60
    timeout_monitor_threshold_seconds: int = 7200
    chunk_processing_stale_seconds: int = 180
    worker_health_port: int = 8080

    @model_validator(mode="after")
    def normalize_provider_settings(self) -> "Settings":
        self.stt_provider = (self.stt_provider or "deepgram").strip().lower()
        if self.stt_provider == "whisper":
            self.stt_provider = "local_whisper"
        if self.stt_provider not in {"deepgram", "local_whisper"}:
            self.stt_provider = "deepgram"

        self.analysis_provider = (self.analysis_provider or "gemini").strip().lower()
        if self.analysis_provider not in {"gemini", "ollama", "local"}:
            self.analysis_provider = "gemini"

        self.gemini_analysis_domain_mode = (
            (self.gemini_analysis_domain_mode or "it").strip().lower()
        )
        if self.gemini_analysis_domain_mode not in {
            "general",
            "it",
            "business",
            "education",
        }:
            self.gemini_analysis_domain_mode = "it"

        self.gemini_analysis_max_input_tokens = max(
            1, int(self.gemini_analysis_max_input_tokens or 12000)
        )
        # Clamp to a sane model budget: avoid tiny wasteful requests and unbounded growth.
        self.gemini_analysis_max_output_tokens = min(
            16384,
            max(1024, int(self.gemini_analysis_max_output_tokens or 8192)),
        )
        self.gemini_analysis_thinking_budget = max(
            0, int(self.gemini_analysis_thinking_budget or 0)
        )
        self.gemini_analysis_retry_max_attempts = max(
            1, int(self.gemini_analysis_retry_max_attempts or 3)
        )
        self.gemini_max_attempts = max(
            1, int(self.gemini_max_attempts or self.gemini_analysis_retry_max_attempts)
        )
        self.gemini_key_cooldown_seconds = max(
            0.0, float(self.gemini_key_cooldown_seconds or 0.0)
        )
        self.gemini_key_hard_cooldown_seconds = max(
            0.0, float(self.gemini_key_hard_cooldown_seconds or 0.0)
        )
        self.gemini_backoff_base_ms = max(
            0.0, float(self.gemini_backoff_base_ms or 0.0)
        )
        self.gemini_backoff_max_ms = max(0.0, float(self.gemini_backoff_max_ms or 0.0))
        self.gemini_fail_fast_seconds = max(
            0.0, float(self.gemini_fail_fast_seconds or 0.0)
        )
        self.gemini_model_unsupported_ttl_seconds = max(
            1, int(self.gemini_model_unsupported_ttl_seconds or 21600)
        )
        self.gemini_timeout_seconds = max(1, int(self.gemini_timeout_seconds or 300))
        self.gemini_rate_limit_retry_base_seconds = max(
            0.0, float(self.gemini_rate_limit_retry_base_seconds or 0.0)
        )
        self.gemini_rate_limit_retry_max_seconds = max(
            0.0, float(self.gemini_rate_limit_retry_max_seconds or 0.0)
        )
        self.analysis_background_retry_max_attempts = max(
            0, int(self.analysis_background_retry_max_attempts or 4)
        )

        # Backward-compatible normalization for legacy variable usage.
        self.ai_provider = (self.ai_provider or "gemini").strip().lower()
        if self.ai_provider not in {"gemini", "ollama", "local"}:
            self.ai_provider = "gemini"

        self.audio_enhancement_provider = (
            (self.audio_enhancement_provider or "").strip().lower()
        )
        if self.audio_enhancement_enabled and self.audio_enhancement_provider not in {
            "",
            "none",
            "ffmpeg",
        }:
            raise ValueError(
                "audio_enhancement_provider must be one of: none, ffmpeg "
                "(elevenlabs and deepfilter are not supported)"
            )
        self.audio_enhancement_timeout_seconds = max(
            1, int(self.audio_enhancement_timeout_seconds or 120)
        )

        return self

    @model_validator(mode="after")
    def validate_production_settings(self) -> "Settings":
        env = (self.app_env or "").strip().lower()
        if env not in {"prod", "production"}:
            return self

        # Celery Beat schedules only; it must start without DATABASE_URL / Gemini / Deepgram.
        if (self.app_component or "").strip().lower() == "beat":
            return self

        def _is_local(value: str | None) -> bool:
            if not value:
                return True
            parsed = urlparse(value)
            host = (parsed.hostname or "").strip().lower()
            raw = value.strip().lower()
            return (
                host in {"localhost", "127.0.0.1", "0.0.0.0", "::1"}
                or "localhost" in raw
            )

        if (
            _is_local(self.database_url)
            or "postgres:postgres@" in self.database_url.lower()
        ):
            raise ValueError(
                "Invalid production database_url: localhost/default credentials are not allowed"
            )

        if _is_local(self.ollama_base_url):
            raise ValueError(
                "Invalid production ollama_base_url: localhost is not allowed"
            )

        if "localhost" in (self.cors_allowed_origins or "").lower():
            raise ValueError(
                "Invalid production cors_allowed_origins: localhost is not allowed"
            )

        if (
            self.analysis_provider == "gemini"
            and not (self.gemini_api_key or "").strip()
            and not (
                bool(self.gemini_multi_key_enabled)
                and (self.gemini_api_keys or "").strip()
            )
        ):
            raise ValueError(
                "Invalid production gemini_api_key: empty secret is not allowed when analysis_provider=gemini"
            )

        native_deepgram_diarization_enabled = bool(
            self.enable_speaker_diarization and self.deepgram_diarize
        )
        if (
            self.enable_speaker_diarization
            and not native_deepgram_diarization_enabled
            and not (self.huggingface_token or "").strip()
        ):
            raise ValueError(
                "Invalid production huggingface_token: empty secret is not allowed when local diarization is enabled"
            )

        return self


@lru_cache()
def get_settings() -> Settings:
    return Settings()


def _torch_cuda_is_available() -> bool:
    try:
        import torch
    except ModuleNotFoundError:
        return False

    return bool(torch.cuda.is_available())


def get_runtime_device() -> str:
    preferred = (get_settings().device or "auto").strip().lower()

    if preferred == "cpu":
        return "cpu"

    if preferred == "cuda":
        return "cuda" if _torch_cuda_is_available() else "cpu"

    # auto: prefer GPU when available, else fallback to CPU.
    return "cuda" if _torch_cuda_is_available() else "cpu"
