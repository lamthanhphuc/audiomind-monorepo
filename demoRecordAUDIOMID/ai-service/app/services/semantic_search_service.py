from __future__ import annotations

import json
from typing import Any

from loguru import logger

from app.services.analysis_factory import build_analysis_analyzer
from app.services.analysis_errors import AnalysisConfigError
from app.services.embedding_service import embedding_rerank_meetings


def semantic_rerank_meetings(
    *,
    settings,
    query: str,
    candidates: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    normalized_query = (query or "").strip()
    items = candidates or []
    if not normalized_query:
        return {"query": "", "results": [], "provider": "rules"}
    if not items:
        return {"query": normalized_query, "results": [], "provider": "rules"}

    embedding_result = embedding_rerank_meetings(
        settings=settings,
        query=normalized_query,
        candidates=items,
    )
    if embedding_result and embedding_result.get("results"):
        return embedding_result

    try:
        analyzer = build_analysis_analyzer(settings)
    except AnalysisConfigError as error:
        logger.warning("semantic_rerank_config_error error={}", error)
        return {
            "query": normalized_query,
            "results": _keyword_fallback(normalized_query, items),
            "provider": "fallback",
        }

    compact_candidates = []
    for item in items[:30]:
        meeting_id = item.get("meetingId", item.get("meeting_id"))
        compact_candidates.append(
            {
                "meetingId": meeting_id,
                "title": str(item.get("title") or item.get("originalFileName") or ""),
                "summary": str(item.get("summary") or "")[:1200],
                "groupedPlan": str(
                    item.get("groupedPlanExcerpt")
                    or item.get("grouped_plan_excerpt")
                    or ""
                )[:1200],
            }
        )

    system_prompt = (
        "Bạn là bộ lọc semantic search cho Audiomind. "
        "Chọn các meeting liên quan nhất với truy vấn người dùng. "
        "Trả về JSON hợp lệ với results là mảng {meetingId, score, reason}. "
        "score từ 0 đến 1. Chỉ chọn meeting có trong danh sách candidates."
    )
    prompt = (
        f"Truy vấn: {normalized_query}\n\n"
        f"Candidates JSON:\n{json.dumps(compact_candidates, ensure_ascii=False)}\n"
    )

    try:
        raw = analyzer._call_gemini_text(
            prompt=prompt,
            system_prompt=system_prompt,
            model=analyzer.summary_model,
            temperature=0.1,
            response_json=True,
            max_output_tokens=1200,
        )
        parsed = json.loads(raw) if isinstance(raw, str) else raw
        results = parsed.get("results") if isinstance(parsed, dict) else None
        if not isinstance(results, list):
            raise ValueError("Invalid semantic rerank payload")
        cleaned = []
        for entry in results[:10]:
            if not isinstance(entry, dict):
                continue
            meeting_id = entry.get("meetingId", entry.get("meeting_id"))
            if meeting_id is None:
                continue
            cleaned.append(
                {
                    "meetingId": meeting_id,
                    "score": float(entry.get("score", 0)),
                    "reason": str(entry.get("reason") or "").strip(),
                }
            )
        if not cleaned:
            raise ValueError("Empty semantic rerank results")
        return {"query": normalized_query, "results": cleaned, "provider": "gemini"}
    except Exception as error:
        logger.warning("semantic_rerank_failed error={}", error)
        return {
            "query": normalized_query,
            "results": _keyword_fallback(normalized_query, items),
            "provider": "fallback",
        }


def _keyword_fallback(query: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    lowered = query.lower()
    tokens = [token for token in lowered.split() if len(token) >= 2]
    scored: list[tuple[float, dict[str, Any]]] = []
    for item in items:
        haystack = " ".join(
            [
                str(item.get("title") or ""),
                str(item.get("originalFileName") or ""),
                str(item.get("summary") or ""),
                str(
                    item.get("groupedPlanExcerpt")
                    or item.get("grouped_plan_excerpt")
                    or ""
                ),
            ]
        ).lower()
        if not haystack.strip():
            continue
        score = 0.0
        if lowered in haystack:
            score += 1.0
        for token in tokens:
            if token in haystack:
                score += 0.2
        if score <= 0:
            continue
        scored.append((score, item))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    results = []
    for score, item in scored[:10]:
        meeting_id = item.get("meetingId", item.get("meeting_id"))
        if meeting_id is None:
            continue
        results.append(
            {
                "meetingId": meeting_id,
                "score": min(1.0, score),
                "reason": "Khớp từ khóa trong tiêu đề/tóm tắt",
            }
        )
    return results


def ask_cross_meeting(
    *,
    settings,
    question: str,
    meetings: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    normalized_question = (question or "").strip()
    items = meetings or []
    if not normalized_question:
        return {"answer": "Hãy nhập câu hỏi cross-meeting.", "provider": "rules"}
    if not items:
        return {
            "answer": "Chưa tìm thấy meeting liên quan trong 3 tháng gần đây.",
            "provider": "fallback",
        }
    try:
        analyzer = build_analysis_analyzer(settings)
    except AnalysisConfigError:
        lines = [
            f"- Meeting #{item.get('meetingId')}: {item.get('title') or item.get('reason')}"
            for item in items[:5]
        ]
        return {
            "answer": "Các meeting liên quan:\n" + "\n".join(lines),
            "provider": "fallback",
        }
    prompt = (
        f"Câu hỏi cross-meeting: {normalized_question}\n\n"
        f"Meetings JSON:\n{json.dumps(items, ensure_ascii=False)[:8000]}\n\n"
        "Trả lời tiếng Việt, tổng hợp insight qua nhiều meeting, nêu meetingId khi trích dẫn."
    )
    try:
        answer = analyzer._call_gemini_text(
            prompt=prompt,
            system_prompt="Bạn là trợ lý Audiomind cho câu hỏi cross-meeting.",
            model=analyzer.summary_model,
            temperature=0.2,
            response_json=False,
            max_output_tokens=1200,
        )
        return {"answer": (answer or "").strip(), "provider": "gemini"}
    except Exception as error:
        logger.warning("cross_meeting_ask_failed error={}", error)
        lines = [
            f"- #{item.get('meetingId')}: {item.get('reason') or item.get('title')}"
            for item in items[:5]
        ]
        return {
            "answer": "Tóm tắt từ semantic search:\n" + "\n".join(lines),
            "provider": "fallback",
        }
