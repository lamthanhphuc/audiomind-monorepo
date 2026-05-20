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
    assert settings.deepgram_realtime_model == "nova-2"
    assert settings.deepgram_batch_model == "nova-2"
    assert settings.deepgram_language == "vi"
    assert settings.local_whisper_enabled is False
    assert settings.ollama_enabled is False


def test_invalid_provider_values_normalize_to_safe_defaults(monkeypatch):
    monkeypatch.setenv("STT_PROVIDER", "unsupported-provider")
    monkeypatch.setenv("ANALYSIS_PROVIDER", "not-real")

    settings = Settings(_env_file=None)

    assert settings.stt_provider == "deepgram"
    assert settings.analysis_provider == "openai"
