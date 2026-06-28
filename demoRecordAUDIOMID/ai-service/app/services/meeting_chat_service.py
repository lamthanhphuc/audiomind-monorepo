from __future__ import annotations

import json
from typing import Any

from loguru import logger

from app.services.analysis_factory import build_analysis_analyzer
from app.services.analysis_errors import AnalysisConfigError, AnalysisUnavailableError


def answer_meeting_question(
    *,
    settings,
    question: str,
    summary: str,
    transcript_excerpt: str,
    analysis: dict[str, Any] | None,
    source_segments: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    normalized_question = (question or "").strip()
    if not normalized_question:
        return {"answer": "Hãy nhập câu hỏi về nội dung cuộc họp.", "provider": "rules", "source_segments": []}

    segments = source_segments or []
    try:
        analyzer = build_analysis_analyzer(settings)
    except AnalysisConfigError as error:
        logger.warning("meeting_chat_config_error error={}", error)
        return {
            "answer": _fallback_answer(summary, transcript_excerpt, normalized_question, segments),
            "provider": "fallback",
            "source_segments": segments,
        }

    analysis_json = json.dumps(analysis or {}, ensure_ascii=False)[:6000]
    excerpt = (transcript_excerpt or "").strip()[:12000]
    summary_text = (summary or "").strip()[:4000]
    segments_json = json.dumps(segments, ensure_ascii=False)[:4000]

    system_prompt = (
        "Bạn là trợ lý cuộc họp Audiomind. Trả lời ngắn gọn, chính xác, bằng tiếng Việt "
        "trừ khi người dùng hỏi bằng tiếng Anh. Chỉ dựa trên summary, analysis JSON, transcript excerpt "
        "và source_segments. Khi trích dẫn, dùng định dạng: "
        "\"Tên người nói — nguồn HH:MM:SS\" hoặc \"Speaker — nguồn HH:MM:SS\". "
        "Không bịa timestamp hoặc speaker ngoài dữ liệu. "
        "Trả về JSON: {\"answer\": string, \"source_segments\": [{\"speaker\", \"startTime\", \"quote\", \"segmentId\"?}]}."
    )
    prompt = (
        f"Câu hỏi: {normalized_question}\n\n"
        f"Tóm tắt:\n{summary_text or '(chưa có)'}\n\n"
        f"Analysis JSON:\n{analysis_json}\n\n"
        f"Transcript excerpt (có timestamp):\n{excerpt or '(chưa có)'}\n\n"
        f"source_segments JSON:\n{segments_json or '[]'}\n"
    )

    try:
        raw = analyzer._call_gemini_text(
            prompt=prompt,
            system_prompt=system_prompt,
            model=analyzer.summary_model,
            temperature=0.2,
            response_json=True,
            max_output_tokens=1024,
        )
        parsed = json.loads(raw) if isinstance(raw, str) else raw
        if isinstance(parsed, dict):
            answer = str(parsed.get("answer") or "").strip()
            structured_segments = parsed.get("source_segments") or parsed.get("sourceSegments")
            merged_segments = segments
            if isinstance(structured_segments, list) and structured_segments:
                merged_segments = _normalize_structured_segments(structured_segments, segments)
            if answer:
                return {"answer": answer, "provider": "gemini", "source_segments": merged_segments}
        raise AnalysisUnavailableError("Empty structured chat response", provider="gemini")
    except Exception as error:
        logger.warning("meeting_chat_failed error={}", error)
        return {
            "answer": _fallback_answer(summary_text, excerpt, normalized_question, segments),
            "provider": "fallback",
            "source_segments": segments,
        }


def _fallback_answer(summary: str, excerpt: str, question: str, segments: list[dict[str, Any]] | None = None) -> str:
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
) -> dict[str, Any]:
    normalized_term = (term or "").strip()
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

    analysis_json = json.dumps(analysis or {}, ensure_ascii=False)[:4000]
    excerpt = (transcript_excerpt or "").strip()[:8000]
    summary_text = (summary or "").strip()[:3000]
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
    try:
        answer = analyzer._call_gemini_text(
            prompt=prompt,
            system_prompt=system_prompt,
            model=analyzer.summary_model,
            temperature=0.2,
            response_json=False,
            max_output_tokens=700,
        )
        cleaned = (answer or "").strip()
        if not cleaned:
            raise AnalysisUnavailableError("Empty term explain response", provider="gemini")
        return {"explanation": cleaned, "provider": "gemini", "term": normalized_term}
    except Exception as error:
        logger.warning("term_explain_failed error={}", error)
        return {
            "explanation": f"{normalized_term}: thuật ngữ kỹ thuật. Gemini tạm không khả dụng để giải thích chi tiết.",
            "provider": "fallback",
            "term": normalized_term,
        }
