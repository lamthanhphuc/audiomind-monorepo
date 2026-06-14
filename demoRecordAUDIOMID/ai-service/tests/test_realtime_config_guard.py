"""Tests for realtime config guard (Slice B)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.realtime_config_guard import (
    GuardSeverity,
    evaluate_realtime_config,
    log_realtime_config_guard,
)


def _settings(**overrides: object) -> SimpleNamespace:
    defaults = {
        "stt_recv_drain_timeout_seconds": 0.1,
        "stt_final_recv_drain_timeout_seconds": 2.0,
        "deepgram_debug_raw_messages": False,
        "stt_provider": "deepgram",
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def test_guard_ok_for_default_realtime_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STT_FINAL_RECV_DRAIN_TIMEOUT_SECONDS", "2.0")
    monkeypatch.setenv("REALTIME_ASYNC_AUDIO_QUEUE_ENABLED", "true")

    report = evaluate_realtime_config(_settings())

    assert report.status == "ok"
    assert not report.has_errors()


def test_guard_errors_on_legacy_recv_drain_timeout() -> None:
    report = evaluate_realtime_config(_settings(stt_recv_drain_timeout_seconds=1.0))

    assert report.has_errors()
    assert any(
        item.check == "stt_recv_drain_timeout_seconds"
        and item.severity == GuardSeverity.ERROR
        for item in report.findings
    )


def test_guard_warns_on_high_recv_drain_timeout() -> None:
    report = evaluate_realtime_config(_settings(stt_recv_drain_timeout_seconds=0.5))

    assert report.status == "warn"
    assert any(item.severity == GuardSeverity.WARN for item in report.findings)


def test_guard_errors_on_debug_raw_messages_enabled() -> None:
    report = evaluate_realtime_config(_settings(deepgram_debug_raw_messages=True))

    assert report.has_errors()
    assert any(item.check == "deepgram_debug_raw_messages" for item in report.findings)


def test_guard_errors_on_non_deepgram_provider() -> None:
    report = evaluate_realtime_config(_settings(stt_provider="local_whisper"))

    assert report.has_errors()
    assert any(item.check == "stt_provider" for item in report.findings)


def test_guard_warns_when_async_queue_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REALTIME_ASYNC_AUDIO_QUEUE_ENABLED", "false")

    report = evaluate_realtime_config(_settings())

    assert report.status == "warn"
    assert any(item.check == "realtime_async_audio_queue_enabled" for item in report.findings)


def test_guard_warns_on_forced_webm_param_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPGRAM_SAMPLE_RATE", "16000")

    report = evaluate_realtime_config(_settings())

    assert any(item.check == "deepgram_forced_webm_params" for item in report.findings)


def test_guard_warns_on_misnamed_final_drain_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("STT_FINAL_RECV_DRAIN_TIMEOUT_SECONDS", raising=False)
    monkeypatch.setenv("STT_FINAL_DRAIN_TIMEOUT_SECONDS", "2.0")

    report = evaluate_realtime_config(_settings())

    assert any(
        item.check == "stt_final_recv_drain_timeout_seconds"
        and "misnamed" in item.message
        for item in report.findings
    )


def test_log_realtime_config_guard_does_not_print_secrets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logged: list[str] = []

    class _Logger:
        def info(self, message: str, *args: object) -> None:
            logged.append(message.format(*args) if args else message)

        def warning(self, message: str, *args: object) -> None:
            logged.append(message.format(*args) if args else message)

        def error(self, message: str, *args: object) -> None:
            logged.append(message.format(*args) if args else message)

    monkeypatch.setattr("app.realtime_config_guard.logger", _Logger())
    report = evaluate_realtime_config(_settings(stt_recv_drain_timeout_seconds=1.0))
    log_realtime_config_guard(report)

    assert any("REALTIME_CONFIG_GUARD status=error" in line for line in logged)
    assert all("dg-test" not in line for line in logged)
    assert all("api_key" not in line.lower() or "api_key_exists" in line for line in logged)
