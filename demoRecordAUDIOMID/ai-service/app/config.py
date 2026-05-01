from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import model_validator
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse
import torch

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

    # Deepgram
    deepgram_api_key: str = ""
    deepgram_model: str = "nova-2"
    deepgram_base_url: str = "https://api.deepgram.com/v1/listen"
    deepgram_timeout_seconds: int = 30

    # LLM Provider
    ai_provider: str = "ollama"  # Ollama-only mode

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

        if (self.ai_provider or "").strip().lower() == "openai" and not (
            self.openai_api_key or ""
        ).strip():
            raise ValueError(
                "Invalid production openai_api_key: empty secret is not allowed when ai_provider=openai"
            )

        if (
            self.enable_speaker_diarization
            and not (self.huggingface_token or "").strip()
        ):
            raise ValueError(
                "Invalid production huggingface_token: empty secret is not allowed when diarization is enabled"
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
