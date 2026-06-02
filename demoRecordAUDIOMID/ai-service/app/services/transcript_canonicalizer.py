from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from typing import List, Dict, Any
import json
import re


CANONICAL_VERSION = "canonical-transcript-v2"
ADJACENT_MERGE_MAX_GAP_SECONDS = 2.0
ADJACENT_MERGE_MAX_OVERLAP_SECONDS = 0.25
ADJACENT_MERGE_MAX_ROW_WORDS = 18
ADJACENT_MERGE_MAX_COMBINED_WORDS = 24
ADJACENT_MERGE_MAX_COMBINED_CHARS = 180
_TERMINAL_PUNCTUATION = (".", "!", "?", "...")
_TRAILING_QUOTES = "\"')]}"


def _normalize_text(value: str | None) -> str:
    return " ".join(str(value or "").split()).strip().lower()


def _speaker_key(value: str | None) -> str:
    return str(value or "").strip().lower()


def _word_tokens(value: str | None) -> list[str]:
    return re.findall(r"\b\w+(?:'\w+)?\b", str(value or ""), flags=re.UNICODE)


def _word_count(value: str | None) -> int:
    return len(_word_tokens(value))


def _boundary_word(value: str | None, *, last: bool) -> str:
    tokens = _word_tokens(value)
    if not tokens:
        return ""
    return tokens[-1 if last else 0].lower()


def _ends_with_terminal(text: str) -> bool:
    stripped = text.strip().rstrip(_TRAILING_QUOTES)
    return stripped.endswith(_TERMINAL_PUNCTUATION)


def _starts_with_lowercase_word(text: str) -> bool:
    for char in text.strip():
        if char.isalpha():
            return char.islower()
        if char.isdigit():
            return True
        if not char.isspace() and char not in "\"'(":
            return False
    return False


def _merge_text(left: str, right: str) -> str:
    left_text = left.strip()
    right_text = right.strip()
    if not left_text:
        return right_text
    if not right_text:
        return left_text
    if right_text[0] in ",.;:!?)]}":
        return f"{left_text}{right_text}"
    return f"{left_text} {right_text}"


def _has_duplicate_boundary(left: str, right: str) -> bool:
    left_last = _boundary_word(left, last=True)
    right_first = _boundary_word(right, last=False)
    return bool(left_last and right_first and left_last == right_first)


def _adjacent_merge_allowed(
    left: Dict[str, Any],
    right: Dict[str, Any],
) -> bool:
    left_text = str(left.get("text") or "").strip()
    right_text = str(right.get("text") or "").strip()
    if not left_text or not right_text:
        return False
    if _ends_with_terminal(left_text):
        return False

    gap_seconds = float(right.get("start_time") or 0.0) - float(
        left.get("end_time") or 0.0
    )
    if gap_seconds > ADJACENT_MERGE_MAX_GAP_SECONDS:
        return False
    if gap_seconds < -ADJACENT_MERGE_MAX_OVERLAP_SECONDS:
        return False

    left_words = _word_count(left_text)
    right_words = _word_count(right_text)
    if (
        left_words == 0
        or right_words == 0
        or left_words > ADJACENT_MERGE_MAX_ROW_WORDS
        or right_words > ADJACENT_MERGE_MAX_ROW_WORDS
        or left_words + right_words > ADJACENT_MERGE_MAX_COMBINED_WORDS
    ):
        return False

    merged_text = _merge_text(left_text, right_text)
    if len(merged_text) > ADJACENT_MERGE_MAX_COMBINED_CHARS:
        return False
    if _has_duplicate_boundary(left_text, right_text):
        return False
    if not _starts_with_lowercase_word(right_text):
        return False

    same_speaker = _speaker_key(left.get("speaker")) == _speaker_key(
        right.get("speaker")
    )
    if not same_speaker and min(left_words, right_words) > 3:
        return False

    return right_words >= 2 or _ends_with_terminal(right_text)


@dataclass
class CanonicalResult:
    version: str
    rows: List[Dict[str, Any]]
    canonical_hash: str
    raw_hash: str
    stats: Dict[str, int]


def _sha256_hex(value: str) -> str:
    return sha256(value.encode("utf-8")).hexdigest()


def build_raw_transcript_hash(segments: List[Dict[str, Any]]) -> str:
    normalized = []
    for segment in segments:
        normalized.append(
            {
                "speaker": segment.get("speaker", "system"),
                "start_time": float(segment.get("start_time") or 0.0),
                "end_time": float(segment.get("end_time") or 0.0),
                "text": str(segment.get("text") or "").strip(),
            }
        )

    sorted_rows = sorted(
        normalized, key=lambda row: (row["start_time"], row["end_time"], row["text"])
    )
    raw_serial = json.dumps(
        sorted_rows,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return _sha256_hex(raw_serial)


def build_canonical_transcript_hash(
    rows: List[Dict[str, Any]],
    *,
    version: str = CANONICAL_VERSION,
) -> str:
    canon_serial = json.dumps(
        rows,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return _sha256_hex(canon_serial + str(version or ""))


def canonicalize_segments(segments: List[Dict[str, Any]]) -> CanonicalResult:
    """
    Deterministic canonicalizer for transcript segments.

    Rules (conservative):
    - Normalize text (collapse whitespace, lowercase).
    - Drop empty segments.
    - Remove exact consecutive duplicate normalized texts.
    - Drop segments fully contained inside a larger segment with similar text.
    - Merge short adjacent continuation fragments when deterministic sentence
      shape checks say row A + row B is one phrase.

    Returns a CanonicalResult containing rows, version, hashes and stats.
    """
    input_copy = []
    for s in segments:
        input_copy.append(
            {
                "speaker": s.get("speaker", "system"),
                "start_time": float(s.get("start_time") or 0.0),
                "end_time": float(s.get("end_time") or 0.0),
                "text": str(s.get("text") or "").strip(),
            }
        )

    # Raw hash is deterministic over input segments sorted by start/end/text.
    raw_hash = build_raw_transcript_hash(input_copy)
    sorted_input = sorted(
        input_copy, key=lambda row: (row["start_time"], row["end_time"], row["text"])
    )

    stats = {
        "input_rows": len(sorted_input),
        "output_rows": 0,
        "dropped_duplicates": 0,
        "dropped_contained": 0,
        "merged_adjacent": 0,
    }

    rows: List[Dict[str, Any]] = []
    last_norm: str | None = None
    for seg in sorted_input:
        norm = _normalize_text(seg["text"])
        if not norm:
            stats["dropped_duplicates"] += 1
            continue

        # drop exact consecutive duplicates
        if last_norm is not None and norm == last_norm:
            stats["dropped_duplicates"] += 1
            continue

        # conservative containment check against last row
        if rows:
            last = rows[-1]
            # if segment is within last's time range and its text is substring of last's text, drop it
            if (
                seg["start_time"] >= last["start_time"]
                and seg["end_time"] <= last["end_time"]
                and norm in _normalize_text(last["text"])
            ):
                stats["dropped_contained"] += 1
                last_norm = norm
                continue

        row = {
            "speaker": seg["speaker"],
            "start_time": seg["start_time"],
            "end_time": seg["end_time"],
            "text": seg["text"],
        }
        if rows and _adjacent_merge_allowed(rows[-1], row):
            rows[-1] = {
                "speaker": rows[-1]["speaker"],
                "start_time": rows[-1]["start_time"],
                "end_time": row["end_time"],
                "text": _merge_text(rows[-1]["text"], row["text"]),
            }
            stats["merged_adjacent"] += 1
            last_norm = _normalize_text(rows[-1]["text"])
            continue

        rows.append(row)
        last_norm = norm

    stats["output_rows"] = len(rows)

    canonical_hash = build_canonical_transcript_hash(rows, version=CANONICAL_VERSION)

    return CanonicalResult(
        version=CANONICAL_VERSION,
        rows=rows,
        canonical_hash=canonical_hash,
        raw_hash=raw_hash,
        stats=stats,
    )
