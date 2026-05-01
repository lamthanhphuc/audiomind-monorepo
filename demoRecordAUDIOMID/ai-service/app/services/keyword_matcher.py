from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Sequence
import json
import re
import unicodedata

import redis
from loguru import logger

try:
    from rapidfuzz import fuzz as rapidfuzz_fuzz
except Exception:  # pragma: no cover - optional dependency
    rapidfuzz_fuzz = None

try:
    from underthesea import word_tokenize as underthesea_word_tokenize
except Exception:  # pragma: no cover - optional dependency
    underthesea_word_tokenize = None


@dataclass(frozen=True)
class KeywordHit:
    keyword_id: str
    term: str
    confidence: float
    ranges: list[int]


class RedisKeywordEventPublisher:
    def __init__(
        self, redis_client: redis.Redis, stream_name: str = "realtime.keyword_hits"
    ):
        self.redis_client = redis_client
        self.stream_name = stream_name

    def publish(
        self, meeting_id: int, hit: KeywordHit, trace_id: str | None = None
    ) -> str:
        payload = {
            "meeting_id": int(meeting_id),
            "keyword_id": hit.keyword_id,
            "term": hit.term,
            "confidence": float(hit.confidence),
            "ranges": json.dumps(hit.ranges),
        }
        if trace_id:
            payload["trace_id"] = trace_id

        message_id = self.redis_client.xadd(
            self.stream_name,
            payload,
            maxlen=10_000,
            approximate=True,
        )
        return str(message_id)


class KeywordMatcher:
    def __init__(
        self,
        glossary_terms_provider: Callable[[str], Sequence[Any]],
        min_confidence: float = 0.82,
        language: str = "vi",
    ):
        self.glossary_terms_provider = glossary_terms_provider
        self.min_confidence = min_confidence
        self.language = language

    def match(
        self, text: str, glossary_version: str, lang: str = "vi"
    ) -> list[dict[str, Any]]:
        glossary_entries = self.glossary_terms_provider(glossary_version) or []
        normalized_text = self._normalize_for_match(text, lang)
        if not normalized_text.strip():
            return []

        hits: list[dict[str, Any]] = []
        for index, entry in enumerate(glossary_entries):
            term, keyword_id = self._extract_term(entry, index)
            if not term:
                continue

            normalized_term = self._normalize_for_match(term, lang)
            if not normalized_term:
                continue

            span = self._find_exact_span(normalized_text, normalized_term)
            confidence = 1.0 if span is not None else 0.0

            if span is None:
                confidence, span = self._find_fuzzy_span(
                    normalized_text, normalized_term
                )

            if span is None or confidence < self.min_confidence:
                continue

            hits.append(
                {
                    "keyword_id": keyword_id,
                    "term": term,
                    "confidence": round(float(confidence), 4),
                    "ranges": [span[0], span[1]],
                }
            )

        return hits

    def _extract_term(self, entry: Any, index: int) -> tuple[str, str]:
        if isinstance(entry, dict):
            term = str(entry.get("term") or entry.get("normalized") or "").strip()
            keyword_id = str(
                entry.get("keyword_id") or entry.get("id") or term or index
            )
            return term, keyword_id

        term = str(entry or "").strip()
        return term, term or str(index)

    def _normalize_for_match(self, value: str, lang: str) -> str:
        text = str(value or "").strip().lower()
        if not text:
            return ""

        if lang.startswith("vi") and underthesea_word_tokenize is not None:
            try:
                text = underthesea_word_tokenize(text, format="text")
            except Exception:
                logger.debug(
                    "underthesea tokenization failed; falling back to regex normalization."
                )

        text = unicodedata.normalize("NFD", text)
        text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
        text = re.sub(r"[^\w\s#\+\.-]", " ", text)
        text = re.sub(r"\s+", " ", text)
        return text.strip()

    def _find_exact_span(
        self, normalized_text: str, normalized_term: str
    ) -> tuple[int, int] | None:
        if not normalized_text or not normalized_term:
            return None

        pattern = rf"(?<!\w){re.escape(normalized_term)}(?!\w)"
        match = re.search(pattern, normalized_text)
        if match is None:
            return None
        return match.start(), match.end()

    def _find_fuzzy_span(
        self, normalized_text: str, normalized_term: str
    ) -> tuple[float, tuple[int, int] | None]:
        tokens = normalized_text.split()
        term_tokens = normalized_term.split()
        if not tokens or not term_tokens:
            return 0.0, None

        ngram_size = max(1, len(term_tokens))
        best_score = 0.0
        best_span: tuple[int, int] | None = None

        for start_index in range(0, max(1, len(tokens) - ngram_size + 1)):
            window_tokens = tokens[start_index : start_index + ngram_size]
            if not window_tokens:
                continue
            window_text = " ".join(window_tokens)
            score = self._similarity(window_text, normalized_term)
            if score > best_score:
                best_score = score
                span_start = self._char_offset(tokens, start_index)
                span_end = span_start + len(window_text)
                best_span = (span_start, span_end)

        return best_score, best_span

    def _char_offset(self, tokens: list[str], index: int) -> int:
        if index <= 0:
            return 0
        return sum(len(token) + 1 for token in tokens[:index])

    def _similarity(self, left: str, right: str) -> float:
        if rapidfuzz_fuzz is not None:
            return float(rapidfuzz_fuzz.ratio(left, right)) / 100.0

        from difflib import SequenceMatcher

        return SequenceMatcher(a=left, b=right).ratio()
