"""Tests for education study models, prompt helpers, and normalization."""

from __future__ import annotations

from app.services.analysis_versioning import resolve_analysis_versions
from app.services.education_analysis import (
    EducationStudy,
    build_education_prompt_rules,
    build_education_system_instruction,
    education_study_gemini_schema,
    normalize_education_study,
    normalize_importance,
    normalize_source_segment_ids,
)
from app.services.ai_analyzer import AIAnalyzer

ALLOWED = {
    "meeting-12-start-10.000-speaker_1",
    "meeting-12-start-20.500-speaker_2",
}


def test_education_versions_from_resolver():
    versions = resolve_analysis_versions("education")
    assert versions == {
        "promptVersion": "education-analysis-v1",
        "schemaVersion": "education-study-v1",
        "analysisFeatureSet": "education-study-v1",
    }


def test_education_study_model_defaults_and_unicode():
    study = EducationStudy(
        title="Buổi học ML",
        overview="Giới thiệu Machine Learning",
        learningObjectives=["Hiểu supervised learning"],
        keywords=["Machine Learning", "học có giám sát"],
    )
    assert study.sections == []
    assert study.glossary == []
    assert "Giới thiệu" in study.overview


def test_education_schema_contains_education_study_only_for_education_domain():
    analyzer = AIAnalyzer(api_key="", provider="gemini")
    education_schema = analyzer._build_gemini_response_schema("education")
    business_schema = analyzer._build_gemini_response_schema("business")
    it_schema = analyzer._build_gemini_response_schema("it")

    assert "educationStudy" in education_schema["properties"]
    assert (
        education_schema["properties"]["educationStudy"]
        == education_study_gemini_schema()
    )
    assert "educationStudy" not in business_schema["properties"]
    assert "educationStudy" not in it_schema["properties"]


def test_education_prompt_contains_evidence_and_language_rules():
    system = build_education_system_instruction()
    rules = build_education_prompt_rules(language_hint="vi")
    assert "education-analysis-v1" in system
    assert "education-study-v1" in system
    assert "SEGMENT_ID" in rules
    assert "sourceSegmentIds" in rules
    assert "tiếng Việt" in rules
    assert "Markdown" in rules or "code fence" in rules


def test_normalize_education_null_returns_none():
    assert normalize_education_study(None, allowed_segment_ids=ALLOWED) is None
    assert normalize_education_study("bad", allowed_segment_ids=ALLOWED) is None


def test_normalize_education_full_valid_payload():
    raw = {
        "title": "  Buổi 1  ",
        "overview": "Overview",
        "learningObjectives": ["Obj 1", "obj 1", "  Obj 2 "],
        "sections": [
            {
                "id": "section-1",
                "title": "Phần 1",
                "summary": "Tóm tắt",
                "keyPoints": ["A", "a"],
                "keywords": ["ML", " ml "],
                "sourceSegmentIds": [
                    "meeting-12-start-10.000-speaker_1",
                    "meeting-12-start-10.000-speaker_1",
                ],
            }
        ],
        "keyPoints": [
            {
                "content": "Ý chính",
                "importance": " high ",
                "sourceSegmentIds": ["meeting-12-start-20.500-speaker_2"],
            }
        ],
        "keywords": ["Machine Learning", " machine learning ", "API"],
        "glossary": [
            {
                "term": "ML",
                "definition": "Machine Learning",
                "example": "  ",
                "category": None,
                "sourceSegmentIds": ["meeting-12-start-10.000-speaker_1"],
            }
        ],
        "mustRemember": [
            {
                "content": "Nhớ định nghĩa",
                "importance": "LOW",
                "reason": None,
                "sourceSegmentIds": [],
            }
        ],
        "unclearPoints": [
            {
                "content": "Chưa rõ loss",
                "reason": "Thiếu ví dụ",
                "sourceSegmentIds": ["meeting-999-start-1.000-speaker_1"],
            }
        ],
    }
    result = normalize_education_study(raw, allowed_segment_ids=ALLOWED, meeting_id=12)
    assert result is not None
    assert result["title"] == "Buổi 1"
    assert result["learningObjectives"] == ["Obj 1", "Obj 2"]
    assert result["keywords"] == ["Machine Learning", "API"]
    assert result["sections"][0]["keywords"] == ["ML"]
    assert result["sections"][0]["sourceSegmentIds"] == [
        "meeting-12-start-10.000-speaker_1"
    ]
    assert result["keyPoints"][0]["importance"] == "HIGH"
    assert result["glossary"][0]["example"] is None
    assert result["unclearPoints"][0]["sourceSegmentIds"] == []


def test_normalize_invalid_importance_defaults_to_medium():
    assert normalize_importance("weird") == "MEDIUM"
    assert normalize_importance(None) == "MEDIUM"
    result = normalize_education_study(
        {
            "title": "t",
            "overview": "o",
            "keyPoints": [{"content": "x", "importance": "NOPE"}],
        },
        allowed_segment_ids=ALLOWED,
    )
    assert result["keyPoints"][0]["importance"] == "MEDIUM"


def test_normalize_duplicate_and_missing_section_ids():
    result = normalize_education_study(
        {
            "title": "t",
            "overview": "o",
            "sections": [
                {"id": "", "title": "A", "summary": "a"},
                {"id": "section-1", "title": "B", "summary": "b"},
                {"id": "section-1", "title": "C", "summary": "c"},
            ],
        },
        allowed_segment_ids=ALLOWED,
    )
    ids = [section["id"] for section in result["sections"]]
    assert len(ids) == len(set(ids))
    assert ids[0].startswith("section-")


def test_normalize_drops_malformed_nested_items():
    result = normalize_education_study(
        {
            "title": "t",
            "overview": "o",
            "glossary": [
                {"term": "", "definition": "x"},
                {"term": "OK", "definition": "def"},
                None,
            ],
            "mustRemember": [{"content": ""}, {"content": "Keep"}],
            "unclearPoints": [{"reason": "only"}, {"content": "Keep unclear"}],
            "keyPoints": [None, {"content": "Keep kp"}],
            "sections": [None, {"title": "", "summary": ""}],
        },
        allowed_segment_ids=ALLOWED,
    )
    assert len(result["glossary"]) == 1
    assert result["glossary"][0]["term"] == "OK"
    assert len(result["mustRemember"]) == 1
    assert len(result["unclearPoints"]) == 1
    assert len(result["keyPoints"]) == 1
    assert result["sections"] == []


def test_normalize_null_arrays_become_empty():
    result = normalize_education_study(
        {
            "title": "t",
            "overview": "o",
            "learningObjectives": None,
            "sections": None,
            "keywords": None,
            "glossary": None,
        },
        allowed_segment_ids=ALLOWED,
    )
    assert result["learningObjectives"] == []
    assert result["sections"] == []
    assert result["keywords"] == []
    assert result["glossary"] == []


def test_evidence_filter_invalid_duplicate_cross_meeting_and_empty_allowed():
    ids, dropped = normalize_source_segment_ids(
        [
            "meeting-12-start-10.000-speaker_1",
            " meeting-12-start-10.000-speaker_1 ",
            "fabricated-id",
            "meeting-99-start-1.000-speaker_1",
            123,
        ],
        allowed_segment_ids=ALLOWED,
        meeting_id=12,
    )
    assert ids == ["meeting-12-start-10.000-speaker_1"]
    assert dropped >= 3

    empty_ids, empty_dropped = normalize_source_segment_ids(
        ["meeting-12-start-10.000-speaker_1", "x"],
        allowed_segment_ids=set(),
        meeting_id=12,
    )
    assert empty_ids == []
    assert empty_dropped == 2


def test_evidence_filter_keeps_explicit_legacy_uuid_when_in_allowed_set():
    legacy_uuid = "550e8400-e29b-41d4-a716-446655440000"
    explicit_event = "evt-legacy-segment-1"
    allowed = {legacy_uuid, explicit_event, "meeting-12-start-10.000-speaker_1"}
    ids, dropped = normalize_source_segment_ids(
        [
            legacy_uuid,
            f" {explicit_event} ",
            "meeting-12-start-10.000-speaker_1",
            "not-in-allowed",
        ],
        allowed_segment_ids=allowed,
        meeting_id=12,
    )
    assert ids == [legacy_uuid, explicit_event, "meeting-12-start-10.000-speaker_1"]
    assert dropped == 1


def test_evidence_filter_drops_cross_meeting_and_fabricated_not_in_allowed():
    ids, dropped = normalize_source_segment_ids(
        [
            "meeting-99-start-1.000-speaker_1",
            "fabricated-cross-meeting-id",
            "meeting-12-start-10.000-speaker_1",
        ],
        allowed_segment_ids=ALLOWED,
        meeting_id=12,
    )
    assert ids == ["meeting-12-start-10.000-speaker_1"]
    assert dropped == 2


def test_prepare_storage_keeps_business_fields_when_education_present():
    analyzer = AIAnalyzer(api_key="valid-key", provider="gemini")
    prepared = analyzer.prepare_analysis_for_storage(
        transcript="SPEAKER: học ML",
        data={
            "summary": "Tóm tắt",
            "keywords": ["ML"],
            "action_items": [],
            "educationStudy": {
                "title": "Buổi 1",
                "overview": "Overview",
                "learningObjectives": [],
                "sections": [],
                "keyPoints": [],
                "keywords": ["ML"],
                "glossary": [],
                "mustRemember": [],
                "unclearPoints": [],
            },
            "evidenceUnavailable": True,
            "promptVersion": "education-analysis-v1",
            "schemaVersion": "education-study-v1",
            "analysisFeatureSet": "education-study-v1",
        },
    )
    assert prepared["summary"] == "Tóm tắt"
    assert prepared["educationStudy"]["title"] == "Buổi 1"
    assert prepared["evidenceUnavailable"] is True


def test_soft_fail_education_keeps_business_analysis():
    analyzer = AIAnalyzer(api_key="", provider="gemini")
    structured = analyzer._normalize_gemini_structured_analysis(
        "ok",
        {
            "summary": "Business summary",
            "keywords": ["API"],
            "action_items": [{"task": "Ship feature"}],
            "educationStudy": "not-an-object",
        },
    )
    assert structured["summary"] == "Business summary"
    assert "educationStudy" not in structured
