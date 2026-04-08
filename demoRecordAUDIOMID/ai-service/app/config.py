from pydantic_settings import BaseSettings
from functools import lru_cache
from pathlib import Path
import torch

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    # Database
    database_url: str = "postgresql://postgres:postgres@db:5432/audiomind"

    # OpenAI
    openai_api_key: str = ""
    openai_model: str = "gpt-4o"

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
    job_state_ttl_seconds: int = 3600

    # Async processing
    celery_broker_url: str = "redis://redis:6379/0"
    celery_result_backend: str = "redis://redis:6379/1"
    celery_task_queue: str = "audio_processing"
    celery_task_time_limit_seconds: int = 3600

    class Config:
        env_file = str(ENV_FILE)
        case_sensitive = False


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
