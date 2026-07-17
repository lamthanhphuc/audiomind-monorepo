"""Education study structured analysis — schema, prompt, and normalization."""

from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping
from typing import Any

from loguru import logger
from pydantic import BaseModel, Field

from app.services.analysis_versioning import resolve_analysis_versions
from app.services.segment_identity import collect_allowed_segment_ids

IMPORTANCE_VALUES = frozenset({"HIGH", "MEDIUM", "LOW"})
DEFAULT_IMPORTANCE = "MEDIUM"


class EducationSection(BaseModel):
    id: str = ""
    title: str = ""
    summary: str = ""
    keyPoints: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    sourceSegmentIds: list[str] = Field(default_factory=list)


class EducationKeyPoint(BaseModel):
    content: str = ""
    importance: str = DEFAULT_IMPORTANCE
    sourceSegmentIds: list[str] = Field(default_factory=list)


class EducationGlossaryItem(BaseModel):
    term: str = ""
    definition: str = ""
    example: str | None = None
    category: str | None = None
    sourceSegmentIds: list[str] = Field(default_factory=list)


class EducationMustRememberItem(BaseModel):
    content: str = ""
    importance: str = DEFAULT_IMPORTANCE
    reason: str | None = None
    sourceSegmentIds: list[str] = Field(default_factory=list)


class EducationUnclearPoint(BaseModel):
    content: str = ""
    reason: str = ""
    sourceSegmentIds: list[str] = Field(default_factory=list)


class EducationStudy(BaseModel):
    title: str = ""
    overview: str = ""
    learningObjectives: list[str] = Field(default_factory=list)
    sections: list[EducationSection] = Field(default_factory=list)
    keyPoints: list[EducationKeyPoint] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    glossary: list[EducationGlossaryItem] = Field(default_factory=list)
    mustRemember: list[EducationMustRememberItem] = Field(default_factory=list)
    unclearPoints: list[EducationUnclearPoint] = Field(default_factory=list)


def education_versions() -> dict[str, str]:
    return resolve_analysis_versions("education")


def _string_schema() -> dict[str, Any]:
    return {"type": "STRING"}


def _string_array_schema() -> dict[str, Any]:
    return {"type": "ARRAY", "items": _string_schema()}


def _importance_schema() -> dict[str, Any]:
    return {"type": "STRING", "enum": ["HIGH", "MEDIUM", "LOW"]}


def education_study_gemini_schema() -> dict[str, Any]:
    """Gemini structured-output OBJECT schema for educationStudy."""
    section = {
        "type": "OBJECT",
        "properties": {
            "id": _string_schema(),
            "title": _string_schema(),
            "summary": _string_schema(),
            "keyPoints": _string_array_schema(),
            "keywords": _string_array_schema(),
            "sourceSegmentIds": _string_array_schema(),
        },
    }
    key_point = {
        "type": "OBJECT",
        "properties": {
            "content": _string_schema(),
            "importance": _importance_schema(),
            "sourceSegmentIds": _string_array_schema(),
        },
    }
    glossary_item = {
        "type": "OBJECT",
        "properties": {
            "term": _string_schema(),
            "definition": _string_schema(),
            "example": _string_schema(),
            "category": _string_schema(),
            "sourceSegmentIds": _string_array_schema(),
        },
    }
    must_remember = {
        "type": "OBJECT",
        "properties": {
            "content": _string_schema(),
            "importance": _importance_schema(),
            "reason": _string_schema(),
            "sourceSegmentIds": _string_array_schema(),
        },
    }
    unclear = {
        "type": "OBJECT",
        "properties": {
            "content": _string_schema(),
            "reason": _string_schema(),
            "sourceSegmentIds": _string_array_schema(),
        },
    }
    return {
        "type": "OBJECT",
        "properties": {
            "title": _string_schema(),
            "overview": _string_schema(),
            "learningObjectives": _string_array_schema(),
            "sections": {"type": "ARRAY", "items": section},
            "keyPoints": {"type": "ARRAY", "items": key_point},
            "keywords": _string_array_schema(),
            "glossary": {"type": "ARRAY", "items": glossary_item},
            "mustRemember": {"type": "ARRAY", "items": must_remember},
            "unclearPoints": {"type": "ARRAY", "items": unclear},
        },
    }


def build_education_system_instruction(domain_mode: str = "education") -> str:
    versions = education_versions()
    return (
        "Bạn là trợ lý phân tích nội dung học tập. Phân tích hoàn toàn dựa trên transcript. "
        "Không bổ sung kiến thức ngoài transcript. Không suy đoán nội dung giảng viên chưa nói. "
        "Không biến nội dung thiếu bằng chứng thành sự thật. "
        "Trả về đúng một object JSON hợp lệ, không Markdown, không code fence. "
        f"domainMode hiện tại là {domain_mode}. "
        f"promptVersion phải là {versions['promptVersion']}. "
        f"schemaVersion phải là {versions['schemaVersion']}. "
        f"analysisFeatureSet phải là {versions['analysisFeatureSet']}."
    )


def build_education_prompt_rules(*, language_hint: str | None = None) -> str:
    versions = education_versions()
    language_rules = (
        "- Nếu meeting language là tiếng Việt (hoặc nội dung transcript chủ yếu tiếng Việt): "
        "title, overview, content, definitions và reasons phải bằng tiếng Việt.\n"
        "- Keyword kỹ thuật có thể giữ nguyên tiếng Anh nếu đó là thuật ngữ trong transcript.\n"
        "- Không dịch sai tên công nghệ, thuật toán hoặc danh từ riêng.\n"
    )
    if language_hint and language_hint.strip().lower() in {"en", "english"}:
        language_rules = (
            "- Output educationStudy fields in English when the meeting language is English.\n"
            "- Keep proper nouns and technical terms unchanged.\n"
        )
    return f"""
=== Education analysis rules ===
- Tạo educationStudy với: title, overview, learningObjectives, sections, keyPoints,
  keywords, glossary, mustRemember, unclearPoints.
- Mỗi section cần id (section-1, section-2, ...), title, summary, keyPoints, keywords, sourceSegmentIds.
- importance chỉ dùng: HIGH, MEDIUM, LOW.
- Array không có dữ liệu phải là []. Không dùng null cho array.
- Optional string (example, category, reason) có thể null.
- Không thêm field ngoài schema.

=== Evidence rules ===
- Transcript có marker dạng [SEGMENT_ID=meeting-12-start-10.000-speaker_1].
- Chỉ dùng segment ID xuất hiện trong transcript.
- Không bịa ID, UUID, timestamp giả; không sửa format ID; không tham chiếu meeting khác.
- Mỗi item có evidence dùng "sourceSegmentIds": []. Nếu thiếu bằng chứng, trả [].

=== Language rules ===
{language_rules}

=== Output schema rules ===
- JSON thuần, không Markdown ngoài JSON, không code fence.
- promptVersion="{versions['promptVersion']}"
- schemaVersion="{versions['schemaVersion']}"
- analysisFeatureSet="{versions['analysisFeatureSet']}"
- Không dùng placeholder như "N/A" nếu có thể dùng null hoặc [].

=== Validation rules ===
- educationStudy bắt buộc khi domainMode=education.
- sourceSegmentIds ⊆ allowed segment IDs trong transcript markers.
""".strip()


def _trim_required(value: Any) -> str:
    return str(value or "").strip()


def _trim_optional(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None


def _coerce_string_list(values: Any, *, dedupe: bool = True) -> list[str]:
    if not isinstance(values, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in values:
        if item is None:
            continue
        text = str(item).strip()
        if not text:
            continue
        if dedupe:
            key = text.casefold()
            if key in seen:
                continue
            seen.add(key)
        result.append(text)
    return result


def normalize_importance(value: Any) -> str:
    normalized = str(value or "").strip().upper()
    if normalized in IMPORTANCE_VALUES:
        return normalized
    return DEFAULT_IMPORTANCE


def normalize_source_segment_ids(
    values: Any,
    *,
    allowed_segment_ids: Collection[str],
    meeting_id: int | None = None,
) -> tuple[list[str], int]:
    """Return (normalized_ids, dropped_count).

    Membership in ``allowed_segment_ids`` is the source of truth. Explicit
    legacy/UUID ids that appear in the allowed set are kept even when they do
    not use the ``meeting-{id}-`` stable-id prefix. ``meeting_id`` is retained
    for call-site compatibility.
    """
    if not isinstance(values, list):
        return [], 0

    allowed = {str(item).strip() for item in allowed_segment_ids if str(item).strip()}

    if not allowed:
        dropped = sum(1 for item in values if isinstance(item, str) and item.strip())
        return [], dropped

    result: list[str] = []
    seen: set[str] = set()
    dropped = 0

    for item in values:
        if not isinstance(item, str):
            dropped += 1
            continue
        segment_id = item.strip()
        if not segment_id:
            dropped += 1
            continue
        if segment_id not in allowed:
            dropped += 1
            continue
        if segment_id in seen:
            continue
        seen.add(segment_id)
        result.append(segment_id)

    return result, dropped


def _normalize_section_ids(sections: list[dict[str, Any]]) -> None:
    seen: set[str] = set()
    for index, section in enumerate(sections, start=1):
        candidate = _trim_required(section.get("id"))
        if not candidate or candidate.casefold() in seen:
            candidate = f"section-{index}"
        # Ensure uniqueness even after collision with generated id.
        base = candidate
        suffix = 2
        while candidate.casefold() in seen:
            candidate = f"{base}-{suffix}"
            suffix += 1
        section["id"] = candidate
        seen.add(candidate.casefold())


def normalize_education_study(
    value: Any,
    *,
    allowed_segment_ids: Collection[str] | None = None,
    meeting_id: int | None = None,
) -> dict[str, Any] | None:
    """Normalize educationStudy; return None if missing/unusable top-level object."""
    if value is None:
        return None
    if not isinstance(value, Mapping):
        logger.warning(
            "EDUCATION_STUDY_NORMALIZE_FAILED meeting_id={} error_class=TypeError detail=not_object",
            meeting_id,
        )
        return None

    allowed = set(allowed_segment_ids or ())
    dropped_total = 0

    def _evidence(raw: Any) -> list[str]:
        nonlocal dropped_total
        ids, dropped = normalize_source_segment_ids(
            raw, allowed_segment_ids=allowed, meeting_id=meeting_id
        )
        dropped_total += dropped
        return ids

    sections: list[dict[str, Any]] = []
    raw_sections = value.get("sections")
    if isinstance(raw_sections, list):
        for item in raw_sections:
            if not isinstance(item, Mapping):
                continue
            title = _trim_required(item.get("title"))
            summary = _trim_required(item.get("summary"))
            if not title and not summary:
                continue
            sections.append(
                {
                    "id": _trim_required(item.get("id")),
                    "title": title,
                    "summary": summary,
                    "keyPoints": _coerce_string_list(item.get("keyPoints")),
                    "keywords": _coerce_string_list(item.get("keywords")),
                    "sourceSegmentIds": _evidence(item.get("sourceSegmentIds")),
                }
            )
    _normalize_section_ids(sections)

    key_points: list[dict[str, Any]] = []
    raw_key_points = value.get("keyPoints")
    if isinstance(raw_key_points, list):
        for item in raw_key_points:
            if not isinstance(item, Mapping):
                continue
            content = _trim_required(item.get("content"))
            if not content:
                continue
            key_points.append(
                {
                    "content": content,
                    "importance": normalize_importance(item.get("importance")),
                    "sourceSegmentIds": _evidence(item.get("sourceSegmentIds")),
                }
            )

    glossary: list[dict[str, Any]] = []
    raw_glossary = value.get("glossary")
    if isinstance(raw_glossary, list):
        for item in raw_glossary:
            if not isinstance(item, Mapping):
                continue
            term = _trim_required(item.get("term"))
            definition = _trim_required(item.get("definition"))
            if not term or not definition:
                continue
            glossary.append(
                {
                    "term": term,
                    "definition": definition,
                    "example": _trim_optional(item.get("example")),
                    "category": _trim_optional(item.get("category")),
                    "sourceSegmentIds": _evidence(item.get("sourceSegmentIds")),
                }
            )

    must_remember: list[dict[str, Any]] = []
    raw_must = value.get("mustRemember")
    if isinstance(raw_must, list):
        for item in raw_must:
            if not isinstance(item, Mapping):
                continue
            content = _trim_required(item.get("content"))
            if not content:
                continue
            must_remember.append(
                {
                    "content": content,
                    "importance": normalize_importance(item.get("importance")),
                    "reason": _trim_optional(item.get("reason")),
                    "sourceSegmentIds": _evidence(item.get("sourceSegmentIds")),
                }
            )

    unclear_points: list[dict[str, Any]] = []
    raw_unclear = value.get("unclearPoints")
    if isinstance(raw_unclear, list):
        for item in raw_unclear:
            if not isinstance(item, Mapping):
                continue
            content = _trim_required(item.get("content"))
            if not content:
                continue
            unclear_points.append(
                {
                    "content": content,
                    "reason": _trim_required(item.get("reason")),
                    "sourceSegmentIds": _evidence(item.get("sourceSegmentIds")),
                }
            )

    study = {
        "title": _trim_required(value.get("title")),
        "overview": _trim_required(value.get("overview")),
        "learningObjectives": _coerce_string_list(value.get("learningObjectives")),
        "sections": sections,
        "keyPoints": key_points,
        "keywords": _coerce_string_list(value.get("keywords")),
        "glossary": glossary,
        "mustRemember": must_remember,
        "unclearPoints": unclear_points,
    }

    logger.info(
        "EDUCATION_STUDY_NORMALIZED meeting_id={} sections={} key_points={} glossary={} "
        "must_remember={} unclear={} dropped_segment_ids={}",
        meeting_id,
        len(sections),
        len(key_points),
        len(glossary),
        len(must_remember),
        len(unclear_points),
        dropped_total,
    )
    return study


def allowed_ids_from_segments(segments: Iterable[Mapping[str, Any]] | None) -> set[str]:
    if not segments:
        return set()
    return collect_allowed_segment_ids([dict(item) for item in segments])


def coerce_allowed_segment_ids(value: Any) -> set[str]:
    if value is None:
        return set()
    if isinstance(value, (set, frozenset)):
        return {str(item).strip() for item in value if str(item).strip()}
    if isinstance(value, (list, tuple)):
        return {str(item).strip() for item in value if str(item).strip()}
    return set()


def extract_education_study_raw(parsed: Any) -> Any:
    """Pull educationStudy from common aliases Gemini may emit."""
    if not isinstance(parsed, Mapping):
        return None
    for key in ("educationStudy", "education_study", "EducationStudy"):
        value = parsed.get(key)
        if value is not None:
            return value
    return None


def build_fallback_education_study(
    *,
    summary: str | None = None,
    meeting_summary: str | None = None,
    keywords: Collection[str] | None = None,
    technical_terms: Collection[Any] | None = None,
) -> dict[str, Any]:
    """Minimal educationStudy when the model omits the required object."""
    overview = (
        summary or meeting_summary or ""
    ).strip() or "Nội dung buổi học từ transcript."
    glossary: list[dict[str, Any]] = []
    for item in technical_terms or []:
        if isinstance(item, Mapping):
            term = str(item.get("term") or "").strip()
            definition = str(
                item.get("meaning") or item.get("definition") or ""
            ).strip()
            if term and definition:
                glossary.append(
                    {
                        "term": term,
                        "definition": definition,
                        "example": None,
                        "category": str(item.get("category") or "").strip() or None,
                        "sourceSegmentIds": [],
                    }
                )
        if len(glossary) >= 8:
            break
    keyword_list = [
        str(item).strip() for item in (keywords or []) if str(item).strip()
    ][:12]
    return {
        "title": "Tóm tắt buổi học",
        "overview": overview,
        "learningObjectives": keyword_list[:5],
        "sections": [
            {
                "id": "section-1",
                "title": "Nội dung chính",
                "summary": overview,
                "keyPoints": keyword_list[:5],
                "keywords": keyword_list[:5],
                "sourceSegmentIds": [],
            }
        ],
        "keyPoints": [
            {"content": item, "importance": "MEDIUM", "sourceSegmentIds": []}
            for item in keyword_list[:5]
        ],
        "keywords": keyword_list,
        "glossary": glossary,
        "mustRemember": [],
        "unclearPoints": [],
    }
