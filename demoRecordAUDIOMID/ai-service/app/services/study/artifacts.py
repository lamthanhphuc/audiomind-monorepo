"""Study artifact schemas, prompts, and validators."""

from __future__ import annotations

import json
import logging
from typing import Any, Callable

from pydantic import BaseModel, Field

from app.config import get_settings
from app.services.study import (
    ARTIFACT_ESSAY_QUESTIONS,
    ARTIFACT_EXAM_BRIEF,
    ARTIFACT_FLASHCARDS,
    ARTIFACT_MIND_MAP,
    ARTIFACT_MULTIPLE_CHOICE,
    ARTIFACT_VERSIONS,
    StudyValidationError,
)
from app.services.study.evidence import (
    build_allowed_segments_by_meeting,
    estimate_tokens,
    normalize_evidence_pairs,
    pairs_to_meeting_ids,
    pairs_to_segment_ids,
)
from app.services.study.exceptions import classify_provider_exception
from app.services.study.synthesis import (
    MAX_ALLOWED_SEGMENT_IDS,
    _cap_allowed_segment_ids,
    _fit_within_token_budget,
    assert_prompt_within_limit,
)

logger = logging.getLogger(__name__)

_DIFFICULTIES = {"EASY", "MEDIUM", "HARD"}


def _normalize_difficulty(value: str | None) -> str:
    difficulty = str(value or "MEDIUM").upper()
    return difficulty if difficulty in _DIFFICULTIES else "MEDIUM"


class EvidencePair(BaseModel):
    meetingId: int
    segmentId: str


class MindMapNode(BaseModel):
    id: str
    parentId: str | None = None
    label: str = ""
    description: str | None = None
    type: str = "CONCEPT"
    evidence: list[EvidencePair] = Field(default_factory=list)
    sourceMeetingIds: list[int] = Field(default_factory=list)
    sourceSegmentIds: list[str] = Field(default_factory=list)


class MindMapRoot(BaseModel):
    id: str = "root"
    label: str = ""
    type: str = "SUBJECT"


class MindMapEdge(BaseModel):
    source: str
    target: str
    relation: str = "CONTAINS"


class MindMapContent(BaseModel):
    root: MindMapRoot = Field(default_factory=MindMapRoot)
    nodes: list[MindMapNode] = Field(default_factory=list)
    edges: list[MindMapEdge] = Field(default_factory=list)


class Flashcard(BaseModel):
    id: str = ""
    front: str = ""
    back: str = ""
    hint: str | None = None
    tags: list[str] = Field(default_factory=list)
    difficulty: str = "MEDIUM"
    evidence: list[EvidencePair] = Field(default_factory=list)
    sourceMeetingIds: list[int] = Field(default_factory=list)
    sourceSegmentIds: list[str] = Field(default_factory=list)


class FlashcardsContent(BaseModel):
    cards: list[Flashcard] = Field(default_factory=list)


class McqOption(BaseModel):
    id: str
    text: str


class McqQuestion(BaseModel):
    id: str = ""
    question: str = ""
    options: list[McqOption] = Field(default_factory=list)
    correctOptionId: str = ""
    explanation: str = ""
    difficulty: str = "MEDIUM"
    evidence: list[EvidencePair] = Field(default_factory=list)
    sourceMeetingIds: list[int] = Field(default_factory=list)
    sourceSegmentIds: list[str] = Field(default_factory=list)


class MultipleChoiceContent(BaseModel):
    questions: list[McqQuestion] = Field(default_factory=list)


class RubricItem(BaseModel):
    criterion: str = ""
    points: int = 0


class EssayQuestion(BaseModel):
    id: str = ""
    question: str = ""
    suggestedOutline: list[str] = Field(default_factory=list)
    keyPoints: list[str] = Field(default_factory=list)
    rubric: list[RubricItem] = Field(default_factory=list)
    difficulty: str = "MEDIUM"
    evidence: list[EvidencePair] = Field(default_factory=list)
    sourceMeetingIds: list[int] = Field(default_factory=list)
    sourceSegmentIds: list[str] = Field(default_factory=list)


class EssayContent(BaseModel):
    questions: list[EssayQuestion] = Field(default_factory=list)


class ExamBriefContent(BaseModel):
    overview: str = ""
    mustRemember: list[str] = Field(default_factory=list)
    importantTerms: list[str] = Field(default_factory=list)
    formulas: list[str] = Field(default_factory=list)
    commonMistakes: list[str] = Field(default_factory=list)
    likelyExamTopics: list[str] = Field(default_factory=list)
    lastMinuteChecklist: list[str] = Field(default_factory=list)
    evidence: list[EvidencePair] = Field(default_factory=list)
    sourceMeetingIds: list[int] = Field(default_factory=list)
    sourceSegmentIds: list[str] = Field(default_factory=list)


def artifact_system_instruction(artifact_type: str) -> str:
    return (
        f"You generate AudioMind study artifact type {artifact_type}. "
        "Use ONLY provided synthesis/education sources. No invented facts or segment IDs. "
        "Return pure JSON. Empty arrays []. Vietnamese Unicode when language=vi."
    )


def validate_options(options: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    language = str(options.get("language") or "vi")
    difficulty = str(options.get("difficulty") or "MIXED").upper()
    if difficulty not in {"EASY", "MEDIUM", "HARD", "MIXED"}:
        raise StudyValidationError("INVALID_DIFFICULTY", f"Invalid difficulty: {difficulty}")
    flashcard_count = int(options.get("flashcardCount") or 20)
    mcq_count = int(options.get("multipleChoiceCount") or 15)
    essay_count = int(options.get("essayQuestionCount") or 5)
    if not settings.study_flashcard_count_min <= flashcard_count <= settings.study_flashcard_count_max:
        raise StudyValidationError("INVALID_FLASHCARD_COUNT", "flashcardCount out of range")
    if not settings.study_mcq_count_min <= mcq_count <= settings.study_mcq_count_max:
        raise StudyValidationError("INVALID_MCQ_COUNT", "multipleChoiceCount out of range")
    if not settings.study_essay_count_min <= essay_count <= settings.study_essay_count_max:
        raise StudyValidationError("INVALID_ESSAY_COUNT", "essayQuestionCount out of range")
    return {
        "language": language,
        "difficulty": difficulty,
        "flashcardCount": flashcard_count,
        "multipleChoiceCount": mcq_count,
        "essayQuestionCount": essay_count,
    }


def _resolve_evidence(
    *,
    evidence: list[EvidencePair],
    meeting_ids: list[int],
    segment_ids: list[str],
    allowed_segments_by_meeting: dict[int, set[str]],
) -> tuple[list[int], list[str], list[EvidencePair]]:
    """Resolve an item's evidence via meeting-scoped pairs (never a positional zip)."""
    pairs = normalize_evidence_pairs(
        evidence=[p.model_dump() for p in evidence] if evidence else None,
        meeting_ids=meeting_ids,
        segment_ids=segment_ids,
        allowed_segments_by_meeting=allowed_segments_by_meeting,
    )
    return (
        pairs_to_meeting_ids(pairs),
        pairs_to_segment_ids(pairs),
        [EvidencePair(**p) for p in pairs],
    )


def _enforce_min_count(
    count: int, *, min_count: int, max_count: int, message: str
) -> None:
    if max_count >= min_count and count < min_count:
        raise StudyValidationError("FAILED_VALIDATION", message)


EVIDENCE_SCHEMA: dict[str, Any] = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "meetingId": {"type": "INTEGER"},
            "segmentId": {"type": "STRING"},
        },
        "required": ["meetingId", "segmentId"],
    },
}


def _mind_map_gemini_schema() -> dict[str, Any]:
    return {
        "type": "OBJECT",
        "properties": {
            "root": {
                "type": "OBJECT",
                "properties": {
                    "id": {"type": "STRING"},
                    "label": {"type": "STRING"},
                    "type": {"type": "STRING"},
                },
                "required": ["id", "label"],
            },
            "nodes": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "id": {"type": "STRING"},
                        "parentId": {"type": "STRING"},
                        "label": {"type": "STRING"},
                        "description": {"type": "STRING"},
                        "type": {"type": "STRING"},
                        "evidence": EVIDENCE_SCHEMA,
                    },
                    "required": ["id", "parentId", "label"],
                },
            },
            "edges": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "source": {"type": "STRING"},
                        "target": {"type": "STRING"},
                        "relation": {"type": "STRING"},
                    },
                    "required": ["source", "target"],
                },
            },
        },
        "required": ["root", "nodes", "edges"],
    }


def _flashcards_gemini_schema() -> dict[str, Any]:
    return {
        "type": "OBJECT",
        "properties": {
            "cards": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "id": {"type": "STRING"},
                        "front": {"type": "STRING"},
                        "back": {"type": "STRING"},
                        "hint": {"type": "STRING"},
                        "tags": {"type": "ARRAY", "items": {"type": "STRING"}},
                        "difficulty": {"type": "STRING"},
                        "evidence": EVIDENCE_SCHEMA,
                    },
                    "required": ["front", "back"],
                },
            },
        },
        "required": ["cards"],
    }


def _mcq_gemini_schema() -> dict[str, Any]:
    return {
        "type": "OBJECT",
        "properties": {
            "questions": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "id": {"type": "STRING"},
                        "question": {"type": "STRING"},
                        "options": {
                            "type": "ARRAY",
                            "items": {
                                "type": "OBJECT",
                                "properties": {
                                    "id": {"type": "STRING"},
                                    "text": {"type": "STRING"},
                                },
                                "required": ["id", "text"],
                            },
                        },
                        "correctOptionId": {"type": "STRING"},
                        "explanation": {"type": "STRING"},
                        "difficulty": {"type": "STRING"},
                        "evidence": EVIDENCE_SCHEMA,
                    },
                    "required": ["question", "options", "correctOptionId", "explanation"],
                },
            },
        },
        "required": ["questions"],
    }


def _essay_gemini_schema() -> dict[str, Any]:
    return {
        "type": "OBJECT",
        "properties": {
            "questions": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "id": {"type": "STRING"},
                        "question": {"type": "STRING"},
                        "suggestedOutline": {"type": "ARRAY", "items": {"type": "STRING"}},
                        "keyPoints": {"type": "ARRAY", "items": {"type": "STRING"}},
                        "rubric": {
                            "type": "ARRAY",
                            "items": {
                                "type": "OBJECT",
                                "properties": {
                                    "criterion": {"type": "STRING"},
                                    "points": {"type": "INTEGER"},
                                },
                                "required": ["criterion", "points"],
                            },
                        },
                        "difficulty": {"type": "STRING"},
                        "evidence": EVIDENCE_SCHEMA,
                    },
                    "required": ["question"],
                },
            },
        },
        "required": ["questions"],
    }


def _exam_brief_gemini_schema() -> dict[str, Any]:
    return {
        "type": "OBJECT",
        "properties": {
            "overview": {"type": "STRING"},
            "mustRemember": {"type": "ARRAY", "items": {"type": "STRING"}},
            "importantTerms": {"type": "ARRAY", "items": {"type": "STRING"}},
            "formulas": {"type": "ARRAY", "items": {"type": "STRING"}},
            "commonMistakes": {"type": "ARRAY", "items": {"type": "STRING"}},
            "likelyExamTopics": {"type": "ARRAY", "items": {"type": "STRING"}},
            "lastMinuteChecklist": {"type": "ARRAY", "items": {"type": "STRING"}},
            "evidence": EVIDENCE_SCHEMA,
        },
        "required": ["overview"],
    }


_ARTIFACT_SCHEMA_BUILDERS: dict[str, Callable[[], dict[str, Any]]] = {
    ARTIFACT_MIND_MAP: _mind_map_gemini_schema,
    ARTIFACT_FLASHCARDS: _flashcards_gemini_schema,
    ARTIFACT_MULTIPLE_CHOICE: _mcq_gemini_schema,
    ARTIFACT_ESSAY_QUESTIONS: _essay_gemini_schema,
    ARTIFACT_EXAM_BRIEF: _exam_brief_gemini_schema,
}


def artifact_gemini_schema(artifact_type: str) -> dict[str, Any]:
    builder = _ARTIFACT_SCHEMA_BUILDERS.get(artifact_type)
    if builder is None:
        raise StudyValidationError("UNKNOWN_ARTIFACT_TYPE", artifact_type)
    return builder()


def validate_mind_map(
    raw: dict[str, Any],
    *,
    allowed_segments_by_meeting: dict[int, set[str]],
) -> dict[str, Any]:
    content = MindMapContent.model_validate(raw or {})
    root_id = (content.root.id or "root").strip() or "root"
    content.root.id = root_id
    if not content.root.label.strip():
        raise StudyValidationError("INVALID_MIND_MAP", "Root label required")

    node_ids: set[str] = {root_id}
    for node in content.nodes:
        node_id = (node.id or "").strip()
        if not node_id:
            raise StudyValidationError("FAILED_VALIDATION", "Mind map node missing id")
        if node_id in node_ids:
            raise StudyValidationError(
                "FAILED_VALIDATION", f"Duplicate mind map node id: {node_id}"
            )
        node_ids.add(node_id)
        node.id = node_id

    parents = {n.id: n.parentId for n in content.nodes}
    valid_nodes: list[MindMapNode] = []
    for node in content.nodes:
        parent = node.parentId
        if not parent:
            continue  # orphan: no parent reference
        seen: set[str] = set()
        ok = True
        while parent and parent != root_id:
            if parent in seen or parent not in node_ids:
                ok = False
                break
            seen.add(parent)
            parent = parents.get(parent)
        if not ok:
            continue  # cycle or dangling parent reference

        mids, sids, pairs = _resolve_evidence(
            evidence=node.evidence,
            meeting_ids=node.sourceMeetingIds,
            segment_ids=node.sourceSegmentIds,
            allowed_segments_by_meeting=allowed_segments_by_meeting,
        )
        node.sourceMeetingIds = mids
        node.sourceSegmentIds = sids
        node.evidence = pairs
        valid_nodes.append(node)

    content.nodes = valid_nodes
    valid_ids = {root_id} | {n.id for n in valid_nodes}
    content.edges = [
        e for e in content.edges if e.source in valid_ids and e.target in valid_ids
    ]
    return content.model_dump()


def validate_flashcards(
    raw: dict[str, Any],
    *,
    max_count: int,
    allowed_segments_by_meeting: dict[int, set[str]],
) -> dict[str, Any]:
    settings = get_settings()
    content = FlashcardsContent.model_validate(raw or {})
    seen_front: set[str] = set()
    cards: list[Flashcard] = []
    for idx, card in enumerate(content.cards, start=1):
        front = card.front.strip()
        back = card.back.strip()
        if not front or not back:
            continue
        key = front.lower()
        if key in seen_front:
            continue
        seen_front.add(key)
        mids, sids, pairs = _resolve_evidence(
            evidence=card.evidence,
            meeting_ids=card.sourceMeetingIds,
            segment_ids=card.sourceSegmentIds,
            allowed_segments_by_meeting=allowed_segments_by_meeting,
        )
        cards.append(
            Flashcard(
                id=card.id or f"card-{idx}",
                front=front,
                back=back,
                hint=card.hint,
                tags=card.tags,
                difficulty=_normalize_difficulty(card.difficulty),
                evidence=pairs,
                sourceMeetingIds=mids,
                sourceSegmentIds=sids,
            )
        )
        if len(cards) >= max_count:
            break
    if len(cards) < 1:
        raise StudyValidationError("INVALID_FLASHCARDS", "No valid flashcards")
    _enforce_min_count(
        len(cards),
        min_count=settings.study_flashcard_count_min,
        max_count=max_count,
        message=(
            f"Only {len(cards)} valid flashcards after filtering; "
            f"minimum {settings.study_flashcard_count_min} required"
        ),
    )
    return FlashcardsContent(cards=cards).model_dump()


def validate_mcq(
    raw: dict[str, Any],
    *,
    max_count: int,
    allowed_segments_by_meeting: dict[int, set[str]],
) -> dict[str, Any]:
    settings = get_settings()
    content = MultipleChoiceContent.model_validate(raw or {})
    questions: list[McqQuestion] = []
    for idx, q in enumerate(content.questions, start=1):
        if not q.question.strip() or not q.explanation.strip():
            continue
        option_texts: set[str] = set()
        filtered_options: list[McqOption] = []
        for opt in q.options:
            text = opt.text.strip()
            if not text or text.lower() in option_texts:
                continue
            option_texts.add(text.lower())
            filtered_options.append(McqOption(id=(opt.id or "").strip(), text=text))
        if len(filtered_options) != 4:
            continue

        # Reject colliding option ids (e.g. A,A,B,C) and non A-D ids.
        provided_ids = [(o.id or "").strip().upper() for o in filtered_options]
        if any(oid not in {"A", "B", "C", "D"} for oid in provided_ids if oid):
            continue
        if len([oid for oid in provided_ids if oid]) != len(set(oid for oid in provided_ids if oid)):
            continue

        used_ids = {oid for oid in provided_ids if oid}
        available_letters = iter(letter for letter in "ABCD" if letter not in used_ids)
        options: list[McqOption] = []
        for opt, raw_id in zip(filtered_options, provided_ids):
            option_id = raw_id or next(available_letters, "")
            if option_id not in {"A", "B", "C", "D"}:
                options = []
                break
            options.append(McqOption(id=option_id, text=opt.text))
        if len(options) != 4:
            continue

        option_ids = [o.id for o in options]
        if len(set(option_ids)) != 4:
            continue
        correct_id = (q.correctOptionId or "").strip().upper()
        if option_ids.count(correct_id) != 1:
            continue
        mids, sids, pairs = _resolve_evidence(
            evidence=q.evidence,
            meeting_ids=q.sourceMeetingIds,
            segment_ids=q.sourceSegmentIds,
            allowed_segments_by_meeting=allowed_segments_by_meeting,
        )
        questions.append(
            McqQuestion(
                id=q.id or f"mcq-{idx}",
                question=q.question.strip(),
                options=options,
                correctOptionId=correct_id,
                explanation=q.explanation.strip(),
                difficulty=_normalize_difficulty(q.difficulty),
                evidence=pairs,
                sourceMeetingIds=mids,
                sourceSegmentIds=sids,
            )
        )
        if len(questions) >= max_count:
            break
    if len(questions) < 1:
        raise StudyValidationError("INVALID_MCQ", "No valid multiple choice questions")
    _enforce_min_count(
        len(questions),
        min_count=settings.study_mcq_count_min,
        max_count=max_count,
        message=(
            f"Only {len(questions)} valid multiple choice questions after filtering; "
            f"minimum {settings.study_mcq_count_min} required"
        ),
    )
    return MultipleChoiceContent(questions=questions).model_dump()


def validate_essay(
    raw: dict[str, Any],
    *,
    max_count: int,
    allowed_segments_by_meeting: dict[int, set[str]],
) -> dict[str, Any]:
    settings = get_settings()
    content = EssayContent.model_validate(raw or {})
    questions: list[EssayQuestion] = []
    for idx, q in enumerate(content.questions, start=1):
        if not q.question.strip():
            continue
        if not q.suggestedOutline and not q.keyPoints:
            continue
        rubric = [r for r in q.rubric if r.criterion.strip() and r.points > 0]
        criteria: set[str] = set()
        unique_rubric: list[RubricItem] = []
        for r in rubric:
            if r.criterion.lower() in criteria:
                continue
            criteria.add(r.criterion.lower())
            unique_rubric.append(r)
        mids, sids, pairs = _resolve_evidence(
            evidence=q.evidence,
            meeting_ids=q.sourceMeetingIds,
            segment_ids=q.sourceSegmentIds,
            allowed_segments_by_meeting=allowed_segments_by_meeting,
        )
        questions.append(
            EssayQuestion(
                id=q.id or f"essay-{idx}",
                question=q.question.strip(),
                suggestedOutline=q.suggestedOutline,
                keyPoints=q.keyPoints,
                rubric=unique_rubric,
                difficulty=_normalize_difficulty(q.difficulty),
                evidence=pairs,
                sourceMeetingIds=mids,
                sourceSegmentIds=sids,
            )
        )
        if len(questions) >= max_count:
            break
    if len(questions) < 1:
        raise StudyValidationError("INVALID_ESSAY", "No valid essay questions")
    _enforce_min_count(
        len(questions),
        min_count=settings.study_essay_count_min,
        max_count=max_count,
        message=(
            f"Only {len(questions)} valid essay questions after filtering; "
            f"minimum {settings.study_essay_count_min} required"
        ),
    )
    return EssayContent(questions=questions).model_dump()


def _has_priority_disclaimer(text: str) -> bool:
    lowered = text.lower()
    return "ưu tiên" in lowered or "tài liệu" in lowered or "ôn" in lowered


def validate_exam_brief(
    raw: dict[str, Any],
    *,
    allowed_segments_by_meeting: dict[int, set[str]],
) -> dict[str, Any]:
    content = ExamBriefContent.model_validate(raw or {})
    mids, sids, pairs = _resolve_evidence(
        evidence=content.evidence,
        meeting_ids=content.sourceMeetingIds,
        segment_ids=content.sourceSegmentIds,
        allowed_segments_by_meeting=allowed_segments_by_meeting,
    )
    content.sourceMeetingIds = mids
    content.sourceSegmentIds = sids
    content.evidence = pairs
    # Formulas must reflect only what the sources actually contain — never fabricate.
    content.formulas = [str(f).strip() for f in content.formulas if str(f).strip()]
    content.mustRemember = [str(m).strip() for m in content.mustRemember if str(m).strip()]
    content.importantTerms = [str(t).strip() for t in content.importantTerms if str(t).strip()]
    content.commonMistakes = [str(m).strip() for m in content.commonMistakes if str(m).strip()]
    content.lastMinuteChecklist = [
        str(c).strip() for c in content.lastMinuteChecklist if str(c).strip()
    ]
    content.likelyExamTopics = [
        topic
        if _has_priority_disclaimer(topic)
        else f"{topic} (ưu tiên ôn từ tài liệu đã ghi, không phải dự đoán đề)"
        for topic in (str(t).strip() for t in content.likelyExamTopics)
        if topic
    ]
    if not content.overview.strip():
        raise StudyValidationError("INVALID_EXAM_BRIEF", "overview required")
    return content.model_dump()


def _compact_artifact_meeting(source: dict[str, Any]) -> dict[str, Any]:
    """Cap segment ids and return a compact meeting payload for artifact prompts."""
    capped_ids, truncated = _cap_allowed_segment_ids(
        source.get("allowedSegmentIds") or [], max_ids=MAX_ALLOWED_SEGMENT_IDS
    )
    if truncated:
        logger.warning(
            "event=STUDY_ARTIFACT_SEGMENT_IDS_CAPPED meetingId=%s kept=%s",
            source.get("meetingId"),
            len(capped_ids),
        )
    study = source.get("educationStudy")
    if not isinstance(study, dict):
        study = {}
    return {
        "meetingId": source.get("meetingId"),
        "educationStudy": study,
        "allowedSegmentIds": capped_ids,
    }


def _build_artifact_user_prompt(
    *,
    artifact_type: str,
    prompt_version: str,
    schema_version: str,
    count_hint: int | None,
    options: dict[str, Any],
    source_payload: dict[str, Any],
) -> str:
    return (
        f"Generate {artifact_type} JSON. prompt={prompt_version} schema={schema_version}. "
        f"Requested count={count_hint}. Difficulty={options['difficulty']}. "
        f"Language={options['language']}.\n"
        f"SOURCE:\n{json.dumps(source_payload, ensure_ascii=False)}"
    )


def _prepare_artifact_prompt(
    *,
    artifact_type: str,
    prompt_version: str,
    schema_version: str,
    count_hint: int | None,
    options: dict[str, Any],
    synthesis_content: dict[str, Any] | None,
    ready_sources: list[dict[str, Any]],
    max_input_tokens: int,
    chars_per_token: int,
) -> str:
    """Build an artifact prompt that fits the hard token ceiling, or raise."""
    meetings = [_compact_artifact_meeting(s) for s in ready_sources]
    synthesis = dict(synthesis_content) if isinstance(synthesis_content, dict) else synthesis_content

    # Leave headroom for the prompt wrapper text.
    payload_budget = max(1, int(max_input_tokens * 0.85))
    meeting_budget = max(1, payload_budget // max(1, len(meetings) + (1 if synthesis else 0)))

    if isinstance(synthesis, dict):
        synthesis, _ = _fit_within_token_budget(
            synthesis, max_tokens=meeting_budget, chars_per_token=chars_per_token
        )

    compacted_meetings: list[dict[str, Any]] = []
    for meeting in meetings:
        study = meeting.get("educationStudy") or {}
        if isinstance(study, dict) and study:
            fitted_study, _ = _fit_within_token_budget(
                dict(study), max_tokens=meeting_budget, chars_per_token=chars_per_token
            )
            meeting = {**meeting, "educationStudy": fitted_study}
        compacted_meetings.append(meeting)

    source_payload: dict[str, Any] = {
        "synthesis": synthesis,
        "meetings": compacted_meetings,
        "options": options,
    }

    for round_idx in range(24):
        prompt = _build_artifact_user_prompt(
            artifact_type=artifact_type,
            prompt_version=prompt_version,
            schema_version=schema_version,
            count_hint=count_hint,
            options=options,
            source_payload=source_payload,
        )
        tokens = estimate_tokens(prompt, chars_per_token=chars_per_token)
        if tokens <= max_input_tokens:
            return prompt

        # Shrink further: prefer trimming educationStudy / synthesis list fields.
        shrink_budget = max(1, meeting_budget // (2 ** min(round_idx, 8)))
        if isinstance(source_payload.get("synthesis"), dict):
            source_payload["synthesis"], _ = _fit_within_token_budget(
                dict(source_payload["synthesis"]),
                max_tokens=shrink_budget,
                chars_per_token=chars_per_token,
            )
        next_meetings: list[dict[str, Any]] = []
        for meeting in source_payload["meetings"]:
            study = meeting.get("educationStudy") or {}
            if isinstance(study, dict) and study:
                fitted, _ = _fit_within_token_budget(
                    dict(study), max_tokens=shrink_budget, chars_per_token=chars_per_token
                )
                meeting = {**meeting, "educationStudy": fitted}
            # Cap segment ids harder on later rounds.
            if round_idx >= 8:
                ids = list(meeting.get("allowedSegmentIds") or [])
                keep = max(1, len(ids) // 2) if ids else 0
                meeting = {**meeting, "allowedSegmentIds": ids[:keep]}
            next_meetings.append(meeting)
        source_payload["meetings"] = next_meetings

        if round_idx >= 16:
            # Absolute floor: provenance + tiny stubs only.
            source_payload["synthesis"] = (
                {
                    "subjectOverview": str(
                        (source_payload.get("synthesis") or {}).get("subjectOverview") or ""
                    )[:40]
                }
                if isinstance(source_payload.get("synthesis"), dict)
                else None
            )
            source_payload["meetings"] = [
                {
                    "meetingId": m.get("meetingId"),
                    "educationStudy": {
                        "overview": str((m.get("educationStudy") or {}).get("overview") or "")[:40]
                    },
                    "allowedSegmentIds": (m.get("allowedSegmentIds") or [])[:8],
                }
                for m in source_payload["meetings"]
            ]

    prompt = _build_artifact_user_prompt(
        artifact_type=artifact_type,
        prompt_version=prompt_version,
        schema_version=schema_version,
        count_hint=count_hint,
        options=options,
        source_payload=source_payload,
    )
    assert_prompt_within_limit(
        prompt, max_input_tokens=max_input_tokens, chars_per_token=chars_per_token
    )
    return prompt


def generate_artifact_content(
    artifact_type: str,
    *,
    synthesis_content: dict[str, Any] | None,
    ready_sources: list[dict[str, Any]],
    options: dict[str, Any],
    call_gemini: Callable[..., str],
) -> dict[str, Any]:
    options = validate_options(options)
    prompt_version, schema_version = ARTIFACT_VERSIONS[artifact_type]
    allowed_segments_by_meeting = build_allowed_segments_by_meeting(ready_sources)

    settings = get_settings()
    max_input_tokens = max(1, int(settings.subject_synthesis_max_input_tokens))
    chars_per_token = max(1, int(settings.subject_synthesis_chars_per_token))

    count_hint = {
        ARTIFACT_FLASHCARDS: options["flashcardCount"],
        ARTIFACT_MULTIPLE_CHOICE: options["multipleChoiceCount"],
        ARTIFACT_ESSAY_QUESTIONS: options["essayQuestionCount"],
    }.get(artifact_type)

    user_prompt = _prepare_artifact_prompt(
        artifact_type=artifact_type,
        prompt_version=prompt_version,
        schema_version=schema_version,
        count_hint=count_hint,
        options=options,
        synthesis_content=synthesis_content,
        ready_sources=ready_sources,
        max_input_tokens=max_input_tokens,
        chars_per_token=chars_per_token,
    )
    # Hard ceiling: never call Gemini when the prompt still exceeds the limit.
    assert_prompt_within_limit(
        user_prompt, max_input_tokens=max_input_tokens, chars_per_token=chars_per_token
    )

    try:
        raw_text = call_gemini(
            prompt=user_prompt,
            system_prompt=artifact_system_instruction(artifact_type),
            response_schema=artifact_gemini_schema(artifact_type),
        )
        parsed = json.loads(raw_text) if isinstance(raw_text, str) else raw_text
        if not isinstance(parsed, dict):
            raise StudyValidationError("INVALID_ARTIFACT_JSON", "Artifact JSON invalid")
    except Exception as exc:  # noqa: BLE001
        raise classify_provider_exception(exc) from exc

    if artifact_type == ARTIFACT_MIND_MAP:
        return validate_mind_map(parsed, allowed_segments_by_meeting=allowed_segments_by_meeting)
    if artifact_type == ARTIFACT_FLASHCARDS:
        return validate_flashcards(
            parsed,
            max_count=options["flashcardCount"],
            allowed_segments_by_meeting=allowed_segments_by_meeting,
        )
    if artifact_type == ARTIFACT_MULTIPLE_CHOICE:
        return validate_mcq(
            parsed,
            max_count=options["multipleChoiceCount"],
            allowed_segments_by_meeting=allowed_segments_by_meeting,
        )
    if artifact_type == ARTIFACT_ESSAY_QUESTIONS:
        return validate_essay(
            parsed,
            max_count=options["essayQuestionCount"],
            allowed_segments_by_meeting=allowed_segments_by_meeting,
        )
    if artifact_type == ARTIFACT_EXAM_BRIEF:
        return validate_exam_brief(parsed, allowed_segments_by_meeting=allowed_segments_by_meeting)
    raise StudyValidationError("UNKNOWN_ARTIFACT_TYPE", artifact_type)
