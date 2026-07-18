"""Evidence pair helpers shared by study synthesis and artifact generation.

Segment IDs are only unique within their own meeting. Evidence pairs must
never be built by zipping parallel ``meetingIds``/``segmentIds`` lists by
index, because a segment that belongs to meeting B could silently attach to
meeting A. Every helper here resolves segment ownership through an explicit
meeting -> allowed segment ids map instead.
"""

from __future__ import annotations

from typing import Any


def estimate_tokens(text: str, *, chars_per_token: int = 4) -> int:
    """Rough token estimate for prompt-sizing decisions (not exact tokenization)."""
    if not text:
        return 0
    chars_per_token = max(1, int(chars_per_token))
    return max(1, (len(text) + chars_per_token - 1) // chars_per_token)


def build_allowed_segments_by_meeting(ready_sources: list[dict]) -> dict[int, set[str]]:
    """Build a meetingId -> allowed segmentIds map from resolved study sources.

    Every ready meeting is included as a key (even with an empty segment set)
    so callers can distinguish "unknown meeting" from "meeting with no
    evidence segments" when validating pairs.
    """
    allowed: dict[int, set[str]] = {}
    for source in ready_sources or []:
        try:
            meeting_id = int(source["meetingId"])
        except (KeyError, TypeError, ValueError):
            continue
        bucket = allowed.setdefault(meeting_id, set())
        bucket.update(str(s) for s in (source.get("allowedSegmentIds") or []))
    return allowed


def _pair_value(pair: Any, key: str) -> Any:
    if isinstance(pair, dict):
        return pair.get(key)
    return getattr(pair, key, None)


def normalize_evidence_pairs(
    *,
    evidence: list[dict] | None = None,
    meeting_ids: list[int] | None = None,
    segment_ids: list[str] | None = None,
    allowed_segments_by_meeting: dict[int, set[str]],
) -> list[dict[str, Any]]:
    """Return deduplicated, allow-listed ``{"meetingId", "segmentId"}`` pairs.

    - If ``evidence`` pairs are provided, only keep pairs where
      ``segmentId`` is in ``allowed_segments_by_meeting[meetingId]``.
    - Otherwise, for each meetingId in ``meeting_ids``, keep only the
      segments from ``segment_ids`` that belong to THAT meeting. This is a
      filtered cross-product, never a positional zip across meetings.
    """
    pairs: list[dict[str, Any]] = []
    seen: set[tuple[int, str]] = set()

    def _add(raw_meeting_id: Any, raw_segment_id: Any) -> None:
        try:
            meeting_id = int(raw_meeting_id)
        except (TypeError, ValueError):
            return
        segment_id = str(raw_segment_id or "").strip()
        if not segment_id:
            return
        if segment_id not in allowed_segments_by_meeting.get(meeting_id, set()):
            return
        key = (meeting_id, segment_id)
        if key in seen:
            return
        seen.add(key)
        pairs.append({"meetingId": meeting_id, "segmentId": segment_id})

    if evidence:
        for item in evidence:
            _add(_pair_value(item, "meetingId"), _pair_value(item, "segmentId"))
        return pairs

    for raw_meeting_id in meeting_ids or []:
        try:
            meeting_id = int(raw_meeting_id)
        except (TypeError, ValueError):
            continue
        allowed = allowed_segments_by_meeting.get(meeting_id)
        if not allowed:
            continue
        for raw_segment_id in segment_ids or []:
            segment_id = str(raw_segment_id or "").strip()
            if segment_id in allowed:
                _add(meeting_id, segment_id)

    return pairs


def pairs_to_meeting_ids(pairs: list[Any]) -> list[int]:
    seen: set[int] = set()
    result: list[int] = []
    for pair in pairs or []:
        try:
            meeting_id = int(_pair_value(pair, "meetingId"))
        except (TypeError, ValueError):
            continue
        if meeting_id in seen:
            continue
        seen.add(meeting_id)
        result.append(meeting_id)
    return result


def pairs_to_segment_ids(pairs: list[Any]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for pair in pairs or []:
        segment_id = str(_pair_value(pair, "segmentId") or "").strip()
        if not segment_id or segment_id in seen:
            continue
        seen.add(segment_id)
        result.append(segment_id)
    return result
