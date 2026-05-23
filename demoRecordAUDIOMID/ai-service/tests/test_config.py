from app.config import Settings


def test_distributed_ownership_rollback_alias_disables_stt_ownership(monkeypatch):
    monkeypatch.setenv("STT_ENABLE_DISTRIBUTED_OWNERSHIP", "false")
    monkeypatch.setenv("STT_OWNERSHIP_ENABLED", "true")

    settings = Settings(_env_file=None)

    assert settings.stt_ownership_enabled is False


def test_provider_defaults_load_for_mvp():
    settings = Settings(_env_file=None)

    assert settings.stt_provider == "deepgram"
    assert settings.analysis_provider == "openai"
    assert settings.gemini_api_key == ""
    assert settings.gemini_analysis_model == "gemini-2.5-flash"
    assert settings.gemini_summary_model == "gemini-2.5-flash"
    assert settings.gemini_max_single_request_chars == 50000
    assert settings.gemini_request_delay_seconds == 15.0
    assert settings.deepgram_realtime_model == "nova-2"
    assert settings.deepgram_batch_model == "nova-2"
    assert settings.deepgram_language == "vi"
    assert settings.deepgram_realtime_endpointing_default is None
    assert settings.deepgram_realtime_endpointing_vi is None
    assert settings.deepgram_realtime_endpointing_en is None
    assert settings.deepgram_realtime_endpointing_multi is None
    assert settings.deepgram_endpointing is None
    assert settings.local_whisper_enabled is False
    assert settings.ollama_enabled is False


def test_invalid_provider_values_normalize_to_safe_defaults(monkeypatch):
    monkeypatch.setenv("STT_PROVIDER", "unsupported-provider")
    monkeypatch.setenv("ANALYSIS_PROVIDER", "not-real")

    settings = Settings(_env_file=None)

    assert settings.stt_provider == "deepgram"
    assert settings.analysis_provider == "openai"


def test_gemini_provider_values_load_from_env(monkeypatch):
    monkeypatch.setenv("ANALYSIS_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.setenv("GEMINI_ANALYSIS_MODEL", "gemini-2.5-flash")
    monkeypatch.setenv("GEMINI_SUMMARY_MODEL", "gemini-2.5-flash")
    monkeypatch.setenv("GEMINI_MAX_SINGLE_REQUEST_CHARS", "30000")
    monkeypatch.setenv("GEMINI_REQUEST_DELAY_SECONDS", "20")

    settings = Settings(_env_file=None)

    assert settings.analysis_provider == "gemini"
    assert settings.gemini_api_key == "test-gemini-key"
    assert settings.gemini_analysis_model == "gemini-2.5-flash"
    assert settings.gemini_summary_model == "gemini-2.5-flash"
    assert settings.gemini_max_single_request_chars == 30000
    assert settings.gemini_request_delay_seconds == 20.0
