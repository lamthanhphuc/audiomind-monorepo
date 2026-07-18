"""Subject synthesis prompts, schema, and hierarchical pipeline."""

from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from pydantic import BaseModel, Field

from app.config import get_settings
from app.services.study import (
    SYNTHESIS_PROMPT_VERSION,
    SYNTHESIS_SCHEMA_VERSION,
    StudyTransientError,
    StudyValidationError,
)
from app.services.study.evidence import (
    build_allowed_segments_by_meeting,
    estimate_tokens,
    normalize_evidence_pairs,
    pairs_to_meeting_ids,
    pairs_to_segment_ids,
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


_TRIMMABLE_LIST_KEYS = (
    "sections",
    "keyPoints",
    "glossary",
    "mustRemember",
    "keywords",
    "learningObjectives",
)


def _fit_within_token_budget(
    compact: dict[str, Any], *, max_tokens: int, chars_per_token: int
) -> tuple[dict[str, Any], bool]:
    """Shrink a compacted source dict until it fits the token budget.

    Trims list fields first (biggest contributors), then falls back to
    truncating the overview text. Returns ``(possibly_shrunk, was_truncated)``.
    """
    max_chars = max(1, max_tokens * chars_per_token)
    text = json.dumps(compact, ensure_ascii=False)
    if len(text) <= max_chars:
        return compact, False

    shrunk = dict(compact)
    for _ in range(20):
        text = json.dumps(shrunk, ensure_ascii=False)
        if len(text) <= max_chars:
            return shrunk, True
        did_shrink = False
        for key in _TRIMMABLE_LIST_KEYS:
            values = shrunk.get(key)
            if isinstance(values, list) and len(values) > 1:
                keep = max(1, len(values) - max(1, len(values) // 4))
                shrunk[key] = values[:keep]
                did_shrink = True
        if not did_shrink:
            break

    text = json.dumps(shrunk, ensure_ascii=False)
    if len(text) > max_chars:
        overview = str(shrunk.get("overview") or "")
        overhead = max(0, len(text) - len(overview))
        overview_budget = max(0, max_chars - overhead)
        shrunk["overview"] = overview[:overview_budget]
    return shrunk, True


def _prepare_batch_sources(
    ready_sources: list[dict[str, Any]],
    *,
    max_input_tokens: int,
    chars_per_token: int,
) -> tuple[list[dict[str, Any]], list[str]]:
    prepared: list[dict[str, Any]] = []
    warnings: list[str] = []
    for source in ready_sources:
        compact = _compact_source(source)
        tokens = estimate_tokens(
            json.dumps(compact, ensure_ascii=False), chars_per_token=chars_per_token
        )
        if tokens <= max_input_tokens:
            prepared.append(source)
            continue
        truncated_compact, truncated = _fit_within_token_budget(
            compact, max_tokens=max_input_tokens, chars_per_token=chars_per_token
        )
        if truncated:
            warnings.append(
                f"meetingId={source.get('meetingId')} educationStudy truncated to fit "
                f"MAX_INPUT_TOKENS={max_input_tokens}"
            )
            logger.warning(
                "event=SUBJECT_SYNTHESIS_SOURCE_TRUNCATED meetingId=%s maxInputTokens=%s",
                source.get("meetingId"),
                max_input_tokens,
            )
        item = dict(source)
        item["educationStudy"] = truncated_compact
        prepared.append(item)
    return prepared, warnings


def _build_batches(
    prepared_sources: list[dict[str, Any]],
    *,
    max_meetings_per_batch: int,
    max_input_tokens: int,
    chars_per_token: int,
) -> list[list[dict[str, Any]]]:
    batches: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    current_tokens = 0
    for source in prepared_sources:
        tokens = estimate_tokens(
            json.dumps(_compact_source(source), ensure_ascii=False),
            chars_per_token=chars_per_token,
        )
        if current and (
            len(current) >= max_meetings_per_batch
            or current_tokens + tokens > max_input_tokens
        ):
            batches.append(current)
            current = []
            current_tokens = 0
        current.append(source)
        current_tokens += tokens
    if current:
        batches.append(current)
    return batches


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


def _evidence_fields_schema(*, include_segments: bool = True) -> dict[str, Any]:
    props: dict[str, Any] = {
        "sourceMeetingIds": {"type": "ARRAY", "items": {"type": "INTEGER"}},
    }
    if include_segments:
        props["sourceSegmentIds"] = {"type": "ARRAY", "items": {"type": "STRING"}}
    return props


def _evidenced_item_schema() -> dict[str, Any]:
    return {
        "type": "OBJECT",
        "properties": {
            "content": {"type": "STRING"},
            "importance": {"type": "STRING"},
            "reason": {"type": "STRING"},
            **_evidence_fields_schema(),
        },
        "required": ["content"],
    }


def _glossary_item_schema() -> dict[str, Any]:
    return {
        "type": "OBJECT",
        "properties": {
            "term": {"type": "STRING"},
            "definition": {"type": "STRING"},
            "example": {"type": "STRING"},
            **_evidence_fields_schema(),
        },
        "required": ["term", "definition"],
    }


def _knowledge_gap_schema() -> dict[str, Any]:
    return {
        "type": "OBJECT",
        "properties": {
            "content": {"type": "STRING"},
            "reason": {"type": "STRING"},
            **_evidence_fields_schema(),
        },
        "required": ["content"],
    }


def _exam_focus_schema() -> dict[str, Any]:
    return {
        "type": "OBJECT",
        "properties": {
            "content": {"type": "STRING"},
            "reason": {"type": "STRING"},
            **_evidence_fields_schema(include_segments=False),
        },
        "required": ["content"],
    }


def _chapter_schema() -> dict[str, Any]:
    return {
        "type": "OBJECT",
        "properties": {
            "id": {"type": "STRING"},
            "title": {"type": "STRING"},
            "summary": {"type": "STRING"},
            "keyPoints": {"type": "ARRAY", "items": _evidenced_item_schema()},
            "keywords": {"type": "ARRAY", "items": {"type": "STRING"}},
            "glossary": {"type": "ARRAY", "items": _glossary_item_schema()},
            "mustRemember": {"type": "ARRAY", "items": _evidenced_item_schema()},
            **_evidence_fields_schema(),
        },
        "required": ["title", "summary"],
    }


def subject_synthesis_gemini_schema() -> dict[str, Any]:
    return {
        "type": "OBJECT",
        "properties": {
            "subjectOverview": {"type": "STRING"},
            "learningObjectives": {"type": "ARRAY", "items": {"type": "STRING"}},
            "chapters": {"type": "ARRAY", "items": _chapter_schema()},
            "importantTerms": {"type": "ARRAY", "items": _glossary_item_schema()},
            "mustRemember": {"type": "ARRAY", "items": _evidenced_item_schema()},
            "knowledgeGaps": {"type": "ARRAY", "items": _knowledge_gap_schema()},
            "examFocus": {"type": "ARRAY", "items": _exam_focus_schema()},
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

    def paired(meeting_ids: list[int], segment_ids: list[str]) -> tuple[list[int], list[str]]:
        # Never zip meetingIds/segmentIds by index: resolve each pair through
        # the meeting-scoped allow-list so cross-meeting evidence is dropped.
        pairs = normalize_evidence_pairs(
            meeting_ids=meeting_ids,
            segment_ids=segment_ids,
            allowed_segments_by_meeting=allowed_segments_by_meeting,
        )
        return pairs_to_meeting_ids(pairs), pairs_to_segment_ids(pairs)

    def filter_meeting_only(meeting_ids: list[int]) -> list[int]:
        seen: set[int] = set()
        result: list[int] = []
        for raw_id in meeting_ids:
            try:
                mid = int(raw_id)
            except (TypeError, ValueError):
                continue
            if mid in allowed_meeting_ids and mid not in seen:
                seen.add(mid)
                result.append(mid)
        return result

    for chapter in content.chapters:
        chapter.sourceMeetingIds, chapter.sourceSegmentIds = paired(
            chapter.sourceMeetingIds, chapter.sourceSegmentIds
        )
        for kp in chapter.keyPoints:
            kp.sourceMeetingIds, kp.sourceSegmentIds = paired(
                kp.sourceMeetingIds, kp.sourceSegmentIds
            )
        for g in chapter.glossary:
            g.sourceMeetingIds, g.sourceSegmentIds = paired(
                g.sourceMeetingIds, g.sourceSegmentIds
            )
        for m in chapter.mustRemember:
            m.sourceMeetingIds, m.sourceSegmentIds = paired(
                m.sourceMeetingIds, m.sourceSegmentIds
            )

    new_terms: list[GlossaryItem] = []
    for t in content.importantTerms:
        if not t.term.strip():
            continue
        mids, sids = paired(t.sourceMeetingIds, t.sourceSegmentIds)
        new_terms.append(
            GlossaryItem(
                term=t.term, definition=t.definition, example=t.example,
                sourceMeetingIds=mids, sourceSegmentIds=sids,
            )
        )
    content.importantTerms = new_terms

    new_must_remember: list[EvidencedItem] = []
    for m in content.mustRemember:
        if not m.content.strip():
            continue
        mids, sids = paired(m.sourceMeetingIds, m.sourceSegmentIds)
        new_must_remember.append(
            EvidencedItem(
                content=m.content, importance=m.importance, reason=m.reason,
                sourceMeetingIds=mids, sourceSegmentIds=sids,
            )
        )
    content.mustRemember = new_must_remember

    new_gaps: list[KnowledgeGap] = []
    for g in content.knowledgeGaps:
        if not g.content.strip():
            continue
        mids, sids = paired(g.sourceMeetingIds, g.sourceSegmentIds)
        new_gaps.append(
            KnowledgeGap(content=g.content, reason=g.reason, sourceMeetingIds=mids, sourceSegmentIds=sids)
        )
    content.knowledgeGaps = new_gaps

    new_focus: list[ExamFocus] = []
    for e in content.examFocus:
        if not e.content.strip():
            continue
        new_focus.append(
            ExamFocus(
                content=e.content,
                reason=e.reason or "Chủ đề nên ưu tiên ôn từ tài liệu đã ghi, không phải dự đoán đề thi.",
                sourceMeetingIds=filter_meeting_only(e.sourceMeetingIds),
            )
        )
    content.examFocus = new_focus

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
    if not ready_sources:
        raise StudyValidationError("NO_READY_SOURCES", "No ready education sources")

    max_meetings_per_batch = max(1, int(settings.subject_synthesis_max_meetings_per_batch))
    max_input_tokens = max(1, int(settings.subject_synthesis_max_input_tokens))
    max_parallel_batches = max(1, int(settings.subject_synthesis_max_parallel_batches))
    chars_per_token = max(1, int(settings.subject_synthesis_chars_per_token))

    prepared_sources, warnings = _prepare_batch_sources(
        ready_sources, max_input_tokens=max_input_tokens, chars_per_token=chars_per_token
    )
    batches = _build_batches(
        prepared_sources,
        max_meetings_per_batch=max_meetings_per_batch,
        max_input_tokens=max_input_tokens,
        chars_per_token=chars_per_token,
    )

    def run_batch(batch: list[dict[str, Any]]) -> dict[str, Any]:
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
            logger.info(
                "event=SUBJECT_SYNTHESIS_BATCH_COMPLETED meetingCount=%s",
                len(batch),
            )
            return parsed
        except StudyValidationError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise StudyTransientError(str(exc)) from exc

    batch_results: list[dict[str, Any] | None] = [None] * len(batches)
    if len(batches) <= 1 or max_parallel_batches <= 1:
        for idx, batch in enumerate(batches):
            batch_results[idx] = run_batch(batch)
    else:
        with ThreadPoolExecutor(max_workers=min(max_parallel_batches, len(batches))) as executor:
            future_to_idx = {
                executor.submit(run_batch, batch): idx for idx, batch in enumerate(batches)
            }
            for future in as_completed(future_to_idx):
                batch_results[future_to_idx[future]] = future.result()

    ordered_results = [r for r in batch_results if r is not None]

    if len(ordered_results) == 1:
        merged = ordered_results[0]
    else:
        try:
            raw_text = call_gemini(
                prompt=build_reducer_prompt(ordered_results, language=language),
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
    allowed_segments_by_meeting = build_allowed_segments_by_meeting(ready_sources)
    normalized = normalize_synthesis(
        merged,
        allowed_meeting_ids=allowed_meeting_ids,
        allowed_segments_by_meeting=allowed_segments_by_meeting,
    )
    result = normalized.model_dump()
    if warnings:
        result["warnings"] = warnings
    return result
