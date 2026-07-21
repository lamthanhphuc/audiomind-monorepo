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

logger = logging.getLogger(__name__)

_SYNTHESIS_EMPTY_SHELL: dict[str, Any] = {
    "subjectOverview": "",
    "learningObjectives": [],
    "chapters": [],
    "importantTerms": [],
    "mustRemember": [],
    "knowledgeGaps": [],
    "examFocus": [],
}


def _coerce_synthesis_provider_object(parsed: Any, *, context: str) -> dict[str, Any]:
    """Normalize schema-less Gemini retries that return bare arrays."""
    if isinstance(parsed, dict):
        return parsed
    if isinstance(parsed, list):
        if parsed and all(isinstance(item, dict) for item in parsed):
            logger.warning(
                "event=SUBJECT_SYNTHESIS_JSON_COERCED context=%s shape=list->object items=%s",
                context,
                len(parsed),
            )
            shell = dict(_SYNTHESIS_EMPTY_SHELL)
            if any(
                isinstance(item, dict)
                and (
                    item.get("title")
                    or item.get("keyPoints")
                    or item.get("summary")
                    or item.get("id", "").startswith("chapter")
                )
                for item in parsed
            ):
                shell["chapters"] = parsed
            else:
                shell["mustRemember"] = parsed
            return shell
    raise StudyValidationError(
        "INVALID_BATCH_JSON" if context == "batch" else "INVALID_FINAL_JSON",
        f"{'Batch' if context == 'batch' else 'Final'} JSON invalid (expected object, got {type(parsed).__name__})",
    )


# Hard ceiling for hierarchical reduce rounds to prevent infinite loops.
MAX_REDUCER_ROUNDS = 8
# Deterministic cap on evidence segment ids embedded in prompts.
MAX_ALLOWED_SEGMENT_IDS = 64


def assert_prompt_within_limit(
    prompt: str,
    *,
    max_input_tokens: int | None = None,
    chars_per_token: int | None = None,
) -> None:
    """Raise StudyValidationError when estimated prompt tokens exceed the ceiling."""
    settings = get_settings()
    limit = max(
        1,
        int(
            max_input_tokens
            if max_input_tokens is not None
            else settings.subject_synthesis_max_input_tokens
        ),
    )
    cpt = max(
        1,
        int(
            chars_per_token
            if chars_per_token is not None
            else settings.subject_synthesis_chars_per_token
        ),
    )
    tokens = estimate_tokens(prompt, chars_per_token=cpt)
    if tokens > limit:
        raise StudyValidationError(
            "PROMPT_TOKEN_LIMIT_EXCEEDED",
            f"Prompt estimate {tokens} exceeds MAX_INPUT_TOKENS={limit}",
        )


def _cap_allowed_segment_ids(
    segment_ids: list[Any] | None, *, max_ids: int = MAX_ALLOWED_SEGMENT_IDS
) -> tuple[list[str], bool]:
    """Deterministically cap allowedSegmentIds (sorted unique), return (ids, truncated)."""
    unique: list[str] = []
    seen: set[str] = set()
    for raw in segment_ids or []:
        value = str(raw).strip()
        if not value or value in seen:
            continue
        seen.add(value)
        unique.append(value)
    unique.sort()
    if len(unique) <= max_ids:
        return unique, False
    return unique[:max_ids], True


class EvidencePair(BaseModel):
    meetingId: int
    segmentId: str


class EvidencedItem(BaseModel):
    content: str = ""
    importance: str = "MEDIUM"
    reason: str | None = None
    evidence: list[EvidencePair] = Field(default_factory=list)
    sourceMeetingIds: list[int] = Field(default_factory=list)
    sourceSegmentIds: list[str] = Field(default_factory=list)


class GlossaryItem(BaseModel):
    term: str = ""
    definition: str = ""
    example: str | None = None
    evidence: list[EvidencePair] = Field(default_factory=list)
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
    evidence: list[EvidencePair] = Field(default_factory=list)
    sourceMeetingIds: list[int] = Field(default_factory=list)
    sourceSegmentIds: list[str] = Field(default_factory=list)


class KnowledgeGap(BaseModel):
    content: str = ""
    reason: str = ""
    evidence: list[EvidencePair] = Field(default_factory=list)
    sourceMeetingIds: list[int] = Field(default_factory=list)
    sourceSegmentIds: list[str] = Field(default_factory=list)


class ExamFocus(BaseModel):
    content: str = ""
    reason: str = ""
    evidence: list[EvidencePair] = Field(default_factory=list)
    sourceMeetingIds: list[int] = Field(default_factory=list)
    sourceSegmentIds: list[str] = Field(default_factory=list)


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
        "You are AudioMind subject synthesis. Use ONLY provided meeting study sources "
        "(educationStudy-shaped inputs from any analysis domain). "
        "Do not invent facts, exams, or segment IDs. Empty arrays must be []. "
        "Respond with pure JSON matching the schema. Vietnamese Unicode when language=vi; "
        "keep English terms when needed and explain in Vietnamese."
    )


def _compact_source(meeting: dict[str, Any]) -> dict[str, Any]:
    study = meeting.get("educationStudy") or {}
    # Prefer nested study fields when educationStudy was already compacted.
    if not study and any(k in meeting for k in ("overview", "sections", "keyPoints")):
        study = meeting
    capped_ids, truncated = _cap_allowed_segment_ids(
        meeting.get("allowedSegmentIds") or []
    )
    if truncated:
        logger.warning(
            "event=SUBJECT_SYNTHESIS_SEGMENT_IDS_CAPPED meetingId=%s kept=%s",
            meeting.get("meetingId"),
            len(capped_ids),
        )
    return {
        "meetingId": meeting.get("meetingId"),
        "overview": study.get("overview") or study.get("title") or "",
        "learningObjectives": study.get("learningObjectives") or [],
        "sections": study.get("sections") or [],
        "keyPoints": study.get("keyPoints") or [],
        "glossary": study.get("glossary") or [],
        "mustRemember": study.get("mustRemember") or [],
        "keywords": study.get("keywords") or [],
        "allowedSegmentIds": capped_ids,
    }


_TRIMMABLE_LIST_KEYS = (
    "sections",
    "keyPoints",
    "glossary",
    "mustRemember",
    "keywords",
    "learningObjectives",
    "chapters",
    "importantTerms",
    "knowledgeGaps",
    "examFocus",
    "allowedSegmentIds",
    "sourceMeetingIds",
    "sourceSegmentIds",
)


def _fit_within_token_budget(
    compact: dict[str, Any], *, max_tokens: int, chars_per_token: int
) -> tuple[dict[str, Any], bool]:
    """Shrink a compacted source dict until it fits the token budget.

    Trims list fields first (biggest contributors), then falls back to
    truncating overview / string fields. Returns ``(possibly_shrunk, was_truncated)``.
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
            elif isinstance(values, list) and len(values) == 1:
                # Truncate nested string payloads inside the sole remaining item.
                only = values[0]
                if isinstance(only, dict):
                    nested = dict(only)
                    for nk, nv in list(nested.items()):
                        if isinstance(nv, str) and len(nv) > 32:
                            nested[nk] = nv[: max(16, len(nv) // 2)]
                            did_shrink = True
                        elif isinstance(nv, list) and len(nv) > 1:
                            nested[nk] = nv[: max(1, len(nv) // 2)]
                            did_shrink = True
                    shrunk[key] = [nested]
                elif isinstance(only, str) and len(only) > 32:
                    shrunk[key] = [only[: max(16, len(only) // 2)]]
                    did_shrink = True
        for key in ("overview", "subjectOverview", "summary", "content", "definition"):
            value = shrunk.get(key)
            if isinstance(value, str) and len(value) > 32:
                shrunk[key] = value[: max(16, len(value) // 2)]
                did_shrink = True
        if not did_shrink:
            break

    text = json.dumps(shrunk, ensure_ascii=False)
    if len(text) > max_chars:
        overview_key = "overview" if "overview" in shrunk else "subjectOverview"
        overview = str(shrunk.get(overview_key) or "")
        overhead = max(0, len(text) - len(overview))
        overview_budget = max(0, max_chars - overhead)
        shrunk[overview_key] = overview[:overview_budget]
        # Absolute last resort: drop remaining list fields.
        text = json.dumps(shrunk, ensure_ascii=False)
        if len(text) > max_chars:
            for key in _TRIMMABLE_LIST_KEYS:
                if key in shrunk and isinstance(shrunk[key], list):
                    shrunk[key] = []
            text = json.dumps(shrunk, ensure_ascii=False)
            if len(text) > max_chars:
                # Keep only provenance + a tiny overview stub.
                keep_keys = {
                    "meetingId",
                    "sourceMeetingIds",
                    "sourceSegmentIds",
                    overview_key,
                }
                stub = {k: shrunk[k] for k in keep_keys if k in shrunk}
                stub[overview_key] = str(stub.get(overview_key) or "")[
                    : max(0, max_chars // 2)
                ]
                shrunk = stub
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


def _evidence_fields_schema(*, include_segments: bool = True) -> dict[str, Any]:
    props: dict[str, Any] = {
        "evidence": EVIDENCE_SCHEMA,
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
            **_evidence_fields_schema(),
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


def _resolve_evidence(
    *,
    evidence: list[EvidencePair],
    meeting_ids: list[int],
    segment_ids: list[str],
    allowed_segments_by_meeting: dict[int, set[str]],
) -> tuple[list[int], list[str], list[EvidencePair]]:
    """Resolve an item's evidence via meeting-scoped pairs (never a positional zip).

    Prefers the model-supplied ``evidence[]`` pairs over the legacy
    ``sourceMeetingIds``/``sourceSegmentIds`` arrays when both are present.
    """
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


def normalize_synthesis(
    raw: dict[str, Any],
    *,
    allowed_meeting_ids: set[int],
    allowed_segments_by_meeting: dict[int, set[str]],
) -> SubjectSynthesisContent:
    content = SubjectSynthesisContent.model_validate(raw or {})

    def paired(
        evidence: list[EvidencePair], meeting_ids: list[int], segment_ids: list[str]
    ) -> tuple[list[int], list[str], list[EvidencePair]]:
        return _resolve_evidence(
            evidence=evidence,
            meeting_ids=meeting_ids,
            segment_ids=segment_ids,
            allowed_segments_by_meeting=allowed_segments_by_meeting,
        )

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
        chapter.sourceMeetingIds, chapter.sourceSegmentIds, chapter.evidence = paired(
            chapter.evidence, chapter.sourceMeetingIds, chapter.sourceSegmentIds
        )
        for kp in chapter.keyPoints:
            kp.sourceMeetingIds, kp.sourceSegmentIds, kp.evidence = paired(
                kp.evidence, kp.sourceMeetingIds, kp.sourceSegmentIds
            )
        for g in chapter.glossary:
            g.sourceMeetingIds, g.sourceSegmentIds, g.evidence = paired(
                g.evidence, g.sourceMeetingIds, g.sourceSegmentIds
            )
        for m in chapter.mustRemember:
            m.sourceMeetingIds, m.sourceSegmentIds, m.evidence = paired(
                m.evidence, m.sourceMeetingIds, m.sourceSegmentIds
            )

    new_terms: list[GlossaryItem] = []
    for t in content.importantTerms:
        if not t.term.strip():
            continue
        mids, sids, pairs = paired(t.evidence, t.sourceMeetingIds, t.sourceSegmentIds)
        new_terms.append(
            GlossaryItem(
                term=t.term,
                definition=t.definition,
                example=t.example,
                evidence=pairs,
                sourceMeetingIds=mids,
                sourceSegmentIds=sids,
            )
        )
    content.importantTerms = new_terms

    new_must_remember: list[EvidencedItem] = []
    for m in content.mustRemember:
        if not m.content.strip():
            continue
        mids, sids, pairs = paired(m.evidence, m.sourceMeetingIds, m.sourceSegmentIds)
        new_must_remember.append(
            EvidencedItem(
                content=m.content,
                importance=m.importance,
                reason=m.reason,
                evidence=pairs,
                sourceMeetingIds=mids,
                sourceSegmentIds=sids,
            )
        )
    content.mustRemember = new_must_remember

    new_gaps: list[KnowledgeGap] = []
    for g in content.knowledgeGaps:
        if not g.content.strip():
            continue
        mids, sids, pairs = paired(g.evidence, g.sourceMeetingIds, g.sourceSegmentIds)
        new_gaps.append(
            KnowledgeGap(
                content=g.content,
                reason=g.reason,
                evidence=pairs,
                sourceMeetingIds=mids,
                sourceSegmentIds=sids,
            )
        )
    content.knowledgeGaps = new_gaps

    new_focus: list[ExamFocus] = []
    for e in content.examFocus:
        if not e.content.strip():
            continue
        mids, sids, pairs = paired(e.evidence, e.sourceMeetingIds, e.sourceSegmentIds)
        if not mids:
            # Exam focus items don't require segment-level evidence like
            # chapters/glossary do; fall back to meeting-only allow-listing
            # when no evidence pairs or matching segments were supplied.
            mids = filter_meeting_only(e.sourceMeetingIds)
        new_focus.append(
            ExamFocus(
                content=e.content,
                reason=e.reason
                or "Chủ đề nên ưu tiên ôn từ tài liệu đã ghi, không phải dự đoán đề thi.",
                evidence=pairs,
                sourceMeetingIds=mids,
                sourceSegmentIds=sids,
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


def _compact_intermediate_for_prompt(
    item: dict[str, Any],
    *,
    max_tokens: int,
    chars_per_token: int,
) -> dict[str, Any]:
    """Shrink a batch/reducer intermediate so it can fit into a prompt budget."""
    tokens = estimate_tokens(
        json.dumps(item, ensure_ascii=False), chars_per_token=chars_per_token
    )
    if tokens <= max_tokens:
        return item
    # Prefer section-level compaction on known list fields.
    shrunk, _ = _fit_within_token_budget(
        dict(item), max_tokens=max_tokens, chars_per_token=chars_per_token
    )
    # Preserve provenance keys even after trim.
    for key in ("sourceMeetingIds", "sourceSegmentIds"):
        if key in item and key not in shrunk:
            shrunk[key] = item[key]
    return shrunk


def _build_prompt_within_limit(
    *,
    build_prompt,
    payload_items: list[dict[str, Any]],
    language: str,
    max_input_tokens: int,
    chars_per_token: int,
    system_prompt: str = "",
) -> tuple[str, list[dict[str, Any]]]:
    """Build a prompt that fits the token ceiling by compacting payload items.

    Reserves tokens for ``system_prompt + "\\n\\n"`` so system+user stays under the limit.
    """
    system_reserve = estimate_tokens(
        (system_prompt or "") + "\n\n", chars_per_token=chars_per_token
    )
    user_token_budget = max(1, max_input_tokens - system_reserve)

    items = [dict(item) for item in payload_items]
    per_item = max(1, (user_token_budget * 3) // max(4, len(items) + 1))
    for round_idx in range(32):
        prompt = build_prompt(items, language=language)
        tokens = estimate_tokens(prompt, chars_per_token=chars_per_token)
        if tokens <= user_token_budget:
            return prompt, items
        budget = max(1, per_item // (2 ** min(round_idx, 8)))
        items = [
            _compact_intermediate_for_prompt(
                item, max_tokens=budget, chars_per_token=chars_per_token
            )
            for item in items
        ]
        # Absolute floor: keep only tiny provenance stubs.
        if round_idx >= 16:
            items = [
                {
                    "subjectOverview": str(
                        item.get("subjectOverview") or item.get("overview") or ""
                    )[:40],
                    "sourceMeetingIds": (item.get("sourceMeetingIds") or [])[:8],
                    "chapters": [],
                    "importantTerms": [],
                    "mustRemember": [],
                    "learningObjectives": [],
                    "knowledgeGaps": [],
                    "examFocus": [],
                    "meetingId": item.get("meetingId"),
                }
                for item in items
            ]
    prompt = build_prompt(items, language=language)
    assert_prompt_within_limit(
        prompt, max_input_tokens=user_token_budget, chars_per_token=chars_per_token
    )
    return prompt, items


def run_hierarchical_synthesis(
    ready_sources: list[dict[str, Any]],
    *,
    language: str,
    call_gemini,
) -> dict[str, Any]:
    settings = get_settings()
    if not ready_sources:
        raise StudyValidationError("NO_READY_SOURCES", "No ready education sources")

    max_meetings_per_batch = max(
        1, int(settings.subject_synthesis_max_meetings_per_batch)
    )
    max_input_tokens = max(1, int(settings.subject_synthesis_max_input_tokens))
    max_parallel_batches = max(1, int(settings.subject_synthesis_max_parallel_batches))
    chars_per_token = max(1, int(settings.subject_synthesis_chars_per_token))

    # Leave headroom so prompt wrappers (language / instructions) still fit.
    source_budget = max(1, int(max_input_tokens * 0.85))
    prepared_sources, warnings = _prepare_batch_sources(
        ready_sources, max_input_tokens=source_budget, chars_per_token=chars_per_token
    )
    batches = _build_batches(
        prepared_sources,
        max_meetings_per_batch=max_meetings_per_batch,
        max_input_tokens=source_budget,
        chars_per_token=chars_per_token,
    )

    def run_batch(batch: list[dict[str, Any]]) -> dict[str, Any]:
        compact_batch = [_compact_source(item) for item in batch]
        system_prompt = build_synthesis_system_instruction()
        prompt, _ = _build_prompt_within_limit(
            build_prompt=lambda items, language: (
                f"Language: {language}\n"
                "Synthesize this batch of meeting educationStudy objects into one batch JSON.\n"
                "Preserve sourceMeetingIds and only use allowedSegmentIds for evidence.\n"
                f"SOURCES:\n{json.dumps(items, ensure_ascii=False)}"
            ),
            payload_items=compact_batch,
            language=language,
            max_input_tokens=max_input_tokens,
            chars_per_token=chars_per_token,
            system_prompt=system_prompt,
        )
        assert_prompt_within_limit(
            system_prompt + "\n\n" + prompt,
            max_input_tokens=max_input_tokens,
            chars_per_token=chars_per_token,
        )
        try:
            raw_text = call_gemini(
                prompt=prompt,
                system_prompt=system_prompt,
                response_schema=subject_synthesis_gemini_schema(),
            )
            try:
                parsed = json.loads(raw_text) if isinstance(raw_text, str) else raw_text
            except json.JSONDecodeError as exc:
                raise StudyValidationError(
                    "INVALID_PROVIDER_JSON",
                    "Provider response is not valid JSON",
                ) from exc
            parsed = _coerce_synthesis_provider_object(parsed, context="batch")
            parsed["sourceMeetingIds"] = [int(s["meetingId"]) for s in batch]
            logger.info(
                "event=SUBJECT_SYNTHESIS_BATCH_COMPLETED meetingCount=%s",
                len(batch),
            )
            return parsed
        except StudyValidationError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise classify_provider_exception(exc) from exc

    batch_results: list[dict[str, Any] | None] = [None] * len(batches)
    if len(batches) <= 1 or max_parallel_batches <= 1:
        for idx, batch in enumerate(batches):
            batch_results[idx] = run_batch(batch)
    else:
        with ThreadPoolExecutor(
            max_workers=min(max_parallel_batches, len(batches))
        ) as executor:
            future_to_idx = {
                executor.submit(run_batch, batch): idx
                for idx, batch in enumerate(batches)
            }
            for future in as_completed(future_to_idx):
                batch_results[future_to_idx[future]] = future.result()

    ordered_results = [r for r in batch_results if r is not None]

    if len(ordered_results) == 1:
        merged = ordered_results[0]
    else:
        # Hierarchical reducer: keep intermediate prompts under max_input_tokens.
        level = ordered_results
        reduce_round = 0
        while len(level) > 1:
            reduce_round += 1
            if reduce_round > MAX_REDUCER_ROUNDS:
                raise StudyValidationError(
                    "REDUCER_MAX_ROUNDS_EXCEEDED",
                    f"Hierarchical reducer exceeded {MAX_REDUCER_ROUNDS} rounds",
                )
            next_level: list[dict[str, Any]] = []
            chunk: list[dict[str, Any]] = []
            chunk_tokens = 0
            for item in level:
                fitted = _compact_intermediate_for_prompt(
                    item,
                    max_tokens=source_budget,
                    chars_per_token=chars_per_token,
                )
                item_tokens = estimate_tokens(
                    json.dumps(fitted, ensure_ascii=False),
                    chars_per_token=chars_per_token,
                )
                if chunk and chunk_tokens + item_tokens > source_budget:
                    next_level.append(
                        _reduce_intermediate_batch(
                            chunk,
                            language=language,
                            call_gemini=call_gemini,
                            max_input_tokens=max_input_tokens,
                            chars_per_token=chars_per_token,
                        )
                    )
                    chunk = [fitted]
                    chunk_tokens = item_tokens
                else:
                    chunk.append(fitted)
                    chunk_tokens += item_tokens
            if chunk:
                if len(chunk) == 1:
                    next_level.append(chunk[0])
                else:
                    next_level.append(
                        _reduce_intermediate_batch(
                            chunk,
                            language=language,
                            call_gemini=call_gemini,
                            max_input_tokens=max_input_tokens,
                            chars_per_token=chars_per_token,
                        )
                    )
            if len(next_level) >= len(level):
                forced: list[dict[str, Any]] = []
                for i in range(0, len(level), 2):
                    pair = [
                        _compact_intermediate_for_prompt(
                            x,
                            max_tokens=max(1, source_budget // 2),
                            chars_per_token=chars_per_token,
                        )
                        for x in level[i : i + 2]
                    ]
                    if len(pair) == 1:
                        forced.append(pair[0])
                    else:
                        forced.append(
                            _reduce_intermediate_batch(
                                pair,
                                language=language,
                                call_gemini=call_gemini,
                                max_input_tokens=max_input_tokens,
                                chars_per_token=chars_per_token,
                            )
                        )
                next_level = forced
                warnings.append(
                    "REDUCER_FORCED_PAIRWISE: intermediate results required pairwise merge"
                )
            level = next_level
            logger.info(
                "event=SUBJECT_SYNTHESIS_REDUCER_ROUND round=%s remaining=%s",
                reduce_round,
                len(level),
            )
        merged = level[0]
        if reduce_round > 1:
            warnings.append(
                f"HIERARCHICAL_REDUCER: used {reduce_round} reduce rounds to stay under token budget"
            )

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


def _reduce_intermediate_batch(
    batches: list[dict[str, Any]],
    *,
    language: str,
    call_gemini,
    max_input_tokens: int | None = None,
    chars_per_token: int | None = None,
) -> dict[str, Any]:
    if len(batches) == 1:
        return batches[0]
    settings = get_settings()
    limit = max(
        1,
        int(
            max_input_tokens
            if max_input_tokens is not None
            else settings.subject_synthesis_max_input_tokens
        ),
    )
    cpt = max(
        1,
        int(
            chars_per_token
            if chars_per_token is not None
            else settings.subject_synthesis_chars_per_token
        ),
    )
    fitted = list(batches)
    if len(fitted) > 2:
        # Prefer recursive pairwise when a multi-item merge would likely overflow.
        est = estimate_tokens(
            build_reducer_prompt(fitted, language=language), chars_per_token=cpt
        )
        if est > limit:
            mid = len(fitted) // 2
            left = _reduce_intermediate_batch(
                fitted[:mid],
                language=language,
                call_gemini=call_gemini,
                max_input_tokens=limit,
                chars_per_token=cpt,
            )
            right = _reduce_intermediate_batch(
                fitted[mid:],
                language=language,
                call_gemini=call_gemini,
                max_input_tokens=limit,
                chars_per_token=cpt,
            )
            return _reduce_intermediate_batch(
                [left, right],
                language=language,
                call_gemini=call_gemini,
                max_input_tokens=limit,
                chars_per_token=cpt,
            )

    system_prompt = build_synthesis_system_instruction()
    prompt, fitted = _build_prompt_within_limit(
        build_prompt=lambda items, language: build_reducer_prompt(
            items, language=language
        ),
        payload_items=fitted,
        language=language,
        max_input_tokens=limit,
        chars_per_token=cpt,
        system_prompt=system_prompt,
    )
    assert_prompt_within_limit(
        system_prompt + "\n\n" + prompt,
        max_input_tokens=limit,
        chars_per_token=cpt,
    )
    try:
        raw_text = call_gemini(
            prompt=prompt,
            system_prompt=system_prompt,
            response_schema=subject_synthesis_gemini_schema(),
        )
        try:
            merged = json.loads(raw_text) if isinstance(raw_text, str) else raw_text
        except json.JSONDecodeError as exc:
            raise StudyValidationError(
                "INVALID_PROVIDER_JSON",
                "Provider response is not valid JSON",
            ) from exc
        merged = _coerce_synthesis_provider_object(merged, context="final")
        meeting_ids: list[int] = []
        seen: set[int] = set()
        for batch in batches:
            for mid in batch.get("sourceMeetingIds") or []:
                try:
                    value = int(mid)
                except (TypeError, ValueError):
                    continue
                if value not in seen:
                    seen.add(value)
                    meeting_ids.append(value)
        if meeting_ids:
            merged["sourceMeetingIds"] = meeting_ids
        return merged
    except StudyValidationError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise classify_provider_exception(exc) from exc
