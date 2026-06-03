from app.config import Settings


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
    assert settings.gemini_analysis_model == "gemini-2.5-flash"
    assert settings.gemini_summary_model == "gemini-2.5-flash"
    assert settings.gemini_timeout_seconds == 300
    assert settings.gemini_analysis_retry_max_attempts == 3
    assert settings.gemini_rate_limit_retry_base_seconds == 30.0
    assert settings.gemini_rate_limit_retry_max_seconds == 90.0
    assert settings.gemini_retry_quota_exceeded is False
    assert settings.gemini_max_tokens_retry_enabled is True
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
