import sys
import builtins

from app.config import Settings, get_runtime_device


def test_distributed_ownership_rollback_alias_disables_stt_ownership(monkeypatch):
    monkeypatch.setenv("STT_ENABLE_DISTRIBUTED_OWNERSHIP", "false")
    monkeypatch.setenv("STT_OWNERSHIP_ENABLED", "true")

    settings = Settings(_env_file=None)

    assert settings.stt_ownership_enabled is False


def test_provider_defaults_load_for_mvp():
    settings = Settings(_env_file=None)

    assert settings.stt_provider == "deepgram"
    assert settings.analysis_provider == "gemini"
    assert settings.gemini_api_key == ""
    assert settings.gemini_analysis_model == "gemini-3.1-flash-lite"
    assert settings.gemini_summary_model == "gemini-3.1-flash-lite"
    assert settings.gemini_timeout_seconds == 300
    assert settings.gemini_analysis_retry_max_attempts == 2
    assert settings.gemini_rate_limit_retry_base_seconds == 30.0
    assert settings.gemini_rate_limit_retry_max_seconds == 90.0
    assert settings.gemini_retry_quota_exceeded is False
    assert settings.gemini_max_tokens_retry_enabled is True
    assert settings.gemini_analysis_max_output_tokens == 4096
    assert settings.gemini_max_single_request_chars == 50000
    assert settings.gemini_request_delay_seconds == 15.0
    assert settings.deepgram_realtime_model == "nova-3"
    assert settings.deepgram_batch_model == "nova-3"
    assert settings.deepgram_language == "vi"
    assert settings.deepgram_smart_format is True
    assert settings.deepgram_utterances is True
    assert settings.deepgram_paragraphs is True
    assert settings.deepgram_realtime_endpointing_default is None
    assert settings.deepgram_realtime_endpointing_vi is None
    assert settings.deepgram_realtime_endpointing_en is None
    assert settings.deepgram_realtime_endpointing_multi is None
    assert settings.deepgram_endpointing is None
    assert settings.local_whisper_enabled is False
    assert settings.ollama_enabled is False
    assert settings.allow_legacy_local_stt is False
    assert settings.allow_legacy_local_ai is False


def test_invalid_provider_values_normalize_to_safe_defaults(monkeypatch):
    monkeypatch.setenv("STT_PROVIDER", "unsupported-provider")
    monkeypatch.setenv("ANALYSIS_PROVIDER", "not-real")

    settings = Settings(_env_file=None)

    assert settings.stt_provider == "deepgram"
    assert settings.analysis_provider == "gemini"


def test_whisper_provider_alias_normalizes_to_local_whisper(monkeypatch):
    monkeypatch.setenv("STT_PROVIDER", "whisper")

    settings = Settings(_env_file=None)

    assert settings.stt_provider == "local_whisper"


def test_legacy_provider_opt_in_flags_load_from_env(monkeypatch):
    monkeypatch.setenv("ALLOW_LEGACY_LOCAL_STT", "true")
    monkeypatch.setenv("ALLOW_LEGACY_LOCAL_AI", "true")

    settings = Settings(_env_file=None)

    assert settings.allow_legacy_local_stt is True
    assert settings.allow_legacy_local_ai is True


def test_gemini_provider_values_load_from_env(monkeypatch):
    monkeypatch.setenv("ANALYSIS_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.setenv("GEMINI_ANALYSIS_MODEL", "gemini-2.5-flash")
    monkeypatch.setenv("GEMINI_SUMMARY_MODEL", "gemini-2.5-flash")
    monkeypatch.setenv("GEMINI_TIMEOUT_SECONDS", "45")
    monkeypatch.setenv("GEMINI_ANALYSIS_RETRY_MAX_ATTEMPTS", "1")
    monkeypatch.setenv("GEMINI_RATE_LIMIT_RETRY_BASE_SECONDS", "5")
    monkeypatch.setenv("GEMINI_RATE_LIMIT_RETRY_MAX_SECONDS", "8")
    monkeypatch.setenv("GEMINI_RETRY_QUOTA_EXCEEDED", "true")
    monkeypatch.setenv("GEMINI_MAX_TOKENS_RETRY_ENABLED", "false")
    monkeypatch.setenv("GEMINI_MAX_SINGLE_REQUEST_CHARS", "30000")
    monkeypatch.setenv("GEMINI_REQUEST_DELAY_SECONDS", "20")
    monkeypatch.setenv("GEMINI_ANALYSIS_MAX_OUTPUT_TOKENS", "4096")

    settings = Settings(_env_file=None)

    assert settings.analysis_provider == "gemini"
    assert settings.gemini_api_key == "test-gemini-key"
    assert settings.gemini_analysis_model == "gemini-2.5-flash"
    assert settings.gemini_summary_model == "gemini-2.5-flash"
    assert settings.gemini_timeout_seconds == 45
    assert settings.gemini_analysis_retry_max_attempts == 1
    assert settings.gemini_rate_limit_retry_base_seconds == 5.0
    assert settings.gemini_rate_limit_retry_max_seconds == 8.0
    assert settings.gemini_retry_quota_exceeded is True
    assert settings.gemini_max_tokens_retry_enabled is False
    assert settings.gemini_max_single_request_chars == 30000
    assert settings.gemini_request_delay_seconds == 20.0
    assert settings.gemini_analysis_max_output_tokens == 4096


def test_gemini_analysis_max_output_tokens_clamped_to_bounds(monkeypatch):
    monkeypatch.setenv("GEMINI_ANALYSIS_MAX_OUTPUT_TOKENS", "64")
    settings_low = Settings(_env_file=None)
    assert settings_low.gemini_analysis_max_output_tokens == 1024

    monkeypatch.setenv("GEMINI_ANALYSIS_MAX_OUTPUT_TOKENS", "999999")
    settings_high = Settings(_env_file=None)
    assert settings_high.gemini_analysis_max_output_tokens == 16384


def test_runtime_device_falls_back_to_cpu_without_torch(monkeypatch):
    import app.config as config_module

    real_import = builtins.__import__

    monkeypatch.setattr(
        config_module,
        "get_settings",
        lambda: Settings(_env_file=None, device="auto"),
    )
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    monkeypatch.setattr(
        builtins,
        "__import__",
        lambda name, *args, **kwargs: (
            (_ for _ in ()).throw(ModuleNotFoundError(name="torch"))
            if name == "torch"
            else real_import(name, *args, **kwargs)
        ),
    )

    assert get_runtime_device() == "cpu"
