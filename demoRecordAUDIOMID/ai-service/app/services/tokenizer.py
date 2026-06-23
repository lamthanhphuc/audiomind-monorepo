"""Shared tokenizer for TF-IDF (Epic 3 §2.4)."""

from __future__ import annotations

import re
import unicodedata
from collections import Counter

_TOKEN_PATTERN = re.compile(r"\b\w+\b", flags=re.UNICODE)


def normalize_token(text: str) -> str:
    """Diacritic normalization + lowercase for a single token."""
    if not text:
        return ""
    lower = text.lower().replace("\u0111", "d").replace("\u0110", "D")
    decomposed = unicodedata.normalize("NFD", lower)
    stripped = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    return stripped.strip()


def tokenize_for_tf_idf(text: str) -> list[str]:
    """Tokenize text with regex \\b\\w+\\b then normalize each token."""
    if not text:
        return []
    tokens: list[str] = []
    for raw in _TOKEN_PATTERN.findall(str(text)):
        normalized = normalize_token(raw)
        if len(normalized) >= 1:
            tokens.append(normalized)
    return tokens


def term_frequency_map(text: str) -> dict[str, int]:
    """Raw token counts for a segment (merged duplicate tokens)."""
    counts = Counter(tokenize_for_tf_idf(text))
    return dict(counts)
