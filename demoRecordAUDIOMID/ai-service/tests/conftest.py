import pytest

from app.services.gemini_fault_injection import GeminiFaultInjectionClient

# Spec alias for fault-injection doubles used in test_gemini_analyzer profiles.
FakeGeminiClient = GeminiFaultInjectionClient

_GROUPED_ACTION_PLAN_TEST = "test_grouped_action_plan.py"


@pytest.fixture(autouse=True)
def disable_gemini_http_proxy_for_unit_tests(monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "gemini_http_proxy", "")


@pytest.fixture(autouse=True)
def disable_short_transcript_gate_for_legacy_tests(request, monkeypatch):
    if request.node.fspath.basename in (
        "test_transcript_quality_gate.py",
        _GROUPED_ACTION_PLAN_TEST,
    ):
        return
    from app import main as main_module

    monkeypatch.setattr(
        main_module.settings,
        "analysis_short_transcript_gate_enabled",
        False,
    )
