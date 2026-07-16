"""Schema and Gemini wiring checks for educationStudy."""

from __future__ import annotations

from unittest.mock import patch

from app.services.ai_analyzer import AIAnalyzer
from app.services.education_analysis import education_versions


def test_analyze_with_gemini_education_normalizes_and_sets_versions():
    analyzer = AIAnalyzer(api_key="test-key-not-placeholder", provider="gemini")
    allowed = ["meeting-12-start-10.000-speaker_1"]
    gemini_payload = {
        "summary": "Tóm tắt buổi học",
        "meetingSummary": "Tóm tắt buổi học",
        "keywords": ["ML"],
        "technicalTerms": [],
        "painPoints": [],
        "action_items": [],
        "keyDecisions": [],
        "risks": [],
        "blockers": [],
        "questions": [],
        "deadlines": [],
        "owners": [],
        "nextSteps": [],
        "businessImpact": "",
        "customerImpact": "",
        "technicalImpact": "",
        "confidence": 0.7,
        "domainMode": "education",
        "groupedActionPlan": {
            "version": "education-study-v1",
            "language": "vi",
            "intro": "",
            "sections": [],
            "notes": [],
        },
        "educationStudy": {
            "title": "ML 101",
            "overview": "Giới thiệu",
            "learningObjectives": ["Hiểu supervised"],
            "sections": [
                {
                    "id": "section-1",
                    "title": "Supervised",
                    "summary": "Có nhãn",
                    "keyPoints": ["label"],
                    "keywords": ["supervised"],
                    "sourceSegmentIds": [
                        "meeting-12-start-10.000-speaker_1",
                        "fake-id",
                    ],
                }
            ],
            "keyPoints": [],
            "keywords": ["ML"],
            "glossary": [],
            "mustRemember": [],
            "unclearPoints": [],
        },
    }

    with patch.object(
        analyzer,
        "_call_gemini_text",
        return_value=__import__("json").dumps(gemini_payload, ensure_ascii=False),
    ):
        result = analyzer._analyze_with_gemini(
            "[SEGMENT_ID=meeting-12-start-10.000-speaker_1]\n[00:10] SPEAKER_1: supervised learning",
            metadata={
                "domainMode": "education",
                "source": "upload",
                "meetingId": 12,
                "allowedSegmentIds": allowed,
            },
        )

    versions = education_versions()
    assert result["promptVersion"] == versions["promptVersion"]
    assert result["schemaVersion"] == versions["schemaVersion"]
    assert result["analysisFeatureSet"] == versions["analysisFeatureSet"]
    assert result["summary"] == "Tóm tắt buổi học"
    assert result["educationStudy"]["sections"][0]["sourceSegmentIds"] == [
        "meeting-12-start-10.000-speaker_1"
    ]


def test_analyze_with_gemini_education_plain_realtime_marks_evidence_unavailable():
    analyzer = AIAnalyzer(api_key="test-key-not-placeholder", provider="gemini")
    gemini_payload = {
        "summary": "Plain",
        "meetingSummary": "Plain",
        "keywords": [],
        "technicalTerms": [],
        "painPoints": [],
        "action_items": [],
        "keyDecisions": [],
        "risks": [],
        "blockers": [],
        "questions": [],
        "deadlines": [],
        "owners": [],
        "nextSteps": [],
        "confidence": 0.4,
        "domainMode": "education",
        "groupedActionPlan": {
            "version": "x",
            "language": "vi",
            "intro": "",
            "sections": [],
            "notes": [],
        },
        "educationStudy": {
            "title": "Plain lesson",
            "overview": "No markers",
            "learningObjectives": [],
            "sections": [],
            "keyPoints": [
                {
                    "content": "A",
                    "importance": "HIGH",
                    "sourceSegmentIds": ["should-be-cleared"],
                }
            ],
            "keywords": [],
            "glossary": [],
            "mustRemember": [],
            "unclearPoints": [],
        },
    }

    with patch.object(
        analyzer,
        "_call_gemini_text",
        return_value=__import__("json").dumps(gemini_payload, ensure_ascii=False),
    ):
        result = analyzer._analyze_with_gemini(
            "SPEAKER_1: plain text without markers",
            metadata={
                "domainMode": "education",
                "source": "realtime",
                "meetingId": 12,
                "allowedSegmentIds": [],
                "evidenceUnavailable": True,
            },
        )

    assert result["evidenceUnavailable"] is True
    assert result["educationStudy"]["keyPoints"][0]["sourceSegmentIds"] == []
    assert result["summary"] == "Plain"


def test_analyze_business_does_not_force_education_study():
    analyzer = AIAnalyzer(api_key="test-key-not-placeholder", provider="gemini")
    gemini_payload = {
        "summary": "Biz",
        "meetingSummary": "Biz",
        "keywords": ["KPI"],
        "technicalTerms": [],
        "painPoints": [],
        "action_items": [],
        "keyDecisions": [],
        "risks": [],
        "blockers": [],
        "questions": [],
        "deadlines": [],
        "owners": [],
        "nextSteps": [],
        "confidence": 0.5,
        "domainMode": "business",
        "groupedActionPlan": {
            "version": "x",
            "language": "vi",
            "intro": "",
            "sections": [],
            "notes": [],
        },
    }
    with patch.object(
        analyzer,
        "_call_gemini_text",
        return_value=__import__("json").dumps(gemini_payload, ensure_ascii=False),
    ) as mocked:
        result = analyzer._analyze_with_gemini(
            "SPEAKER_1: KPI review",
            metadata={"domainMode": "business", "source": "upload"},
        )
        schema = mocked.call_args.kwargs.get("response_schema")

    assert schema is not None
    assert "educationStudy" not in schema.get("properties", {})
    assert "educationStudy" not in result
    assert result["domainMode"] == "business"


def test_metadata_prompt_excludes_internal_allowed_segment_ids():
    analyzer = AIAnalyzer(api_key="test-key-not-placeholder", provider="gemini")
    segment_id = "meeting-12-start-10.000-speaker_1"

    result = analyzer._metadata_to_prompt_lines(
        {
            "source": "upload",
            "domainMode": "education",
            "meetingId": 12,
            "allowedSegmentIds": [segment_id],
            "language": "vi",
        }
    )

    assert "source" in result
    assert "domainMode" in result
    assert "meetingId" in result
    assert "allowedSegmentIds" not in result
    assert segment_id not in result

    snake_result = analyzer._metadata_to_prompt_lines(
        {
            "allowed_segment_ids": [segment_id],
        }
    )
    assert "allowed_segment_ids" not in snake_result
    assert segment_id not in snake_result
