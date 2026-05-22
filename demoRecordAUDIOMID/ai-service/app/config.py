from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

import torch
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

    # Database
    database_url: str = "postgresql://postgres:postgres@db:5432/audiomind"

    # OpenAI
    openai_api_key: str = ""
    openai_model: str = "gpt-4o"
    openai_analysis_model: str = ""
    openai_summary_model: str = ""

    # Gemini
    gemini_api_key: str = ""
    gemini_analysis_model: str = "gemini-2.5-flash"
    gemini_summary_model: str = "gemini-2.5-flash"
    gemini_max_single_request_chars: int = 50000
    gemini_request_delay_seconds: float = 15.0

    # Deepgram
    deepgram_api_key: str = ""
    deepgram_model: str = "nova-2"
    deepgram_realtime_model: str = "nova-2"
    deepgram_batch_model: str = "nova-2"
    deepgram_language: str = "vi"
    deepgram_base_url: str = "https://api.deepgram.com/v1/listen"
    deepgram_timeout_seconds: int = 30
    deepgram_simplify_streaming_url: bool = False
    deepgram_debug_raw_messages: bool = False
    deepgram_diarize: bool = False
    deepgram_endpointing: int | None = None

    # Provider selection (MVP defaults)
    stt_provider: str = "deepgram"
    analysis_provider: str = "openai"
    ai_provider: str = "ollama"  # Ollama-only mode
    local_whisper_enabled: bool = False
    ollama_enabled: bool = False

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

    # Storage
    audio_storage_path: str = "./storage/audio"
    temp_storage_path: str = "./storage/temp"

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

    # Deepgram STT hardening
    stt_audio_queue_max_items: int = 64
    stt_audio_queue_max_bytes: int = 8 * 1024 * 1024
    stt_recv_queue_max_items: int = 256
    stt_recv_queue_max_bytes: int = 4 * 1024 * 1024
    stt_persist_queue_max_items: int = 512
    stt_persist_queue_max_bytes: int = 16 * 1024 * 1024
    stt_enqueue_timeout_seconds: float = 2.0
    stt_gap_timeout_seconds: float = 1.0
    stt_recv_drain_timeout_seconds: float = 1.0
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
        if self.stt_provider not in {"deepgram", "local_whisper"}:
            self.stt_provider = "deepgram"

        self.analysis_provider = (self.analysis_provider or "openai").strip().lower()
        if self.analysis_provider not in {"openai", "gemini", "ollama", "local"}:
            self.analysis_provider = "openai"

        # Backward-compatible normalization for legacy variable usage.
        self.ai_provider = (self.ai_provider or "ollama").strip().lower()
        if self.ai_provider not in {"openai", "ollama", "local"}:
            self.ai_provider = "ollama"

        return self

    @model_validator(mode="after")
    def validate_production_settings(self) -> "Settings":
        env = (self.app_env or "").strip().lower()
        if env not in {"prod", "production"}:
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
            self.analysis_provider == "openai"
            and not (self.openai_api_key or "").strip()
        ):
            raise ValueError(
                "Invalid production openai_api_key: empty secret is not allowed when analysis_provider=openai"
            )

        if (
            self.analysis_provider == "gemini"
            and not (self.gemini_api_key or "").strip()
        ):
            raise ValueError(
                "Invalid production gemini_api_key: empty secret is not allowed when analysis_provider=gemini"
            )

        if (self.ai_provider or "").strip().lower() == "openai" and not (
            self.openai_api_key or ""
        ).strip():
            raise ValueError(
                "Invalid production openai_api_key: empty secret is not allowed when ai_provider=openai"
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


def get_runtime_device() -> str:
    preferred = (get_settings().device or "auto").strip().lower()

    if preferred == "cpu":
        return "cpu"

    if preferred == "cuda":
        return "cuda" if torch.cuda.is_available() else "cpu"

    # auto: prefer GPU when available, else fallback to CPU.
    return "cuda" if torch.cuda.is_available() else "cpu"
