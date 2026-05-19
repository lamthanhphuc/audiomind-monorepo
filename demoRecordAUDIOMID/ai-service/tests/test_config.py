from app.config import Settings


def test_distributed_ownership_rollback_alias_disables_stt_ownership(monkeypatch):
    monkeypatch.setenv("STT_ENABLE_DISTRIBUTED_OWNERSHIP", "false")
    monkeypatch.setenv("STT_OWNERSHIP_ENABLED", "true")

    settings = Settings(_env_file=None)

    assert settings.stt_ownership_enabled is False
