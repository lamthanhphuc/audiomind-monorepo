from __future__ import annotations

import json
import math
import os
from typing import Any

from loguru import logger
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import SessionLocal


def _embedding_enabled() -> bool:
    return os.getenv("EMBEDDING_SEARCH_ENABLED", "true").lower() in {"1", "true", "yes"}


def _cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / (left_norm * right_norm)


def embed_text(settings, content: str) -> list[float] | None:
    normalized = (content or "").strip()
    if not normalized:
        return None
    try:
        import google.generativeai as genai

        api_key = getattr(settings, "gemini_api_key", None) or os.getenv("GEMINI_API_KEY")
        if not api_key:
            return None
        genai.configure(api_key=api_key)
        model = os.getenv("GEMINI_EMBEDDING_MODEL", "models/text-embedding-004")
        result = genai.embed_content(model=model, content=normalized[:6000])
        values = result.get("embedding") if isinstance(result, dict) else getattr(result, "embedding", None)
        if isinstance(values, dict):
            values = values.get("values")
        if not isinstance(values, list):
            return None
        return [float(value) for value in values]
    except Exception as error:
        logger.warning("embedding_failed error={}", error)
        return None


def upsert_meeting_embedding(
    *,
    meeting_id: int,
    user_id: int,
    embedding: list[float],
    content_preview: str,
) -> None:
    session: Session = SessionLocal()
    try:
        session.execute(
            text(
                """
                INSERT INTO meeting_semantic_embeddings (meeting_id, user_id, embedding, content_preview, updated_at)
                VALUES (:meeting_id, :user_id, CAST(:embedding AS jsonb), :content_preview, now())
                ON CONFLICT (meeting_id) DO UPDATE SET
                    user_id = EXCLUDED.user_id,
                    embedding = EXCLUDED.embedding,
                    content_preview = EXCLUDED.content_preview,
                    updated_at = now()
                """
            ),
            {
                "meeting_id": meeting_id,
                "user_id": user_id,
                "embedding": json.dumps(embedding),
                "content_preview": content_preview[:2000],
            },
        )
        session.commit()
    except Exception as error:
        session.rollback()
        logger.warning("embedding_upsert_failed meetingId={} error={}", meeting_id, error)
    finally:
        session.close()


def load_embeddings_for_meetings(meeting_ids: list[int]) -> dict[int, list[float]]:
    if not meeting_ids:
        return {}
    session: Session = SessionLocal()
    try:
        rows = session.execute(
            text(
                """
                SELECT meeting_id, embedding
                FROM meeting_semantic_embeddings
                WHERE meeting_id = ANY(:meeting_ids)
                """
            ),
            {"meeting_ids": meeting_ids},
        ).fetchall()
        result: dict[int, list[float]] = {}
        for row in rows:
            meeting_id = int(row[0])
            raw = row[1]
            if isinstance(raw, str):
                raw = json.loads(raw)
            if isinstance(raw, list):
                result[meeting_id] = [float(value) for value in raw]
        return result
    except Exception as error:
        logger.warning("embedding_load_failed error={}", error)
        return {}
    finally:
        session.close()


def index_meeting_for_search(
    *,
    settings,
    meeting_id: int,
    user_id: int,
    title: str = "",
    summary: str = "",
    grouped_plan_excerpt: str = "",
) -> None:
    if not _embedding_enabled():
        return
    haystack = " ".join(
        [
            str(title or "").strip(),
            str(summary or "").strip(),
            str(grouped_plan_excerpt or "").strip(),
        ]
    ).strip()
    if not haystack:
        return
    vector = embed_text(settings, haystack)
    if not vector:
        return
    upsert_meeting_embedding(
        meeting_id=meeting_id,
        user_id=user_id,
        embedding=vector,
        content_preview=haystack,
    )


def embedding_rerank_meetings(
    *,
    settings,
    query: str,
    candidates: list[dict[str, Any]] | None,
) -> dict[str, Any] | None:
    if not _embedding_enabled():
        return None
    normalized_query = (query or "").strip()
    items = candidates or []
    if not normalized_query or not items:
        return None

    query_embedding = embed_text(settings, normalized_query)
    if not query_embedding:
        return None

    meeting_ids: list[int] = []
    for item in items:
        meeting_id = item.get("meetingId", item.get("meeting_id"))
        if meeting_id is not None:
            meeting_ids.append(int(meeting_id))

    stored = load_embeddings_for_meetings(meeting_ids)
    scored: list[tuple[float, dict[str, Any]]] = []

    for item in items:
        meeting_id = item.get("meetingId", item.get("meeting_id"))
        if meeting_id is None:
            continue
        meeting_id_int = int(meeting_id)
        vector = stored.get(meeting_id_int)
        if vector is None:
            haystack = " ".join(
                [
                    str(item.get("title") or ""),
                    str(item.get("summary") or ""),
                    str(item.get("groupedPlanExcerpt") or item.get("grouped_plan_excerpt") or ""),
                ]
            ).strip()
            vector = embed_text(settings, haystack)
            if vector:
                user_id = int(item.get("userId") or item.get("user_id") or 0)
                upsert_meeting_embedding(
                    meeting_id=meeting_id_int,
                    user_id=user_id,
                    embedding=vector,
                    content_preview=haystack,
                )
        if not vector:
            continue
        score = _cosine_similarity(query_embedding, vector)
        if score <= 0.05:
            continue
        scored.append((score, item))

    if not scored:
        return None

    scored.sort(key=lambda pair: pair[0], reverse=True)
    results = []
    for score, item in scored[:10]:
        meeting_id = item.get("meetingId", item.get("meeting_id"))
        results.append(
            {
                "meetingId": meeting_id,
                "score": round(min(1.0, score), 4),
                "reason": "Khớp embedding semantic (vector)",
            }
        )
    return {"query": normalized_query, "results": results, "provider": "embedding"}
