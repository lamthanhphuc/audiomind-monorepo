"""Realtime smoke-prep configuration guard (Slice B).

Evaluates STT/Deepgram env settings without printing secret values.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from loguru import logger

_FORCED_WEBM_PARAM_ENV_KEYS = (
    "DEEPGRAM_SAMPLE_RATE",
    "DEEPGRAM_ENCODING",
    "STT_SAMPLE_RATE",
    "STT_ENCODING",
    "DEEPGRAM_STREAM_SAMPLE_RATE",
    "DEEPGRAM_STREAM_ENCODING",
)

_MISNAMED_FINAL_DRAIN_ENV_KEYS = (
    "STT_FINAL_DRAIN_TIMEOUT_SECONDS",
    "STT_FINAL_RECV_TIMEOUT_SECONDS",
    "STT_FINAL_DRAIN_SECONDS",
)


class GuardSeverity(str, Enum):
    OK = "ok"
    WARN = "warn"
    ERROR = "error"


@dataclass(frozen=True)
class GuardFinding:
    check: str
    severity: GuardSeverity
    message: str


@dataclass
class GuardReport:
    findings: list[GuardFinding] = field(default_factory=list)

    @property
    def status(self) -> str:
        if any(item.severity == GuardSeverity.ERROR for item in self.findings):
            return "error"
        if any(item.severity == GuardSeverity.WARN for item in self.findings):
            return "warn"
        return "ok"

    def has_errors(self) -> bool:
        return self.status == "error"

    def add(self, check: str, severity: GuardSeverity, message: str) -> None:
        self.findings.append(
            GuardFinding(check=check, severity=severity, message=message)
        )


def _env_truthy(name: str, default: str = "") -> bool:
    raw = os.getenv(name, default).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _env_present(name: str) -> bool:
    return bool((os.getenv(name) or "").strip())


def evaluate_realtime_config(settings: Any) -> GuardReport:
    report = GuardReport()

    recv_drain = float(getattr(settings, "stt_recv_drain_timeout_seconds", 0.1))
    if recv_drain >= 1.0:
        report.add(
            "stt_recv_drain_timeout_seconds",
            GuardSeverity.ERROR,
            "value must be < 1.0 for realtime smoke (expected <= 0.2, default 0.1)",
        )
    elif recv_drain > 0.2:
        report.add(
            "stt_recv_drain_timeout_seconds",
            GuardSeverity.WARN,
            "value > 0.2 may delay non-final transcript delivery",
        )

    final_drain = float(getattr(settings, "stt_final_recv_drain_timeout_seconds", 2.0))
    if final_drain < 1.0:
        report.add(
            "stt_final_recv_drain_timeout_seconds",
            GuardSeverity.ERROR,
            "value must be >= 1.0 for final drain (default 2.0)",
        )

    if not _env_present("STT_FINAL_RECV_DRAIN_TIMEOUT_SECONDS"):
        for misnamed in _MISNAMED_FINAL_DRAIN_ENV_KEYS:
            if _env_present(misnamed):
                report.add(
                    "stt_final_recv_drain_timeout_seconds",
                    GuardSeverity.WARN,
                    f"misnamed env {misnamed} detected; use STT_FINAL_RECV_DRAIN_TIMEOUT_SECONDS",
                )
                break
        else:
            report.add(
                "stt_final_recv_drain_timeout_seconds",
                GuardSeverity.WARN,
                "STT_FINAL_RECV_DRAIN_TIMEOUT_SECONDS not set in environment; using code default",
            )

    if bool(getattr(settings, "deepgram_debug_raw_messages", False)):
        report.add(
            "deepgram_debug_raw_messages",
            GuardSeverity.ERROR,
            "must be false for realtime smoke prep",
        )

    provider = str(getattr(settings, "stt_provider", "deepgram")).strip().lower()
    if provider != "deepgram":
        report.add(
            "stt_provider",
            GuardSeverity.ERROR,
            f"expected deepgram for realtime smoke, got {provider}",
        )

    if not _env_truthy("REALTIME_ASYNC_AUDIO_QUEUE_ENABLED", "true"):
        report.add(
            "realtime_async_audio_queue_enabled",
            GuardSeverity.WARN,
            "REALTIME_ASYNC_AUDIO_QUEUE_ENABLED is false; final smoke expects true after Slice A",
        )

    for env_key in _FORCED_WEBM_PARAM_ENV_KEYS:
        if _env_present(env_key):
            report.add(
                "deepgram_forced_webm_params",
                GuardSeverity.WARN,
                f"{env_key} is set; WebM realtime should omit forced sample_rate/encoding",
            )

    if not report.findings:
        report.add(
            "realtime_config", GuardSeverity.OK, "all realtime smoke checks passed"
        )

    return report


def log_realtime_config_guard(report: GuardReport) -> None:
    logger.info("REALTIME_CONFIG_GUARD status={}", report.status)
    for finding in report.findings:
        if finding.severity == GuardSeverity.ERROR:
            logger.error(
                "REALTIME_CONFIG_GUARD check={} severity={} detail={}",
                finding.check,
                finding.severity.value,
                finding.message,
            )
        elif finding.severity == GuardSeverity.WARN:
            logger.warning(
                "REALTIME_CONFIG_GUARD check={} severity={} detail={}",
                finding.check,
                finding.severity.value,
                finding.message,
            )
        else:
            logger.info(
                "REALTIME_CONFIG_GUARD check={} severity={} detail={}",
                finding.check,
                finding.severity.value,
                finding.message,
            )
