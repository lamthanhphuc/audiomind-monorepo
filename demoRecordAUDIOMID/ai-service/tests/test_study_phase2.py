"""Unit tests for Phase 2 study hashing, aggregation, and validators."""

from __future__ import annotations

from app.services.study import (
    AGG_COMPLETED,
    AGG_FAILED,
    AGG_PARTIALLY_FAILED,
    AGG_PROCESSING,
    AGG_QUEUED,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PROCESSING,
    STATUS_QUEUED,
    aggregate_statuses,
    build_options_hash,
    build_source_hash,
)
from app.services.study.artifacts import (
    validate_exam_brief,
    validate_flashcards,
    validate_mcq,
    validate_mind_map,
    validate_options,
)
from app.services.study.synthesis import normalize_synthesis
import pytest

from app.services.study import StudyValidationError


def test_source_hash_stable_regardless_of_order():
    a = build_source_hash(
        subject_id=12,
        source_selection_mode="EXPLICIT",
        sources=[
            {"meetingId": 2, "transcriptHash": "b", "analysisRunId": 2, "analysisVersion": "v1"},
            {"meetingId": 1, "transcriptHash": "a", "analysisRunId": 1, "analysisVersion": "v1"},
        ],
    )
    b = build_source_hash(
        subject_id=12,
        source_selection_mode="EXPLICIT",
        sources=[
            {"meetingId": 1, "transcriptHash": "a", "analysisRunId": 1, "analysisVersion": "v1"},
            {"meetingId": 2, "transcriptHash": "b", "analysisRunId": 2, "analysisVersion": "v1"},
        ],
    )
    assert a == b


def test_source_hash_changes_when_transcript_changes():
    base = {
        "subject_id": 12,
        "source_selection_mode": "ALL_READY",
        "sources": [
            {"meetingId": 1, "transcriptHash": "a", "analysisRunId": 1, "analysisVersion": "v1"},
        ],
    }
    h1 = build_source_hash(**base)
    base["sources"][0]["transcriptHash"] = "changed"
    h2 = build_source_hash(**base)
    assert h1 != h2


def test_options_hash_and_validate_options():
    opts = validate_options({"language": "vi", "difficulty": "MIXED", "flashcardCount": 20})
    assert build_options_hash(opts) == build_options_hash(dict(opts))
    with pytest.raises(StudyValidationError):
        validate_options({"flashcardCount": 1})


def test_aggregate_statuses():
    assert aggregate_statuses([STATUS_QUEUED, STATUS_COMPLETED]) == AGG_QUEUED
    assert aggregate_statuses([STATUS_PROCESSING, STATUS_QUEUED]) == AGG_PROCESSING
    assert aggregate_statuses([STATUS_COMPLETED, STATUS_COMPLETED]) == AGG_COMPLETED
    assert aggregate_statuses([STATUS_COMPLETED, STATUS_FAILED]) == AGG_PARTIALLY_FAILED
    assert aggregate_statuses([STATUS_FAILED, STATUS_FAILED]) == AGG_FAILED
    assert aggregate_statuses([STATUS_COMPLETED, STATUS_FAILED]) != AGG_COMPLETED


def test_validate_mind_map_rejects_orphan_and_keeps_root():
    content = validate_mind_map(
        {
            "root": {"id": "root", "label": "SWP", "type": "SUBJECT"},
            "nodes": [
                {
                    "id": "t1",
                    "parentId": "root",
                    "label": "Topic",
                    "type": "TOPIC",
                    "sourceMeetingIds": [1],
                    "sourceSegmentIds": ["seg-1"],
                },
                {
                    "id": "orphan",
                    "parentId": "missing",
                    "label": "Bad",
                    "type": "CONCEPT",
                    "sourceMeetingIds": [1],
                    "sourceSegmentIds": [],
                },
            ],
            "edges": [{"source": "root", "target": "t1", "relation": "CONTAINS"}],
        },
        allowed_meetings={1},
        allowed_segments={"seg-1"},
    )
    assert content["root"]["label"] == "SWP"
    assert len(content["nodes"]) == 1


def test_validate_flashcards_and_mcq():
    cards = validate_flashcards(
        {
            "cards": [
                {
                    "id": "c1",
                    "front": "Q?",
                    "back": "A",
                    "sourceMeetingIds": [1],
                    "sourceSegmentIds": ["s1"],
                },
                {"id": "c2", "front": "Q?", "back": "dup"},
                {"id": "c3", "front": "", "back": "x"},
            ]
        },
        max_count=10,
        allowed_meetings={1},
        allowed_segments={"s1"},
    )
    assert len(cards["cards"]) == 1

    mcq = validate_mcq(
        {
            "questions": [
                {
                    "id": "q1",
                    "question": "Which?",
                    "options": [
                        {"id": "A", "text": "one"},
                        {"id": "B", "text": "two"},
                        {"id": "C", "text": "three"},
                        {"id": "D", "text": "four"},
                    ],
                    "correctOptionId": "A",
                    "explanation": "because",
                    "sourceMeetingIds": [1],
                    "sourceSegmentIds": ["s1"],
                }
            ]
        },
        max_count=5,
        allowed_meetings={1},
        allowed_segments={"s1"},
    )
    assert len(mcq["questions"]) == 1


def test_exam_brief_formulas_empty_ok():
    brief = validate_exam_brief(
        {
            "overview": "Overview",
            "mustRemember": [],
            "importantTerms": [],
            "formulas": [],
            "commonMistakes": [],
            "likelyExamTopics": ["Requirement"],
            "lastMinuteChecklist": [],
            "sourceMeetingIds": [1],
        },
        allowed_meetings={1},
    )
    assert brief["formulas"] == []
    assert "ưu tiên" in brief["likelyExamTopics"][0].lower() or "ôn" in brief["likelyExamTopics"][0].lower()


def test_normalize_synthesis_filters_invalid_evidence():
    content = normalize_synthesis(
        {
            "subjectOverview": "O",
            "learningObjectives": [],
            "chapters": [
                {
                    "id": "c1",
                    "title": "T",
                    "summary": "S",
                    "keyPoints": [
                        {
                            "content": "K",
                            "sourceMeetingIds": [1, 99],
                            "sourceSegmentIds": ["ok", "nope"],
                        }
                    ],
                    "keywords": [],
                    "glossary": [],
                    "mustRemember": [],
                    "sourceMeetingIds": [1],
                    "sourceSegmentIds": ["ok"],
                }
            ],
            "importantTerms": [],
            "mustRemember": [],
            "knowledgeGaps": [],
            "examFocus": [],
        },
        allowed_meeting_ids={1},
        allowed_segments_by_meeting={1: {"ok"}},
    )
    assert content.chapters[0].keyPoints[0].sourceMeetingIds == [1]
    assert content.chapters[0].keyPoints[0].sourceSegmentIds == ["ok"]
