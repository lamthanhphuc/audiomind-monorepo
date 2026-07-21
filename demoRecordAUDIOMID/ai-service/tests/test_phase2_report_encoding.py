"""Reject control characters (except tab/LF/CR) in Phase 2 implementation report."""

from __future__ import annotations

from pathlib import Path


def test_phase2_report_has_no_stray_control_characters() -> None:
    report = next(
        Path(__file__).resolve().parents[3].joinpath("docs").glob(
            "phase2-*-implementation-report.md"
        )
    )
    raw = report.read_bytes()
    # UTF-8 decode
    text = raw.decode("utf-8")
    bad = sorted({c for c in text if ord(c) < 32 and c not in "\t\n\r"})
    assert not bad, f"control characters found: {[hex(ord(c)) for c in bad]}"
