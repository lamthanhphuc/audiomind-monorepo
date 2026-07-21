from __future__ import annotations

import json
import hashlib
from typing import Any

from loguru import logger

from app.metrics.gemini_metrics import gemini_metrics
from app.services.analysis_factory import build_analysis_analyzer
from app.services.analysis_errors import (
    AnalysisConfigError,
    AnalysisProviderError,
    AnalysisUnavailableError,
)
from app.services.gemini_context_budget import (
    estimate_text_tokens,
    select_rag_segments,
    trim_text_to_token_budget,
)
from app.services.gemini_cost_guard import (
    GeminiCostGuard,
    reserve_configured_gemini_cost,
)
from app.services.gemini_policy import GeminiWorkload


def answer_meeting_question(
    *,
    settings,
    question: str,
    summary: str,
    transcript_excerpt: str,
    analysis: dict[str, Any] | None,
    source_segments: list[dict[str, Any]] | None = None,
    redis_client: Any | None = None,
    meeting_id: int | None = None,
    owner_user_id: int | None = None,
) -> dict[str, Any]:
    chat_input_budget = max(
        1, int(getattr(settings, "gemini_chat_max_input_tokens", 12000))
    )
    question_budget = min(1000, max(128, chat_input_budget // 6))
    normalized_question = trim_text_to_token_budget(question, question_budget)
    if not normalized_question:
        return {
            "answer": "Hãy nhập câu hỏi về nội dung cuộc họp.",
            "provider": "rules",
            "source_segments": [],
        }

    context_budget = min(
        int(settings.gemini_rag_context_max_tokens),
        max(
            0,
            chat_input_budget
            - int(settings.gemini_chat_history_max_tokens)
            - question_budget
            - 512,
        ),
    )
    segments = select_rag_segments(
        source_segments or [],
        top_k=settings.gemini_rag_top_k,
        max_tokens=context_budget,
    )
    try:
        analyzer = build_analysis_analyzer(settings)
    except AnalysisConfigError as error:
        logger.warning("meeting_chat_config_error error={}", error)
        return {
            "answer": _fallback_answer(
                summary, transcript_excerpt, normalized_question, segments
            ),
            "provider": "fallback",
            "source_segments": segments,
        }

    summary_text = trim_text_to_token_budget(
        summary or "", settings.gemini_chat_history_max_tokens
    )
    # Retrieved evidence is authoritative for RAG. A transcript excerpt is only
    # retained as a bounded legacy fallback when retrieval returned no evidence.
    excerpt = (
        ""
        if segments
        else trim_text_to_token_budget(transcript_excerpt or "", context_budget)
    )
    segments_json = json.dumps(segments, ensure_ascii=False, separators=(",", ":"))

    system_prompt = (
        "Bạn là trợ lý cuộc họp Audiomind. Trả lời ngắn gọn, chính xác, bằng tiếng Việt "
        "trừ khi người dùng hỏi bằng tiếng Anh. Chỉ dựa trên summary và "
        "source_segments đã retrieve. Khi trích dẫn, dùng định dạng: "
        '"Tên người nói — nguồn HH:MM:SS" hoặc "Speaker — nguồn HH:MM:SS". '
        "Không bịa timestamp hoặc speaker ngoài dữ liệu. "
        'Trả về JSON: {"answer": string, "source_segments": [{"speaker", "startTime", "quote", "segmentId"?}]}.'
    )
    prompt = (
        f"Câu hỏi: {normalized_question}\n\n"
        f"Tóm tắt:\n{summary_text or '(chưa có)'}\n\n"
        f"source_segments JSON:\n{segments_json or '[]'}\n"
    )
    if not segments and excerpt:
        prompt += f"\nTranscript excerpt dự phòng:\n{excerpt}\n"

    cost_guard = None
    cost_reservation = None
    if settings.gemini_cost_guard_enabled:
        cost_guard = GeminiCostGuard(
            redis_client,
            namespace=settings.gemini_cost_guard_namespace,
            daily_request_limit_per_user=settings.gemini_daily_request_limit_per_user,
            daily_reanalysis_limit_per_meeting=(
                settings.gemini_daily_reanalyze_limit_per_meeting
            ),
            daily_token_limit_per_user=settings.gemini_daily_token_limit_per_user,
            max_concurrent_requests=settings.gemini_max_concurrent_requests,
        )
        operation_material = json.dumps(
            {
                "meeting_id": meeting_id,
                "question": normalized_question,
                "segments": segments,
                "model": analyzer.summary_model,
                "workload": "chat",
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        cost_reservation = cost_guard.reserve(
            user_id=owner_user_id or "internal-default",
            meeting_id=meeting_id or "chat",
            operation_id=hashlib.sha256(operation_material.encode("utf-8")).hexdigest(),
            estimated_tokens=(
                estimate_text_tokens(prompt + system_prompt)
                + analyzer.chat_max_output_tokens
            ),
            is_reanalysis=False,
        )
        if not cost_reservation.allowed:
            if cost_reservation.duplicate:
                gemini_metrics.duplicate_suppressed()
            else:
                gemini_metrics.failure(
                    "GEMINI_COST_GUARD_UNAVAILABLE"
                    if cost_reservation.reason == "guard_unavailable"
                    else "GEMINI_COST_LIMIT_EXCEEDED"
                )
            return {
                "answer": _fallback_answer(
                    summary_text, excerpt, normalized_question, segments
                ),
                "provider": "cost_guard",
                "source_segments": segments,
                "error_code": (
                    "DUPLICATE_REQUEST_SKIPPED"
                    if cost_reservation.duplicate
                    else (
                        "GEMINI_COST_GUARD_UNAVAILABLE"
                        if cost_reservation.reason == "guard_unavailable"
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
        if isinstance(parsed, dict):
            answer = str(parsed.get("answer") or "").strip()
            structured_segments = parsed.get("source_segments") or parsed.get(
                "sourceSegments"
            )
            merged_segments = segments
            if isinstance(structured_segments, list) and structured_segments:
                merged_segments = _normalize_structured_segments(
                    structured_segments, segments
                )
            if answer:
                provider_succeeded = True
                return {
                    "answer": answer,
                    "provider": "gemini",
                    "source_segments": merged_segments,
                }
        raise AnalysisUnavailableError(
            "Empty structured chat response", provider="gemini"
        )
    except AnalysisProviderError as error:
        error_code = str(getattr(error, "error_code", None) or "GEMINI_UNAVAILABLE")
        gemini_metrics.failure(error_code)
        logger.warning(
            "meeting_chat_failed error_type={} error_code={}",
            type(error).__name__,
            error_code,
        )
        if error_code == "GEMINI_BILLING_CREDITS_DEPLETED":
            answer = (
                "Dịch vụ AI hiện tạm dừng do project Gemini đã hết billing credit. "
                "Yêu cầu này không được tự động thử lại."
            )
        else:
            answer = _fallback_answer(
                summary_text, excerpt, normalized_question, segments
            )
        return {
            "answer": answer,
            "provider": "gemini_unavailable",
            "source_segments": segments,
            "error_code": error_code,
        }
    except Exception as error:
        logger.warning("meeting_chat_failed error_type={}", type(error).__name__)
        return {
            "answer": _fallback_answer(
                summary_text, excerpt, normalized_question, segments
            ),
            "provider": "fallback",
            "source_segments": segments,
        }
    finally:
        if cost_guard is not None:
            cost_guard.release(cost_reservation, success=provider_succeeded)


def _fallback_answer(
    summary: str,
    excerpt: str,
    question: str,
    segments: list[dict[str, Any]] | None = None,
) -> str:
    lowered = question.lower()
    if summary and ("tóm tắt" in lowered or "summary" in lowered):
        return f"Tóm tắt cuộc họp:\n{summary}"
    if segments:
        lines = []
        for index, segment in enumerate(segments[:3], start=1):
            speaker = str(segment.get("speaker") or "Speaker")
            start_time = segment.get("startTime", segment.get("start_time", 0))
            quote = str(segment.get("quote") or segment.get("text") or "").strip()
            clock = _format_clock(start_time)
            snippet = quote[:220] + ("…" if len(quote) > 220 else "")
            lines.append(f"{index}. {speaker} — nguồn {clock}: {snippet}")
        if lines:
            return "Mình tìm thấy các đoạn liên quan:\n" + "\n".join(lines)
    if excerpt:
        return (
            "Gemini tạm thời không khả dụng. Dưới đây là một phần transcript liên quan:\n"
            + excerpt[:1200]
        )
    return "Chưa đủ dữ liệu để trả lời. Hãy đợi transcript/phân tích sẵn sàng."


def _normalize_structured_segments(
    structured: list[Any],
    fallback: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    for item in structured:
        if not isinstance(item, dict):
            continue
        quote = str(item.get("quote") or item.get("text") or "").strip()
        if not quote:
            continue
        cleaned.append(
            {
                "speaker": str(item.get("speaker") or "Speaker"),
                "startTime": item.get("startTime", item.get("start_time", 0)),
                "endTime": item.get("endTime", item.get("end_time")),
                "quote": quote,
                "segmentId": item.get("segmentId", item.get("segment_id")),
                "evidenceId": item.get("evidenceId", item.get("evidence_id")),
            }
        )
    return cleaned or fallback


def _format_clock(value: Any) -> str:
    try:
        total_seconds = int(max(0, float(value)))
    except (TypeError, ValueError):
        return "00:00"
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


def explain_meeting_term(
    *,
    settings,
    term: str,
    summary: str,
    transcript_excerpt: str,
    analysis: dict[str, Any] | None,
    redis_client: Any | None = None,
    meeting_id: int | None = None,
    owner_user_id: object = None,
) -> dict[str, Any]:
    normalized_term = trim_text_to_token_budget(term, 256)
    if not normalized_term:
        return {"explanation": "Hãy chọn một thuật ngữ.", "provider": "rules"}

    try:
        analyzer = build_analysis_analyzer(settings)
    except AnalysisConfigError as error:
        logger.warning("term_explain_config_error error={}", error)
        return {
            "explanation": f"{normalized_term}: thuật ngữ kỹ thuật xuất hiện trong cuộc họp.",
            "provider": "fallback",
        }

    excerpt = trim_text_to_token_budget(
        transcript_excerpt,
        int(getattr(settings, "gemini_rag_context_max_tokens", 8000)),
    )
    summary_text = trim_text_to_token_budget(summary, 1000)
    analysis_json = (
        ""
        if excerpt
        else trim_text_to_token_budget(
            json.dumps(analysis or {}, ensure_ascii=False), 1000
        )
    )
    system_prompt = (
        "Bạn là trợ lý giải thích thuật ngữ cho cuộc họp Audiomind. "
        "Trả lời bằng tiếng Việt, ngắn gọn, gồm: định nghĩa, ví dụ trong ngữ cảnh họp (nếu có), "
        "và gợi ý liên quan. Không bịa nếu transcript không đủ dữ liệu."
    )
    prompt = (
        f"Thuật ngữ: {normalized_term}\n\n"
        f"Tóm tắt:\n{summary_text or '(chưa có)'}\n\n"
        f"Analysis JSON:\n{analysis_json}\n\n"
        f"Transcript excerpt:\n{excerpt or '(chưa có)'}\n"
    )
    cost_guard, reservation = reserve_configured_gemini_cost(
        settings=settings,
        redis_client=redis_client,
        user_id=owner_user_id or "internal-default",
        meeting_id=meeting_id or "term-explain",
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
            "explanation": "Yêu cầu AI đã bị chặn bởi giới hạn chi phí dùng chung.",
            "provider": "cost_guard",
            "term": normalized_term,
            "error_code": (
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
            system_prompt=system_prompt,
            model=analyzer.summary_model,
            temperature=analyzer.gemini_temperature,
            response_json=False,
            max_output_tokens=analyzer.chat_max_output_tokens,
            workload=GeminiWorkload.CHAT,
        )
        cleaned = (answer or "").strip()
        if not cleaned:
            raise AnalysisUnavailableError(
                "Empty term explain response", provider="gemini"
            )
        provider_succeeded = True
        return {"explanation": cleaned, "provider": "gemini", "term": normalized_term}
    except AnalysisProviderError as error:
        error_code = str(getattr(error, "error_code", None) or "GEMINI_UNAVAILABLE")
        gemini_metrics.failure(error_code)
        explanation = (
            "Dịch vụ AI hiện tạm dừng do project Gemini đã hết billing credit. "
            "Yêu cầu này không được tự động thử lại."
            if error_code == "GEMINI_BILLING_CREDITS_DEPLETED"
            else f"{normalized_term}: dịch vụ AI hiện không khả dụng."
        )
        return {
            "explanation": explanation,
            "provider": "gemini_unavailable",
            "term": normalized_term,
            "error_code": error_code,
        }
    except Exception as error:
        logger.warning("term_explain_failed error_type={}", type(error).__name__)
        return {
            "explanation": f"{normalized_term}: thuật ngữ kỹ thuật. Gemini tạm không khả dụng để giải thích chi tiết.",
            "provider": "fallback",
            "term": normalized_term,
        }
    finally:
        if cost_guard is not None:
            cost_guard.release(reservation, success=provider_succeeded)
