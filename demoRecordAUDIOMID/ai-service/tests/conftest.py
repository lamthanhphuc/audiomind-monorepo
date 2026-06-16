import pytest

from app import main as main_module


@pytest.fixture(autouse=True)
def disable_short_transcript_gate_for_legacy_tests(request, monkeypatch):
    if request.node.fspath.basename == "test_transcript_quality_gate.py":
        return
    monkeypatch.setattr(
        main_module.settings,
        "analysis_short_transcript_gate_enabled",
        False,
    )
