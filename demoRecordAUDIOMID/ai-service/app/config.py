from pydantic_settings import BaseSettings
from functools import lru_cache
from pathlib import Path
import torch


ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    # Database
    database_url: str = "postgresql://user:pass@postgres:5432/mydb"
    
    # OpenAI
    openai_api_key: str = ""
    openai_model: str = "gpt-4o"

    # LLM Provider
    ai_provider: str = "ollama"  # Ollama-only mode

    # Ollama (local LLM)
    ollama_base_url: str = "http://host.docker.internal:11434"
    ollama_model: str = "qwen2.5:3b-instruct"
    ollama_timeout_seconds: int = 300
    
    # Hugging Face
    huggingface_token: str = ""
    
    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    
    # Storage
    audio_storage_path: str = "./storage/audio"
    temp_storage_path: str = "./storage/temp"
    
    # Model Settings
    whisper_model: str = "base"
    device: str = "cpu"  # or cuda
    enable_speaker_diarization: bool = False
    lazy_load_models: bool = True
    whisper_no_speech_threshold: float = 0.7
    whisper_logprob_threshold: float = -0.8
    whisper_cpu_chunk_seconds: int = 30
    whisper_gpu_chunk_seconds: int = 60
    
    # Processing
    max_chunk_duration: int = 30
    vad_threshold: float = 0.5
    
    class Config:
        env_file = str(ENV_FILE)
        case_sensitive = False


@lru_cache()
def get_settings() -> Settings:
    return Settings()


def get_runtime_device() -> str:
    return "cuda" if torch.cuda.is_available() else "cpu"
