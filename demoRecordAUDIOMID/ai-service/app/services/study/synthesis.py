"""Subject synthesis prompts, schema, and hierarchical pipeline."""

from __future__ import annotations

import json
import logging
from typing import Any

from pydantic import BaseModel, Field

from app.config import get_settings
from app.services.study import (
    SYNTHESIS_PROMPT_VERSION,
    SYNTHESIS_SCHEMA_VERSION,
    StudyTransientError,
    StudyValidationError,
)

logger = logging.getLogger(__name__)


class EvidencedItem(BaseModel):
    content: str = ""
    importance: str = "MEDIUM"
    reason: str | None = None
    sourceMeetingIds: list[int] = Field(default_factory=list)
    sourceSegmentIds: list[str] = Field(default_factory=list)


class GlossaryItem(BaseModel):
    term: str = ""
    definition: str = ""
    example: str | None = None
    sourceMeetingIds: list[int] = Field(default_factory=list)
    sourceSegmentIds: list[str] = Field(default_factory=list)


class Chapter(BaseModel):
    id: str = ""
    title: str = ""
    summary: str = ""
    keyPoints: list[EvidencedItem] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    glossary: list[GlossaryItem] = Field(default_factory=list)
    mustRemember: list[EvidencedItem] = Field(default_factory=list)
    sourceMeetingIds: list[int] = Field(default_factory=list)
    sourceSegmentIds: list[str] = Field(default_factory=list)


class KnowledgeGap(BaseModel):
    content: str = ""
    reason: str = ""
    sourceMeetingIds: list[int] = Field(default_factory=list)
    sourceSegmentIds: list[str] = Field(default_factory=list)


class ExamFocus(BaseModel):
    content: str = ""
    reason: str = ""
    sourceMeetingIds: list[int] = Field(default_factory=list)


class SubjectSynthesisContent(BaseModel):
    subjectOverview: str = ""
    learningObjectives: list[str] = Field(default_factory=list)
    chapters: list[Chapter] = Field(default_factory=list)
    importantTerms: list[GlossaryItem] = Field(default_factory=list)
    mustRemember: list[EvidencedItem] = Field(default_factory=list)
    knowledgeGaps: list[KnowledgeGap] = Field(default_factory=list)
    examFocus: list[ExamFocus] = Field(default_factory=list)


class BatchSynthesis(BaseModel):
    batchOverview: str = ""
    chapters: list[Chapter] = Field(default_factory=list)
    importantTerms: list[GlossaryItem] = Field(default_factory=list)
    mustRemember: list[EvidencedItem] = Field(default_factory=list)
    knowledgeGaps: list[KnowledgeGap] = Field(default_factory=list)
    examFocus: list[ExamFocus] = Field(default_factory=list)
    sourceMeetingIds: list[int] = Field(default_factory=list)


def synthesis_versions() -> dict[str, str]:
    return {
        "promptVersion": SYNTHESIS_PROMPT_VERSION,
        "schemaVersion": SYNTHESIS_SCHEMA_VERSION,
    }


def build_synthesis_system_instruction() -> str:
    return (
        "You are AudioMind subject synthesis. Use ONLY provided educationStudy sources. "
        "Do not invent facts, exams, or segment IDs. Empty arrays must be []. "
        "Respond with pure JSON matching the schema. Vietnamese Unicode when language=vi; "
        "keep English terms when needed and explain in Vietnamese."
    )


def _compact_source(meeting: dict[str, Any]) -> dict[str, Any]:
    study = meeting.get("educationStudy") or {}
    return {
        "meetingId": meeting.get("meetingId"),
        "overview": study.get("overview") or study.get("title") or "",
        "learningObjectives": study.get("learningObjectives") or [],
        "sections": study.get("sections") or [],
        "keyPoints": study.get("keyPoints") or [],
        "glossary": study.get("glossary") or [],
        "mustRemember": study.get("mustRemember") or [],
        "keywords": study.get("keywords") or [],
        "allowedSegmentIds": meeting.get("allowedSegmentIds") or [],
    }


def build_batch_prompt(batch: list[dict[str, Any]], *, language: str) -> str:
    payload = [_compact_source(item) for item in batch]
    return (
        f"Language: {language}\n"
        "Synthesize this batch of meeting educationStudy objects into one batch JSON.\n"
        "Preserve sourceMeetingIds and only use allowedSegmentIds for evidence.\n"
        f"SOURCES:\n{json.dumps(payload, ensure_ascii=False)}"
    )


def build_reducer_prompt(batches: list[dict[str, Any]], *, language: str) -> str:
    return (
        f"Language: {language}\n"
        "Merge batch synthesis results into one subject synthesis JSON. "
        "Do not drop evidence. Deduplicate chapters/terms. "
        f"BATCHES:\n{json.dumps(batches, ensure_ascii=False)}"
    )


def subject_synthesis_gemini_schema() -> dict[str, Any]:
    return {
        "type": "OBJECT",
        "properties": {
            "subjectOverview": {"type": "STRING"},
            "learningObjectives": {"type": "ARRAY", "items": {"type": "STRING"}},
            "chapters": {"type": "ARRAY", "items": {"type": "OBJECT"}},
            "importantTerms": {"type": "ARRAY", "items": {"type": "OBJECT"}},
            "mustRemember": {"type": "ARRAY", "items": {"type": "OBJECT"}},
            "knowledgeGaps": {"type": "ARRAY", "items": {"type": "OBJECT"}},
            "examFocus": {"type": "ARRAY", "items": {"type": "OBJECT"}},
        },
        "required": [
            "subjectOverview",
            "learningObjectives",
            "chapters",
            "importantTerms",
            "mustRemember",
            "knowledgeGaps",
            "examFocus",
        ],
    }


def normalize_synthesis(
    raw: dict[str, Any],
    *,
    allowed_meeting_ids: set[int],
    allowed_segments_by_meeting: dict[int, set[str]],
) -> SubjectSynthesisContent:
    content = SubjectSynthesisContent.model_validate(raw or {})
    all_allowed_segments: set[str] = set()
    for segs in allowed_segments_by_meeting.values():
        all_allowed_segments |= segs

    def filter_meetings(ids: list[int]) -> list[int]:
        return [int(i) for i in ids if int(i) in allowed_meeting_ids]

    def filter_segments(ids: list[str]) -> list[str]:
        return [s for s in ids if s in all_allowed_segments]

    for chapter in content.chapters:
        chapter.sourceMeetingIds = filter_meetings(chapter.sourceMeetingIds)
        chapter.sourceSegmentIds = filter_segments(chapter.sourceSegmentIds)
        for kp in chapter.keyPoints:
            kp.sourceMeetingIds = filter_meetings(kp.sourceMeetingIds)
            kp.sourceSegmentIds = filter_segments(kp.sourceSegmentIds)
        for g in chapter.glossary:
            g.sourceMeetingIds = filter_meetings(g.sourceMeetingIds)
            g.sourceSegmentIds = filter_segments(g.sourceSegmentIds)
        for m in chapter.mustRemember:
            m.sourceMeetingIds = filter_meetings(m.sourceMeetingIds)
            m.sourceSegmentIds = filter_segments(m.sourceSegmentIds)

    content.importantTerms = [
        GlossaryItem(
            term=t.term,
            definition=t.definition,
            example=t.example,
            sourceMeetingIds=filter_meetings(t.sourceMeetingIds),
            sourceSegmentIds=filter_segments(t.sourceSegmentIds),
        )
        for t in content.importantTerms
        if t.term.strip()
    ]
    content.mustRemember = [
        EvidencedItem(
            content=m.content,
            importance=m.importance,
            reason=m.reason,
            sourceMeetingIds=filter_meetings(m.sourceMeetingIds),
            sourceSegmentIds=filter_segments(m.sourceSegmentIds),
        )
        for m in content.mustRemember
        if m.content.strip()
    ]
    content.knowledgeGaps = [
        KnowledgeGap(
            content=g.content,
            reason=g.reason,
            sourceMeetingIds=filter_meetings(g.sourceMeetingIds),
            sourceSegmentIds=filter_segments(g.sourceSegmentIds),
        )
        for g in content.knowledgeGaps
        if g.content.strip()
    ]
    content.examFocus = [
        ExamFocus(
            content=e.content,
            reason=e.reason or "Chủ đề nên ưu tiên ôn từ tài liệu đã ghi, không phải dự đoán đề thi.",
            sourceMeetingIds=filter_meetings(e.sourceMeetingIds),
        )
        for e in content.examFocus
        if e.content.strip()
    ]
    # Deduplicate chapter ids
    seen_ids: set[str] = set()
    chapters: list[Chapter] = []
    for idx, chapter in enumerate(content.chapters, start=1):
        cid = chapter.id or f"chapter-{idx}"
        if cid in seen_ids:
            cid = f"{cid}-{idx}"
        seen_ids.add(cid)
        chapter.id = cid
        chapters.append(chapter)
    content.chapters = chapters
    return content


def run_hierarchical_synthesis(
    ready_sources: list[dict[str, Any]],
    *,
    language: str,
    call_gemini,
) -> dict[str, Any]:
    settings = get_settings()
    batch_size = max(1, int(settings.subject_synthesis_max_meetings_per_batch))
    if not ready_sources:
        raise StudyValidationError("NO_READY_SOURCES", "No ready education sources")

    batches = [
        ready_sources[i : i + batch_size]
        for i in range(0, len(ready_sources), batch_size)
    ]
    batch_results: list[dict[str, Any]] = []
    for batch in batches:
        prompt = build_batch_prompt(batch, language=language)
        try:
            raw_text = call_gemini(
                prompt=prompt,
                system_prompt=build_synthesis_system_instruction(),
                response_schema=subject_synthesis_gemini_schema(),
            )
            parsed = json.loads(raw_text) if isinstance(raw_text, str) else raw_text
            if not isinstance(parsed, dict):
                raise StudyValidationError("INVALID_BATCH_JSON", "Batch JSON invalid")
            parsed["sourceMeetingIds"] = [int(s["meetingId"]) for s in batch]
            batch_results.append(parsed)
            logger.info(
                "event=SUBJECT_SYNTHESIS_BATCH_COMPLETED meetingCount=%s",
                len(batch),
            )
        except StudyValidationError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise StudyTransientError(str(exc)) from exc

    if len(batch_results) == 1:
        merged = batch_results[0]
    else:
        try:
            raw_text = call_gemini(
                prompt=build_reducer_prompt(batch_results, language=language),
                system_prompt=build_synthesis_system_instruction(),
                response_schema=subject_synthesis_gemini_schema(),
            )
            merged = json.loads(raw_text) if isinstance(raw_text, str) else raw_text
            if not isinstance(merged, dict):
                raise StudyValidationError("INVALID_FINAL_JSON", "Final JSON invalid")
        except StudyValidationError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise StudyTransientError(str(exc)) from exc

    allowed_meeting_ids = {int(s["meetingId"]) for s in ready_sources}
    allowed_segments = {
        int(s["meetingId"]): set(s.get("allowedSegmentIds") or [])
        for s in ready_sources
    }
    normalized = normalize_synthesis(
        merged,
        allowed_meeting_ids=allowed_meeting_ids,
        allowed_segments_by_meeting=allowed_segments,
    )
    return normalized.model_dump()
