from __future__ import annotations

import hashlib
import json
from typing import Any

from loguru import logger

from app.metrics import gemini_metrics
from app.services.analysis_factory import build_analysis_analyzer
from app.services.analysis_errors import AnalysisConfigError, AnalysisProviderError
from app.services.embedding_service import embedding_rerank_meetings
from app.services.gemini_context_budget import (
    estimate_text_tokens,
    trim_text_to_token_budget,
)
from app.services.gemini_cost_guard import reserve_configured_gemini_cost
from app.services.gemini_policy import GeminiWorkload


def semantic_rerank_meetings(
    *,
    settings,
    query: str,
    candidates: list[dict[str, Any]] | None,
    redis_client: Any | None = None,
    owner_user_id: object = None,
) -> dict[str, Any]:
    normalized_query = trim_text_to_token_budget(query, 1000)
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

    candidate_context = _bounded_json_items(
        compact_candidates,
        max_tokens=min(
            int(getattr(settings, "gemini_rag_context_max_tokens", 8000)),
            max(
                1,
                int(getattr(settings, "gemini_chat_max_input_tokens", 12000)) - 1000,
            ),
        ),
    )
    system_prompt = (
        "Bạn là bộ lọc semantic search cho Audiomind. "
        "Chọn các meeting liên quan nhất với truy vấn người dùng. "
        "Trả về JSON hợp lệ với results là mảng {meetingId, score, reason}. "
        "score từ 0 đến 1. Chỉ chọn meeting có trong danh sách candidates."
    )
    prompt = (
        f"Truy vấn: {normalized_query}\n\n" f"Candidates JSON:\n{candidate_context}\n"
    )

    cost_guard, reservation = reserve_configured_gemini_cost(
        settings=settings,
        redis_client=redis_client,
        user_id=owner_user_id or "internal-default",
        meeting_id="semantic-rerank",
        operation_id=hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        estimated_tokens=(
            estimate_text_tokens(prompt + system_prompt)
            + analyzer.chat_max_output_tokens
        ),
    )
    if reservation is not None and not reservation.allowed:
        if reservation.duplicate:
            gemini_metrics.duplicate_suppressed()
        else:
            gemini_metrics.failure(
                "GEMINI_COST_GUARD_UNAVAILABLE"
                if reservation.reason == "guard_unavailable"
                else "GEMINI_COST_LIMIT_EXCEEDED"
            )
        return {
            "query": normalized_query,
            "results": _keyword_fallback(normalized_query, items),
            "provider": "cost_guard",
            "errorCode": (
                "DUPLICATE_REQUEST_SKIPPED"
                if reservation.duplicate
                else (
                    "GEMINI_COST_GUARD_UNAVAILABLE"
                    if reservation.reason == "guard_unavailable"
                    else "GEMINI_COST_LIMIT_EXCEEDED"
                )
            ),
        }

    provider_succeeded = False
    try:
        raw = analyzer._call_gemini_text(
            prompt=prompt,
            system_prompt=system_prompt,
            model=analyzer.summary_model,
            temperature=analyzer.gemini_temperature,
            response_json=True,
            max_output_tokens=analyzer.chat_max_output_tokens,
            workload=GeminiWorkload.CHAT,
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
        provider_succeeded = True
        return {"query": normalized_query, "results": cleaned, "provider": "gemini"}
    except AnalysisProviderError as error:
        error_code = str(getattr(error, "error_code", None) or "GEMINI_UNAVAILABLE")
        gemini_metrics.failure(error_code)
        logger.warning(
            "semantic_rerank_failed error_type={} error_code={}",
            type(error).__name__,
            error_code,
        )
        return {
            "query": normalized_query,
            "results": _keyword_fallback(normalized_query, items),
            "provider": "fallback",
            "errorCode": error_code,
        }
    except Exception as error:
        logger.warning("semantic_rerank_failed error_type={}", type(error).__name__)
        return {
            "query": normalized_query,
            "results": _keyword_fallback(normalized_query, items),
            "provider": "fallback",
        }
    finally:
        if cost_guard is not None:
            cost_guard.release(reservation, success=provider_succeeded)


def _bounded_json_items(items: list[dict[str, Any]], *, max_tokens: int) -> str:
    selected: list[dict[str, Any]] = []
    budget = max(1, int(max_tokens or 1))
    for item in items:
        candidate = [*selected, item]
        encoded = json.dumps(candidate, ensure_ascii=False, separators=(",", ":"))
        if estimate_text_tokens(encoded) > budget:
            break
        selected = candidate
    return json.dumps(selected, ensure_ascii=False, separators=(",", ":"))


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
    redis_client: Any | None = None,
    owner_user_id: object = None,
) -> dict[str, Any]:
    normalized_question = trim_text_to_token_budget(question, 1000)
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
    meetings_context = _bounded_json_items(
        items,
        max_tokens=min(
            int(getattr(settings, "gemini_rag_context_max_tokens", 8000)),
            max(
                1,
                int(getattr(settings, "gemini_chat_max_input_tokens", 12000)) - 1000,
            ),
        ),
    )
    prompt = (
        f"Câu hỏi cross-meeting: {normalized_question}\n\n"
        f"Meetings JSON:\n{meetings_context}\n\n"
        "Trả lời tiếng Việt, tổng hợp insight qua nhiều meeting, nêu meetingId khi trích dẫn."
    )
    cost_guard, reservation = reserve_configured_gemini_cost(
        settings=settings,
        redis_client=redis_client,
        user_id=owner_user_id or "internal-default",
        meeting_id="cross-meeting",
        operation_id=hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        estimated_tokens=(
            estimate_text_tokens(prompt) + analyzer.chat_max_output_tokens
        ),
    )
    if reservation is not None and not reservation.allowed:
        if reservation.duplicate:
            gemini_metrics.duplicate_suppressed()
        else:
            gemini_metrics.failure(
                "GEMINI_COST_GUARD_UNAVAILABLE"
                if reservation.reason == "guard_unavailable"
                else "GEMINI_COST_LIMIT_EXCEEDED"
            )
        return {
            "answer": "Yêu cầu AI đã bị chặn bởi giới hạn chi phí dùng chung.",
            "provider": "cost_guard",
            "errorCode": (
                "DUPLICATE_REQUEST_SKIPPED"
                if reservation.duplicate
                else (
                    "GEMINI_COST_GUARD_UNAVAILABLE"
                    if reservation.reason == "guard_unavailable"
                    else "GEMINI_COST_LIMIT_EXCEEDED"
                )
            ),
        }

    provider_succeeded = False
    try:
        answer = analyzer._call_gemini_text(
            prompt=prompt,
            system_prompt="Bạn là trợ lý Audiomind cho câu hỏi cross-meeting.",
            model=analyzer.summary_model,
            temperature=analyzer.gemini_temperature,
            response_json=False,
            max_output_tokens=analyzer.chat_max_output_tokens,
            workload=GeminiWorkload.CHAT,
        )
        provider_succeeded = True
        return {"answer": (answer or "").strip(), "provider": "gemini"}
    except AnalysisProviderError as error:
        error_code = str(getattr(error, "error_code", None) or "GEMINI_UNAVAILABLE")
        gemini_metrics.failure(error_code)
        logger.warning(
            "cross_meeting_ask_failed error_type={} error_code={}",
            type(error).__name__,
            error_code,
        )
        answer = (
            "Dịch vụ AI hiện tạm dừng do project Gemini đã hết billing credit. "
            "Yêu cầu này không được tự động thử lại."
            if error_code == "GEMINI_BILLING_CREDITS_DEPLETED"
            else "Không thể tạo câu trả lời AI lúc này."
        )
        return {
            "answer": answer,
            "provider": "gemini_unavailable",
            "errorCode": error_code,
        }
    except Exception as error:
        logger.warning("cross_meeting_ask_failed error_type={}", type(error).__name__)
        lines = [
            f"- #{item.get('meetingId')}: {item.get('reason') or item.get('title')}"
            for item in items[:5]
        ]
        return {
            "answer": "Tóm tắt từ semantic search:\n" + "\n".join(lines),
            "provider": "fallback",
        }
    finally:
        if cost_guard is not None:
            cost_guard.release(reservation, success=provider_succeeded)
