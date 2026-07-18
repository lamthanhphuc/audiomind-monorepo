"""Study artifact schemas, prompts, and validators."""

from __future__ import annotations

import json
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
    StudyTransientError,
    StudyValidationError,
)


class MindMapNode(BaseModel):
    id: str
    parentId: str | None = None
    label: str = ""
    description: str | None = None
    type: str = "CONCEPT"
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
    sourceMeetingIds: list[int] = Field(default_factory=list)


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


def _filter_evidence(
    meeting_ids: list[int],
    segment_ids: list[str],
    *,
    allowed_meetings: set[int],
    allowed_segments: set[str],
) -> tuple[list[int], list[str]]:
    return (
        [int(m) for m in meeting_ids if int(m) in allowed_meetings],
        [s for s in segment_ids if s in allowed_segments],
    )


def validate_mind_map(
    raw: dict[str, Any],
    *,
    allowed_meetings: set[int],
    allowed_segments: set[str],
) -> dict[str, Any]:
    content = MindMapContent.model_validate(raw or {})
    node_ids = {content.root.id}
    for node in content.nodes:
        if node.id in node_ids:
            continue
        node_ids.add(node.id)
    # Detect orphans / cycles via parent walk
    parents = {n.id: n.parentId for n in content.nodes}
    valid_nodes: list[MindMapNode] = []
    for node in content.nodes:
        if node.id == content.root.id:
            continue
        parent = node.parentId
        seen: set[str] = set()
        ok = True
        while parent and parent != content.root.id:
            if parent in seen or parent not in node_ids:
                ok = False
                break
            seen.add(parent)
            parent = parents.get(parent)
        if not ok or not node.parentId:
            continue
        mids, sids = _filter_evidence(
            node.sourceMeetingIds,
            node.sourceSegmentIds,
            allowed_meetings=allowed_meetings,
            allowed_segments=allowed_segments,
        )
        node.sourceMeetingIds = mids
        node.sourceSegmentIds = sids
        valid_nodes.append(node)
    content.nodes = valid_nodes
    valid_ids = {content.root.id} | {n.id for n in valid_nodes}
    content.edges = [
        e
        for e in content.edges
        if e.source in valid_ids and e.target in valid_ids
    ]
    if not content.root.label.strip():
        raise StudyValidationError("INVALID_MIND_MAP", "Root label required")
    return content.model_dump()


def validate_flashcards(
    raw: dict[str, Any],
    *,
    max_count: int,
    allowed_meetings: set[int],
    allowed_segments: set[str],
) -> dict[str, Any]:
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
        mids, sids = _filter_evidence(
            card.sourceMeetingIds,
            card.sourceSegmentIds,
            allowed_meetings=allowed_meetings,
            allowed_segments=allowed_segments,
        )
        cards.append(
            Flashcard(
                id=card.id or f"card-{idx}",
                front=front,
                back=back,
                hint=card.hint,
                tags=card.tags,
                difficulty=card.difficulty or "MEDIUM",
                sourceMeetingIds=mids,
                sourceSegmentIds=sids,
            )
        )
        if len(cards) >= max_count:
            break
    if len(cards) < 1:
        raise StudyValidationError("INVALID_FLASHCARDS", "No valid flashcards")
    return FlashcardsContent(cards=cards).model_dump()


def validate_mcq(
    raw: dict[str, Any],
    *,
    max_count: int,
    allowed_meetings: set[int],
    allowed_segments: set[str],
) -> dict[str, Any]:
    content = MultipleChoiceContent.model_validate(raw or {})
    questions: list[McqQuestion] = []
    for idx, q in enumerate(content.questions, start=1):
        if not q.question.strip() or not q.explanation.strip():
            continue
        option_texts: set[str] = set()
        options: list[McqOption] = []
        for opt in q.options:
            text = opt.text.strip()
            if not text or text.lower() in option_texts:
                continue
            option_texts.add(text.lower())
            options.append(McqOption(id=opt.id or chr(65 + len(options)), text=text))
        if len(options) != 4:
            continue
        option_ids = {o.id for o in options}
        if q.correctOptionId not in option_ids:
            continue
        mids, sids = _filter_evidence(
            q.sourceMeetingIds,
            q.sourceSegmentIds,
            allowed_meetings=allowed_meetings,
            allowed_segments=allowed_segments,
        )
        questions.append(
            McqQuestion(
                id=q.id or f"mcq-{idx}",
                question=q.question.strip(),
                options=options,
                correctOptionId=q.correctOptionId,
                explanation=q.explanation.strip(),
                difficulty=q.difficulty or "MEDIUM",
                sourceMeetingIds=mids,
                sourceSegmentIds=sids,
            )
        )
        if len(questions) >= max_count:
            break
    if len(questions) < 1:
        raise StudyValidationError("INVALID_MCQ", "No valid multiple choice questions")
    return MultipleChoiceContent(questions=questions).model_dump()


def validate_essay(
    raw: dict[str, Any],
    *,
    max_count: int,
    allowed_meetings: set[int],
    allowed_segments: set[str],
) -> dict[str, Any]:
    content = EssayContent.model_validate(raw or {})
    questions: list[EssayQuestion] = []
    for idx, q in enumerate(content.questions, start=1):
        if not q.question.strip():
            continue
        if not q.suggestedOutline and not q.keyPoints:
            continue
        rubric = [r for r in q.rubric if r.criterion.strip() and r.points > 0]
        criteria = set()
        unique_rubric: list[RubricItem] = []
        for r in rubric:
            if r.criterion.lower() in criteria:
                continue
            criteria.add(r.criterion.lower())
            unique_rubric.append(r)
        mids, sids = _filter_evidence(
            q.sourceMeetingIds,
            q.sourceSegmentIds,
            allowed_meetings=allowed_meetings,
            allowed_segments=allowed_segments,
        )
        questions.append(
            EssayQuestion(
                id=q.id or f"essay-{idx}",
                question=q.question.strip(),
                suggestedOutline=q.suggestedOutline,
                keyPoints=q.keyPoints,
                rubric=unique_rubric,
                difficulty=q.difficulty or "MEDIUM",
                sourceMeetingIds=mids,
                sourceSegmentIds=sids,
            )
        )
        if len(questions) >= max_count:
            break
    if len(questions) < 1:
        raise StudyValidationError("INVALID_ESSAY", "No valid essay questions")
    return EssayContent(questions=questions).model_dump()


def validate_exam_brief(
    raw: dict[str, Any],
    *,
    allowed_meetings: set[int],
) -> dict[str, Any]:
    content = ExamBriefContent.model_validate(raw or {})
    content.sourceMeetingIds = [
        int(m) for m in content.sourceMeetingIds if int(m) in allowed_meetings
    ]
    content.formulas = [f for f in content.formulas if str(f).strip()]
    content.likelyExamTopics = [
        t
        if "ưu tiên" in t.lower() or "tài liệu" in t.lower() or "ôn" in t.lower()
        else f"{t} (ưu tiên ôn từ tài liệu đã ghi, không phải dự đoán đề)"
        for t in content.likelyExamTopics
        if str(t).strip()
    ]
    if not content.overview.strip():
        raise StudyValidationError("INVALID_EXAM_BRIEF", "overview required")
    return content.model_dump()


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
    allowed_meetings = {int(s["meetingId"]) for s in ready_sources}
    allowed_segments: set[str] = set()
    for s in ready_sources:
        allowed_segments |= set(s.get("allowedSegmentIds") or [])

    source_payload = {
        "synthesis": synthesis_content,
        "meetings": [
            {
                "meetingId": s["meetingId"],
                "educationStudy": s.get("educationStudy"),
                "allowedSegmentIds": s.get("allowedSegmentIds") or [],
            }
            for s in ready_sources
        ],
        "options": options,
    }
    count_hint = {
        ARTIFACT_FLASHCARDS: options["flashcardCount"],
        ARTIFACT_MULTIPLE_CHOICE: options["multipleChoiceCount"],
        ARTIFACT_ESSAY_QUESTIONS: options["essayQuestionCount"],
    }.get(artifact_type)

    user_prompt = (
        f"Generate {artifact_type} JSON. prompt={prompt_version} schema={schema_version}. "
        f"Requested count={count_hint}. Difficulty={options['difficulty']}. "
        f"Language={options['language']}.\n"
        f"SOURCE:\n{json.dumps(source_payload, ensure_ascii=False)}"
    )
    try:
        raw_text = call_gemini(
            prompt=user_prompt,
            system_prompt=artifact_system_instruction(artifact_type),
            response_schema=None,
        )
        parsed = json.loads(raw_text) if isinstance(raw_text, str) else raw_text
        if not isinstance(parsed, dict):
            raise StudyValidationError("INVALID_ARTIFACT_JSON", "Artifact JSON invalid")
    except StudyValidationError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise StudyTransientError(str(exc)) from exc

    if artifact_type == ARTIFACT_MIND_MAP:
        return validate_mind_map(
            parsed, allowed_meetings=allowed_meetings, allowed_segments=allowed_segments
        )
    if artifact_type == ARTIFACT_FLASHCARDS:
        return validate_flashcards(
            parsed,
            max_count=options["flashcardCount"],
            allowed_meetings=allowed_meetings,
            allowed_segments=allowed_segments,
        )
    if artifact_type == ARTIFACT_MULTIPLE_CHOICE:
        return validate_mcq(
            parsed,
            max_count=options["multipleChoiceCount"],
            allowed_meetings=allowed_meetings,
            allowed_segments=allowed_segments,
        )
    if artifact_type == ARTIFACT_ESSAY_QUESTIONS:
        return validate_essay(
            parsed,
            max_count=options["essayQuestionCount"],
            allowed_meetings=allowed_meetings,
            allowed_segments=allowed_segments,
        )
    if artifact_type == ARTIFACT_EXAM_BRIEF:
        return validate_exam_brief(parsed, allowed_meetings=allowed_meetings)
    raise StudyValidationError("UNKNOWN_ARTIFACT_TYPE", artifact_type)
