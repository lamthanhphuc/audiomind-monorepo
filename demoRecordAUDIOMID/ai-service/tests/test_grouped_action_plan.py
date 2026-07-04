import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

GROUPED_ACTION_PLAN_FEATURE_SET = "grouped-action-plan-v1"
PROMPT_VERSION = "gemini-business-v2"
SCHEMA_VERSION = "gemini-business-v2"

_AI_ANALYZER_TYPE = None
_MAIN_MODULE = None


def _load_ai_analyzer_type():
    global _AI_ANALYZER_TYPE
    if _AI_ANALYZER_TYPE is None:
        module_path = (
            Path(__file__).resolve().parents[1] / "app" / "services" / "ai_analyzer.py"
        )
        spec = importlib.util.spec_from_file_location(
            "ai_analyzer_grouped", module_path
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _AI_ANALYZER_TYPE = module.AIAnalyzer
    return _AI_ANALYZER_TYPE


def _load_main_module():
    global _MAIN_MODULE
    if _MAIN_MODULE is None:
        pytest.importorskip("numpy")
        main_path = Path(__file__).resolve().parents[1] / "app" / "main.py"
        spec = importlib.util.spec_from_file_location("main_grouped", main_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _MAIN_MODULE = module
    return _MAIN_MODULE


@pytest.fixture
def analyzer():
    ai_analyzer_type = _load_ai_analyzer_type()
    return ai_analyzer_type(api_key="", provider="gemini")


def test_analysis_feature_set_matches_grouped_cache_version():
    ai_analyzer_type = _load_ai_analyzer_type()
    assert ai_analyzer_type.ANALYSIS_FEATURE_SET == GROUPED_ACTION_PLAN_FEATURE_SET


def test_normalize_grouped_action_plan_caps_sections_and_dedupes_tasks(analyzer):
    sections = []
    for section_index in range(10):
        sections.append(
            {
                "id": f"section-{section_index}",
                "title": f"Nhóm {section_index}",
                "items": [
                    {
                        "id": f"item-{section_index}",
                        "title": "Chuẩn bị demo",
                        "confidence": "SUPPORTED",
                        "sourceActionItemIds": [f"src-{section_index}"],
                    }
                ],
            }
        )

    normalized = analyzer._normalize_grouped_action_plan(
        {"sections": sections, "notes": []},
        action_items=[{"task": "Fallback task"}],
    )

    assert len(normalized["sections"]) <= 8
    titles = [
        item["title"] for section in normalized["sections"] for item in section["items"]
    ]
    assert titles.count("Chuẩn bị demo") == 1
    assert normalized["version"] == GROUPED_ACTION_PLAN_FEATURE_SET


def test_normalize_grouped_confidence_requires_source_for_supported(analyzer):
    normalized = analyzer._normalize_grouped_action_plan(
        {
            "sections": [
                {
                    "title": "Kỹ thuật",
                    "items": [
                        {
                            "title": "Triển khai API",
                            "confidence": "SUPPORTED",
                            "sourceActionItemIds": [],
                        }
                    ],
                }
            ]
        },
        action_items=[],
    )

    item = normalized["sections"][0]["items"][0]
    assert item["confidence"] == "NEEDS_REVIEW"


def test_fallback_grouped_action_plan_uses_flat_action_items(analyzer):
    action_items = [
        {"id": "a1", "task": "Viết tài liệu", "owner": "An"},
        {"id": "a2", "task": "Review PR", "owner": "Binh"},
    ]

    normalized = analyzer._fallback_grouped_action_plan(action_items)

    assert normalized["sections"][0]["title"] == "Công việc chung"
    assert len(normalized["sections"][0]["items"]) == 2
    assert normalized["sections"][0]["items"][0]["title"] == "Viết tài liệu"


def test_empty_grouped_action_plan_when_no_tasks(analyzer):
    normalized = analyzer._fallback_grouped_action_plan([])
    assert normalized["sections"] == []
    assert "Chưa có công việc" in normalized["intro"]


def test_normalize_analysis_payload_emits_grouped_action_plan_only(analyzer):
    raw = {
        "summary": "Tóm tắt",
        "groupedActionPlan": {
            "version": GROUPED_ACTION_PLAN_FEATURE_SET,
            "sections": [{"title": "Chung", "items": [{"title": "Task A"}]}],
        },
        "grouped_action_plan": {
            "sections": [{"title": "Legacy snake", "items": [{"title": "Ignored"}]}],
        },
        "analysisFeatureSet": GROUPED_ACTION_PLAN_FEATURE_SET,
    }

    normalized = _load_main_module()._normalize_analysis_payload(raw)

    assert "groupedActionPlan" in normalized
    assert normalized["groupedActionPlan"]["sections"][0]["title"] == "Chung"
    assert "grouped_action_plan" not in normalized
    assert normalized["analysisFeatureSet"] == GROUPED_ACTION_PLAN_FEATURE_SET


def test_stale_reason_when_analysis_feature_set_changes():
    from app.services.analysis_runs import (
        ANALYSIS_INPUT_MODE_CANONICAL,
        DEFAULT_ANALYSIS_FEATURE_SET,
        AnalysisCacheIdentity,
        stale_reason_for_identity,
    )

    identity = AnalysisCacheIdentity(
        meeting_id=42,
        owner_id="7",
        canonical_transcript_hash="hash-1",
        canonical_transcript_version="canonical-transcript-v2",
        provider="gemini",
        model="gemini-2.5-flash",
        prompt_version=PROMPT_VERSION,
        schema_version=SCHEMA_VERSION,
        transcript_language="vi",
        recognition_mode="batch",
        speaker_stabilization_version="speaker-stabilization-v1",
        analysis_input_mode=ANALYSIS_INPUT_MODE_CANONICAL,
        analysis_feature_set=DEFAULT_ANALYSIS_FEATURE_SET,
    )
    run = SimpleNamespace(
        owner_id="7",
        recognition_mode="batch",
        transcript_language="vi",
        canonical_transcript_hash="hash-1",
        canonical_transcript_version="canonical-transcript-v2",
        provider="gemini",
        model="gemini-2.5-flash",
        prompt_version=PROMPT_VERSION,
        schema_version=SCHEMA_VERSION,
        analysis_input_mode=ANALYSIS_INPUT_MODE_CANONICAL,
        speaker_stabilization_version="speaker-stabilization-v1",
        analysis_payload_json={"analysisFeatureSet": "legacy-v2-without-grouped-plan"},
    )

    reason = stale_reason_for_identity(identity, run)

    assert reason == "analysis_feature_set_changed"


def test_completed_run_lookup_filters_by_analysis_feature_set():
    from app.services.analysis_runs import (
        ANALYSIS_INPUT_MODE_CANONICAL,
        DEFAULT_ANALYSIS_FEATURE_SET,
        AnalysisCacheIdentity,
        _run_analysis_feature_set,
    )

    grouped_run = MagicMock()
    grouped_run.analysis_payload_json = {
        "analysisFeatureSet": DEFAULT_ANALYSIS_FEATURE_SET
    }
    legacy_run = MagicMock()
    legacy_run.analysis_payload_json = {
        "analysisFeatureSet": "legacy-v2-without-grouped-plan"
    }

    identity = AnalysisCacheIdentity(
        meeting_id=99,
        owner_id="1",
        canonical_transcript_hash="hash",
        canonical_transcript_version="canonical-transcript-v2",
        provider="gemini",
        model="gemini-2.5-flash",
        prompt_version=PROMPT_VERSION,
        schema_version=SCHEMA_VERSION,
        transcript_language="vi",
        recognition_mode="batch",
        speaker_stabilization_version=None,
        analysis_input_mode=ANALYSIS_INPUT_MODE_CANONICAL,
        analysis_feature_set=DEFAULT_ANALYSIS_FEATURE_SET,
    )

    selected = next(
        run
        for run in (legacy_run, grouped_run)
        if _run_analysis_feature_set(run) == identity.analysis_feature_set
    )

    assert selected is grouped_run
