from enum import Enum
from functools import lru_cache
from ipaddress import ip_address
from pathlib import Path
import re
from urllib.parse import urlparse

from pydantic import AliasChoices, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"

# Private Docker Compose service hostnames allowed for DATABASE_TLS_MODE=disable.
DEFAULT_PRIVATE_VPS_DB_HOSTS: frozenset[str] = frozenset({"postgres", "db"})


class AppComponent(str, Enum):
    API = "api"
    WORKER = "worker"
    BEAT = "beat"


class DeploymentMode(str, Enum):
    VPS = "vps"
    MANAGED = "managed"


class DatabaseTlsMode(str, Enum):
    REQUIRE = "require"
    VERIFY_FULL = "verify-full"
    DISABLE = "disable"


def _is_local(value: str | None) -> bool:
    if not value:
        return True
    parsed = urlparse(value)
    host = (parsed.hostname or "").strip().lower()
    raw = value.strip().lower()
    return (
        host in {"localhost", "127.0.0.1", "0.0.0.0", "::1"} or "localhost" in raw
    )


def _database_hostname(database_url: str) -> str:
    return (urlparse(database_url).hostname or "").strip().lower()


def _is_disallowed_tls_disable_host(host: str) -> bool:
    """Reject loopback / non-private IP addresses for TLS-disable production."""
    if not host:
        return True
    if host in {"localhost", "127.0.0.1", "0.0.0.0", "::1"}:
        return True
    try:
        addr = ip_address(host)
    except ValueError:
        return False
    return not addr.is_private


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        case_sensitive=False,
        extra="ignore",
    )

    app_env: str = "development"
    # api | worker | beat — beat is broker-only and must not require DB/provider secrets.
    app_component: str = Field(
        default="api",
        validation_alias=AliasChoices("APP_COMPONENT", "app_component"),
    )
    deployment_mode: str = Field(
        default="",
        validation_alias=AliasChoices("DEPLOYMENT_MODE", "deployment_mode"),
    )
    database_tls_mode: str = Field(
        default="",
        validation_alias=AliasChoices("DATABASE_TLS_MODE", "database_tls_mode"),
    )
    database_tls_private_hosts: str = Field(
        default="postgres,db",
        validation_alias=AliasChoices(
            "DATABASE_TLS_PRIVATE_HOSTS",
            "database_tls_private_hosts",
        ),
    )

    # Database
    database_url: str = "postgresql://postgres:postgres@db:5432/audiomind"

    # Gemini
    gemini_api_key: str = ""
    gemini_api_keys: str = ""
    gemini_multi_key_enabled: bool = False
    gemini_shared_cooldown_enabled: bool = False
    gemini_shared_state_namespace: str = ""
    gemini_model_unsupported_ttl_seconds: int = 21600
    gemini_redis_connect_timeout_seconds: float = 1.0
    gemini_redis_socket_timeout_seconds: float = 1.5
    gemini_max_total_attempts: int = 2
    gemini_max_attempts: int = 2
    gemini_max_schema_retries: int = 1
    gemini_max_token_retries: int = 1
    gemini_key_cooldown_seconds: float = 90.0
    gemini_key_hard_cooldown_seconds: float = 900.0
    gemini_backoff_base_ms: float = 500.0
    gemini_backoff_max_ms: float = 10000.0
    gemini_backoff_jitter: bool = True
    gemini_fail_fast_seconds: float = 30.0
    gemini_model: str = "gemini-3.1-flash-lite"
    gemini_analysis_model: str = ""
    gemini_summary_model: str = ""
    gemini_thinking_level: str = "low"
    gemini_temperature: float = 0.2
    gemini_chat_max_output_tokens: int = 1200
    gemini_summary_max_output_tokens: int = 2048
    gemini_structured_analysis_max_output_tokens: int = 4096
    gemini_study_artifact_max_output_tokens: int = 3072
    gemini_chat_max_input_tokens: int = 12000
    gemini_chat_history_max_tokens: int = 3000
    gemini_rag_context_max_tokens: int = 8000
    gemini_rag_top_k: int = 6
    gemini_analysis_domain_mode: str = "it"
    gemini_analysis_max_input_tokens: int = 12000
    gemini_analysis_max_output_tokens: int = 4096
    gemini_analysis_thinking_budget: int = 0
    gemini_analysis_retry_max_attempts: int = 2
    gemini_timeout_seconds: int = 300
    gemini_rate_limit_retry_base_seconds: float = 30.0
    gemini_rate_limit_retry_max_seconds: float = 90.0
    gemini_retry_quota_exceeded: bool = False
    gemini_max_tokens_retry_enabled: bool = True
    gemini_max_single_request_chars: int = 50000
    gemini_request_delay_seconds: float = 15.0
    gemini_http_proxy: str = ""
    gemini_key_project_groups: str = ""
    gemini_cross_project_failover_enabled: bool = False
    gemini_model_fallback_enabled: bool = False
    gemini_pro_fallback_enabled: bool = False
    gemini_cost_guard_enabled: bool = True
    gemini_cost_guard_namespace: str = ""
    gemini_daily_request_limit_per_user: int = 20
    gemini_daily_reanalyze_limit_per_meeting: int = 3
    gemini_daily_token_limit_per_user: int = 100000
    gemini_max_concurrent_requests: int = 2

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
    meeting_service_base_url: str = Field(
        default="",
        validation_alias=AliasChoices(
            "MEETING_SERVICE_BASE_URL",
            "MEETING_API_BASE_URL",
            "AUDIOMIND_MEETING_API_BASE_URL",
        ),
    )
    meeting_service_timeout_seconds: float = Field(
        default=10.0,
        validation_alias=AliasChoices("MEETING_SERVICE_TIMEOUT_SECONDS"),
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
    celery_study_generation_queue: str = Field(
        default="study_generation",
        validation_alias=AliasChoices(
            "CELERY_STUDY_GENERATION_QUEUE",
            "STUDY_GENERATION_QUEUE",
        ),
    )
    study_generation_max_retries: int = Field(
        default=5,
        validation_alias=AliasChoices("STUDY_GENERATION_MAX_RETRIES"),
    )
    study_generation_soft_time_limit_seconds: int = Field(
        default=900,
        validation_alias=AliasChoices("STUDY_GENERATION_SOFT_TIME_LIMIT_SECONDS"),
    )
    study_generation_time_limit_seconds: int = Field(
        default=1200,
        validation_alias=AliasChoices("STUDY_GENERATION_TIME_LIMIT_SECONDS"),
    )
    study_dispatch_lease_seconds: int = Field(
        default=120,
        validation_alias=AliasChoices("STUDY_DISPATCH_LEASE_SECONDS"),
    )
    study_dispatch_max_attempts: int = Field(
        default=8,
        validation_alias=AliasChoices("STUDY_DISPATCH_MAX_ATTEMPTS"),
    )
    study_dispatch_retry_backoff_seconds: int = Field(
        default=30,
        validation_alias=AliasChoices("STUDY_DISPATCH_RETRY_BACKOFF_SECONDS"),
    )
    study_processing_timeout_seconds: int = Field(
        default=1800,
        validation_alias=AliasChoices("STUDY_PROCESSING_TIMEOUT_SECONDS"),
    )
    study_artifact_list_default_size: int = Field(default=20)
    study_artifact_list_max_size: int = Field(default=100)
    subject_synthesis_max_meetings_per_batch: int = Field(
        default=3,
        validation_alias=AliasChoices("SUBJECT_SYNTHESIS_MAX_MEETINGS_PER_BATCH"),
    )
    subject_synthesis_max_input_tokens: int = Field(
        default=24000,
        validation_alias=AliasChoices("SUBJECT_SYNTHESIS_MAX_INPUT_TOKENS"),
    )
    subject_synthesis_max_parallel_batches: int = Field(
        default=2,
        validation_alias=AliasChoices("SUBJECT_SYNTHESIS_MAX_PARALLEL_BATCHES"),
    )
    subject_synthesis_chars_per_token: int = Field(
        default=4,
        validation_alias=AliasChoices("SUBJECT_SYNTHESIS_CHARS_PER_TOKEN"),
    )
    study_flashcard_count_min: int = 5
    study_flashcard_count_max: int = 100
    study_mcq_count_min: int = 5
    study_mcq_count_max: int = 50
    study_essay_count_min: int = 1
    study_essay_count_max: int = 20
    study_quota_gemini_chars_per_artifact: int = Field(
        default=8000,
        validation_alias=AliasChoices("STUDY_QUOTA_GEMINI_CHARS_PER_ARTIFACT"),
    )

    # Worker monitor
    timeout_monitor_interval_seconds: int = 60
    timeout_monitor_threshold_seconds: int = 7200
    chunk_processing_stale_seconds: int = 180
    worker_health_port: int = 8080

    @staticmethod
    def _normalize_analysis_provider(value: str | None) -> str:
        provider = (value or "gemini").strip().lower()
        if provider == "local":
            provider = "ollama"
        # fake is allowed in non-production; production validators reject it.
        if provider not in {"gemini", "ollama", "fake"}:
            return "gemini"
        return provider

    def _validate_broker_urls_production(self) -> None:
        if not (self.celery_broker_url or "").strip():
            raise ValueError(
                "Invalid production celery_broker_url: empty broker URL is not allowed"
            )
        if _is_local(self.celery_broker_url):
            raise ValueError(
                "Invalid production celery_broker_url: localhost is not allowed"
            )
        if not (self.celery_result_backend or "").strip():
            raise ValueError(
                "Invalid production celery_result_backend: empty result backend is not allowed"
            )
        if _is_local(self.celery_result_backend):
            raise ValueError(
                "Invalid production celery_result_backend: localhost is not allowed"
            )

    def validate_database_url_scheme(self) -> "Settings":
        """Enforce schemes compatible with installed driver (psycopg2-binary)."""
        url = (self.database_url or "").strip()
        if not url:
            raise ValueError("Invalid database_url: empty")
        if url.startswith("jdbc:"):
            raise ValueError(
                "Invalid database_url: JDBC scheme is not supported by AI SQLAlchemy runtime"
            )
        if url.startswith("postgresql+psycopg://"):
            raise ValueError(
                "Invalid database_url: postgresql+psycopg:// requires psycopg v3; "
                "runtime installs psycopg2-binary — use postgresql:// or postgresql+psycopg2://"
            )
        if url.startswith("postgresql+asyncpg://"):
            raise ValueError(
                "Invalid database_url: postgresql+asyncpg:// is async-only; "
                "runtime uses synchronous create_engine with psycopg2"
            )
        if not (
            url.startswith("postgresql://") or url.startswith("postgresql+psycopg2://")
        ):
            raise ValueError(
                "Invalid database_url: must start with postgresql:// or postgresql+psycopg2://"
            )
        return self

    def _private_vps_db_hosts(self) -> frozenset[str]:
        raw = (self.database_tls_private_hosts or "").strip()
        if not raw:
            return DEFAULT_PRIVATE_VPS_DB_HOSTS
        hosts = {part.strip().lower() for part in raw.split(",") if part.strip()}
        return frozenset(hosts) if hosts else DEFAULT_PRIVATE_VPS_DB_HOSTS

    def _validate_database_url_production(self) -> None:
        self.validate_database_url_scheme()
        if (
            _is_local(self.database_url)
            or "postgres:postgres@" in (self.database_url or "").lower()
        ):
            raise ValueError(
                "Invalid production database_url: localhost/default credentials are not allowed"
            )

        lowered = (self.database_url or "").lower()
        host = _database_hostname(self.database_url)
        deployment_mode = (self.deployment_mode or "").strip().lower()
        tls_mode = (self.database_tls_mode or "").strip().lower()
        has_require = "sslmode=require" in lowered
        has_verify_full = "sslmode=verify-full" in lowered

        # Explicit VPS private Postgres: allow TLS disable only for allowlisted Docker hosts.
        if tls_mode == DatabaseTlsMode.DISABLE.value:
            if deployment_mode != DeploymentMode.VPS.value:
                raise ValueError(
                    "Invalid production DATABASE_TLS_MODE=disable: only allowed when "
                    "DEPLOYMENT_MODE=vps"
                )
            if _is_disallowed_tls_disable_host(host):
                raise ValueError(
                    "Invalid production DATABASE_TLS_MODE=disable: host must be a private "
                    "Docker service hostname (not localhost/public IP)"
                )
            if host not in self._private_vps_db_hosts():
                raise ValueError(
                    "Invalid production DATABASE_TLS_MODE=disable: "
                    f"host {host!r} is not in DATABASE_TLS_PRIVATE_HOSTS allowlist"
                )
            return

        # Managed / Kubernetes / remote: TLS required (backward compatible when mode unset).
        if tls_mode and tls_mode not in {
            DatabaseTlsMode.REQUIRE.value,
            DatabaseTlsMode.VERIFY_FULL.value,
            "",
        }:
            raise ValueError(
                "Invalid production DATABASE_TLS_MODE: "
                "expected require, verify-full, or disable"
            )

        if tls_mode == DatabaseTlsMode.VERIFY_FULL.value:
            if not has_verify_full:
                raise ValueError(
                    "Invalid production database_url: sslmode=verify-full is required "
                    "when DATABASE_TLS_MODE=verify-full"
                )
            return

        if not has_require and not has_verify_full:
            raise ValueError(
                "Invalid production database_url: sslmode=require "
                "or sslmode=verify-full is required "
                "(set DEPLOYMENT_MODE=vps and DATABASE_TLS_MODE=disable only for "
                "private Docker Postgres on allowlisted hosts)"
            )

    def _validate_meeting_and_token_production(self) -> None:
        if not (self.meeting_service_base_url or "").strip():
            raise ValueError(
                "Invalid production meeting_service_base_url: required for Phase 2 "
                "subject membership guards before Gemini"
            )
        if not (self.internal_service_token or "").strip():
            raise ValueError(
                "Invalid production internal_service_token: required for meeting membership "
                "and internal study APIs"
            )

    def _validate_analysis_provider_credentials_production(self) -> None:
        provider = (self.analysis_provider or "gemini").strip().lower()
        if provider == "fake":
            raise ValueError(
                "Invalid production analysis_provider: fake is not allowed in production"
            )
        if provider == "gemini" and not (self.gemini_api_key or "").strip() and not (
            bool(self.gemini_multi_key_enabled)
            and (self.gemini_api_keys or "").strip()
        ):
            raise ValueError(
                "Invalid production gemini_api_key: empty secret is not allowed when analysis_provider=gemini"
            )
        if provider == "ollama" and _is_local(self.ollama_base_url):
            raise ValueError(
                "Invalid production ollama_base_url: localhost is not allowed when analysis_provider=ollama"
            )

    def _validate_study_generation_queue_production(self) -> None:
        if not (self.celery_study_generation_queue or "").strip():
            raise ValueError(
                "Invalid production celery_study_generation_queue: empty queue name is not allowed"
            )

    def _validate_cors_production(self) -> None:
        origins = (self.cors_allowed_origins or "").lower()
        if "localhost" not in origins and "127.0.0.1" not in origins:
            return
        # Local VPS compose may expose the app on localhost / 127.0.0.1.
        if (self.deployment_mode or "").strip().lower() == DeploymentMode.VPS.value:
            return
        raise ValueError(
            "Invalid production cors_allowed_origins: localhost/127.0.0.1 "
            "is not allowed (set DEPLOYMENT_MODE=vps for private VPS compose)"
        )

    def _validate_huggingface_diarization_production(self) -> None:
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

    @model_validator(mode="after")
    def normalize_provider_settings(self) -> "Settings":
        self.app_component = (self.app_component or "api").strip().lower()
        if self.app_component not in {
            AppComponent.API.value,
            AppComponent.WORKER.value,
            AppComponent.BEAT.value,
        }:
            self.app_component = AppComponent.API.value

        self.stt_provider = (self.stt_provider or "deepgram").strip().lower()
        if self.stt_provider == "whisper":
            self.stt_provider = "local_whisper"
        if self.stt_provider not in {"deepgram", "local_whisper"}:
            self.stt_provider = "deepgram"

        analysis_set = "analysis_provider" in self.model_fields_set
        ai_set = "ai_provider" in self.model_fields_set

        analysis_norm = self._normalize_analysis_provider(self.analysis_provider)
        ai_norm = self._normalize_analysis_provider(self.ai_provider)

        if analysis_set and ai_set and analysis_norm != ai_norm:
            raise ValueError(
                "ai_provider and analysis_provider conflict: "
                f"ai_provider={ai_norm!r} analysis_provider={analysis_norm!r}. "
                "Set both to the same value, or set only analysis_provider "
                "(source of truth for Phase 2 generation)."
            )

        # analysis_provider is source of truth; sync ai_provider for backward compat.
        # Legacy sole AI_PROVIDER still seeds analysis_provider when ANALYSIS_PROVIDER unset.
        if analysis_set or not ai_set:
            self.analysis_provider = analysis_norm
            self.ai_provider = analysis_norm
        else:
            self.analysis_provider = ai_norm
            self.ai_provider = ai_norm

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

        self.gemini_model = (
            (self.gemini_model or "gemini-3.1-flash-lite").strip().lower()
        )
        self.gemini_analysis_model = (
            self.gemini_analysis_model or ""
        ).strip().lower() or self.gemini_model
        self.gemini_summary_model = (
            self.gemini_summary_model or ""
        ).strip().lower() or self.gemini_model
        self.gemini_thinking_level = (
            (self.gemini_thinking_level or "low").strip().lower()
        )
        if self.gemini_thinking_level not in {"minimal", "low", "medium", "high"}:
            self.gemini_thinking_level = "low"
        self.gemini_temperature = min(
            2.0, max(0.0, float(self.gemini_temperature or 0.2))
        )
        self.gemini_chat_max_output_tokens = max(
            1, int(self.gemini_chat_max_output_tokens or 1200)
        )
        self.gemini_summary_max_output_tokens = max(
            1, int(self.gemini_summary_max_output_tokens or 2048)
        )
        self.gemini_structured_analysis_max_output_tokens = max(
            1, int(self.gemini_structured_analysis_max_output_tokens or 4096)
        )
        self.gemini_study_artifact_max_output_tokens = max(
            1, int(self.gemini_study_artifact_max_output_tokens or 3072)
        )
        self.gemini_chat_max_input_tokens = max(
            1, int(self.gemini_chat_max_input_tokens or 12000)
        )
        self.gemini_chat_history_max_tokens = max(
            0, int(self.gemini_chat_history_max_tokens or 3000)
        )
        self.gemini_rag_context_max_tokens = max(
            1, int(self.gemini_rag_context_max_tokens or 8000)
        )
        self.gemini_rag_top_k = min(20, max(1, int(self.gemini_rag_top_k or 6)))

        self.gemini_analysis_max_input_tokens = max(
            1, int(self.gemini_analysis_max_input_tokens or 12000)
        )
        # Clamp to a sane model budget: avoid tiny wasteful requests and unbounded growth.
        self.gemini_analysis_max_output_tokens = min(
            16384,
            max(1024, int(self.gemini_analysis_max_output_tokens or 4096)),
        )
        self.gemini_analysis_thinking_budget = max(
            0, int(self.gemini_analysis_thinking_budget or 0)
        )
        self.gemini_analysis_retry_max_attempts = max(
            1, int(self.gemini_analysis_retry_max_attempts or 2)
        )
        self.gemini_max_total_attempts = max(
            1, int(self.gemini_max_total_attempts or 2)
        )
        # Legacy knob remains readable but can never expand the global budget.
        self.gemini_max_attempts = self.gemini_max_total_attempts
        self.gemini_max_schema_retries = min(
            1, max(0, int(self.gemini_max_schema_retries or 0))
        )
        self.gemini_max_token_retries = min(
            1, max(0, int(self.gemini_max_token_retries or 0))
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
        self.gemini_redis_connect_timeout_seconds = max(
            0.1,
            float(self.gemini_redis_connect_timeout_seconds or 1.0),
        )
        self.gemini_redis_socket_timeout_seconds = max(
            0.1,
            float(self.gemini_redis_socket_timeout_seconds or 1.5),
        )
        self.gemini_timeout_seconds = max(1, int(self.gemini_timeout_seconds or 300))
        self.gemini_rate_limit_retry_base_seconds = max(
            0.0, float(self.gemini_rate_limit_retry_base_seconds or 0.0)
        )
        self.gemini_rate_limit_retry_max_seconds = max(
            0.0, float(self.gemini_rate_limit_retry_max_seconds or 0.0)
        )
        self.gemini_daily_request_limit_per_user = max(
            1, int(self.gemini_daily_request_limit_per_user or 20)
        )
        self.gemini_daily_reanalyze_limit_per_meeting = max(
            1, int(self.gemini_daily_reanalyze_limit_per_meeting or 3)
        )
        self.gemini_daily_token_limit_per_user = max(
            1, int(self.gemini_daily_token_limit_per_user or 100000)
        )
        self.gemini_max_concurrent_requests = max(
            1, int(self.gemini_max_concurrent_requests or 2)
        )
        self.gemini_cost_guard_namespace = (
            (
                self.gemini_cost_guard_namespace
                or f"{(self.app_env or 'development').strip().lower()}-audiomind"
            )
            .strip()
            .lower()
        )
        if not re.fullmatch(
            r"[a-z0-9][a-z0-9._-]{0,47}", self.gemini_cost_guard_namespace
        ):
            raise ValueError("gemini_cost_guard_namespace is invalid")
        self.analysis_background_retry_max_attempts = max(
            0, int(self.analysis_background_retry_max_attempts or 4)
        )

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

        if self.app_component != AppComponent.BEAT.value:
            self.validate_database_url_scheme()

        return self

    @model_validator(mode="after")
    def validate_production_settings(self) -> "Settings":
        env = (self.app_env or "").strip().lower()
        if env not in {"prod", "production"}:
            return self

        component = (self.app_component or AppComponent.API.value).strip().lower()

        if component == AppComponent.BEAT.value:
            self._validate_broker_urls_production()
            return self

        # Worker and API share DB / meeting / provider / study-queue checks.
        self._validate_database_url_production()
        self._validate_broker_urls_production()
        self._validate_meeting_and_token_production()
        self._validate_analysis_provider_credentials_production()
        self._validate_study_generation_queue_production()

        if component == AppComponent.WORKER.value:
            return self

        # API (default): CORS + diarization token checks.
        self._validate_cors_production()
        self._validate_huggingface_diarization_production()
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
