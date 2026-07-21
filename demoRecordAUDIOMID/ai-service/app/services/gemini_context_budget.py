from __future__ import annotations

import json
from typing import Any, Iterable


def estimate_text_tokens(value: str) -> int:
    """Conservative local estimate; never performs a provider countTokens call."""

    text = str(value or "")
    if not text:
        return 0
    return max(1, (len(text.encode("utf-8")) + 2) // 3)


def trim_text_to_token_budget(value: str, max_tokens: int) -> str:
    text = str(value or "").strip()
    budget = max(0, int(max_tokens or 0))
    if not text or budget <= 0:
        return ""
    if estimate_text_tokens(text) <= budget:
        return text

    # The estimator uses three UTF-8 bytes per token. Decode with ignore so a
    # multibyte character at the boundary cannot create malformed text.
    return text.encode("utf-8")[: budget * 3].decode("utf-8", errors="ignore").rstrip()


def select_rag_segments(
    segments: Iterable[dict[str, Any]],
    *,
    top_k: int,
    max_tokens: int,
) -> list[dict[str, Any]]:
    """Keep ranked, unique evidence within one local context budget."""

    selected: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    remaining = max(0, int(max_tokens or 0))
    for item in list(segments or [])[: max(0, int(top_k or 0))]:
        if not isinstance(item, dict):
            continue
        quote = str(item.get("quote") or item.get("text") or "").strip()
        if not quote:
            continue
        identity = (
            str(item.get("segmentId") or item.get("segment_id") or ""),
            str(item.get("startTime", item.get("start_time", ""))),
            quote,
        )
        if identity in seen:
            continue

        minimal = {
            "speaker": str(item.get("speaker") or "Speaker"),
            "startTime": item.get("startTime", item.get("start_time", 0)),
            "quote": quote,
        }
        segment_id = item.get("segmentId", item.get("segment_id"))
        if segment_id is not None:
            minimal["segmentId"] = segment_id
        serialized = json.dumps(minimal, ensure_ascii=False, separators=(",", ":"))
        tokens = estimate_text_tokens(serialized)
        if tokens > remaining:
            trimmed_quote = trim_text_to_token_budget(quote, max(0, remaining - 32))
            if not trimmed_quote:
                break
            minimal["quote"] = trimmed_quote
            serialized = json.dumps(minimal, ensure_ascii=False, separators=(",", ":"))
            tokens = estimate_text_tokens(serialized)
        if tokens > remaining:
            break
        selected.append(minimal)
        seen.add(identity)
        remaining -= tokens
    return selected
