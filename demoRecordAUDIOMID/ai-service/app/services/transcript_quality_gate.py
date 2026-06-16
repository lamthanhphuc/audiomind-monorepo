from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

SKIP_REASON_SHORT = "ANALYSIS_SKIPPED_SHORT_TRANSCRIPT"
SKIP_REASON_NO_MEANINGFUL = "NO_MEANINGFUL_TRANSCRIPT"

_FILLER_TOKENS = frozenset(
    {
        "ừ",
        "à",
        "ờ",
        "hmm",
        "uh",
        "um",
        "uhm",
        "erm",
        "ah",
        "oh",
        "ừm",
        "àm",
        "ừa",
        "ừm",
        "hm",
        "mm",
        "mhm",
    }
)

_PUNCTUATION_RE = re.compile(r"[^\w\s]", flags=re.UNICODE)


@dataclass(frozen=True)
class TranscriptQualityVerdict:
    should_analyze: bool
    skip_reason: str | None
    normalized_chars: int
    word_count: int


def normalize_transcript_text(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = _PUNCTUATION_RE.sub(" ", text.lower())
    return " ".join(text.split())


def _word_count(normalized: str) -> int:
    if not normalized:
        return 0
    return len(normalized.split())


def _filler_ratio(normalized: str) -> float:
    tokens = normalized.split()
    if not tokens:
        return 0.0
    filler_count = sum(1 for token in tokens if token in _FILLER_TOKENS)
    return filler_count / len(tokens)


def _has_duplicate_micro_loop(normalized: str, *, min_repeats: int = 4) -> bool:
    tokens = normalized.split()
    if len(tokens) < min_repeats:
        return False
    max_phrase_len = len(tokens) // min_repeats
    for size in range(1, max(max_phrase_len, 1) + 1):
        for start in range(0, len(tokens) - size * min_repeats + 1):
            phrase_tokens = tokens[start : start + size]
            if len(" ".join(phrase_tokens)) < 3:
                continue
            repeats = 1
            cursor = start + size
            while (
                cursor + size <= len(tokens)
                and tokens[cursor : cursor + size] == phrase_tokens
            ):
                repeats += 1
                cursor += size
            if repeats >= min_repeats:
                return True
    return False


def evaluate_transcript_quality(
    transcript_text: str,
    *,
    transcript_rows: int | None = None,
    enabled: bool = True,
) -> TranscriptQualityVerdict:
    if not enabled:
        normalized = normalize_transcript_text(transcript_text)
        return TranscriptQualityVerdict(
            should_analyze=True,
            skip_reason=None,
            normalized_chars=len(normalized),
            word_count=_word_count(normalized),
        )

    rows = int(transcript_rows or 0)
    normalized = normalize_transcript_text(transcript_text)
    words = _word_count(normalized)
    chars = len(normalized)

    if rows == 0 and not normalized:
        return TranscriptQualityVerdict(
            should_analyze=False,
            skip_reason=SKIP_REASON_NO_MEANINGFUL,
            normalized_chars=chars,
            word_count=words,
        )
    if chars < 80:
        return TranscriptQualityVerdict(
            should_analyze=False,
            skip_reason=SKIP_REASON_SHORT,
            normalized_chars=chars,
            word_count=words,
        )
    if words < 12:
        return TranscriptQualityVerdict(
            should_analyze=False,
            skip_reason=SKIP_REASON_SHORT,
            normalized_chars=chars,
            word_count=words,
        )
    if _filler_ratio(normalized) >= 0.6:
        return TranscriptQualityVerdict(
            should_analyze=False,
            skip_reason=SKIP_REASON_SHORT,
            normalized_chars=chars,
            word_count=words,
        )
    if _has_duplicate_micro_loop(normalized):
        return TranscriptQualityVerdict(
            should_analyze=False,
            skip_reason=SKIP_REASON_SHORT,
            normalized_chars=chars,
            word_count=words,
        )

    return TranscriptQualityVerdict(
        should_analyze=True,
        skip_reason=None,
        normalized_chars=chars,
        word_count=words,
    )
