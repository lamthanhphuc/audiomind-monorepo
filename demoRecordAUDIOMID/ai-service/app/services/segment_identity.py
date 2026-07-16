"""Stable segment identity helpers — single backend source of truth."""

from __future__ import annotations

import math
import re
from typing import Any

LEGACY_SEGMENT_ID_PATTERN = re.compile(
    r"^meeting-(?P<meeting>\d+)-(?P<start>\d+(?:\.\d+)?)-(?P<speaker>[a-z0-9_]+)-\d+$",
    re.IGNORECASE,
)


def normalize_speaker_token(speaker: Any) -> str:
    raw = str(speaker or "").strip()
    if not raw:
        return "speaker_unknown"
    return raw.lower().replace(" ", "_")


def _coerce_finite_start(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        numeric = float(value)
        return numeric if math.isfinite(numeric) else None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            numeric = float(stripped)
        except ValueError:
            return None
        return numeric if math.isfinite(numeric) else None
    return None


def _segment_field(segment: dict[str, Any] | None, *keys: str) -> Any:
    if not segment:
        return None
    for key in keys:
        if key in segment and segment.get(key) is not None:
            return segment.get(key)
    return None


def build_stable_segment_id(
    meeting_id: int | str,
    segment: dict[str, Any] | None = None,
    *,
    speaker: Any = None,
    start_time: Any = None,
    zero_based_index: int = 0,
    collision_index: int = 1,
) -> str:
    meeting_part = f"meeting-{int(meeting_id)}"
    speaker_token = normalize_speaker_token(
        speaker if speaker is not None else _segment_field(segment, "speaker")
    )
    start = _coerce_finite_start(start_time)
    if start is None:
        start = _coerce_finite_start(
            _segment_field(segment, "start_time", "startTime", "start")
        )

    if start is not None:
        base = f"{meeting_part}-start-{start:.3f}-{speaker_token}"
    else:
        base = f"{meeting_part}-index-{int(zero_based_index)}-{speaker_token}"

    if collision_index > 1:
        base = f"{base}-seq-{int(collision_index)}"
    return base


def canonicalize_segment_id(segment_id: str) -> str:
    raw = str(segment_id or "").strip()
    if not raw:
        return raw
    match = LEGACY_SEGMENT_ID_PATTERN.match(raw)
    if match:
        return (
            f"meeting-{match.group('meeting')}-start-"
            f"{float(match.group('start')):.3f}-{match.group('speaker').lower()}"
        )
    return raw


def assign_stable_segment_ids(
    meeting_id: int | str, segments: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    enriched: list[dict[str, Any]] = []
    collision_counts: dict[str, int] = {}

    for index, segment in enumerate(segments):
        copy = dict(segment)
        base_key = build_stable_segment_id(
            meeting_id,
            copy,
            zero_based_index=index,
            collision_index=1,
        )
        collision_counts[base_key] = collision_counts.get(base_key, 0) + 1
        collision_index = collision_counts[base_key]
        stable_id = build_stable_segment_id(
            meeting_id,
            copy,
            zero_based_index=index,
            collision_index=collision_index,
        )
        copy["segment_id"] = stable_id
        copy["event_id"] = stable_id
        enriched.append(copy)
    return enriched


def format_segment_marker(segment_id: str) -> str:
    return f"[SEGMENT_ID={segment_id}]"


def collect_allowed_segment_ids(segments: list[dict[str, Any]]) -> set[str]:
    allowed: set[str] = set()
    for segment in segments:
        for key in ("segment_id", "segmentId", "event_id", "eventId"):
            value = str(segment.get(key) or "").strip()
            if value:
                allowed.add(value)
    return allowed


def format_aligned_transcript_for_analysis(segments: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for segment in segments:
        segment_id = str(
            segment.get("segment_id") or segment.get("segmentId") or ""
        ).strip()
        if segment_id:
            lines.append(format_segment_marker(segment_id))
        speaker = str(segment.get("speaker") or "UNKNOWN")
        text = str(segment.get("text") or "")
        start = _coerce_finite_start(
            _segment_field(segment, "start", "start_time", "startTime")
        )
        start_value = start if start is not None else 0.0
        time_str = f"[{int(start_value // 60):02d}:{int(start_value % 60):02d}]"
        lines.append(f"{time_str} {speaker}: {text}")
    return "\n".join(lines)


def resolve_segment_id_for_read(
    *,
    meeting_id: int,
    speaker: str,
    start_time: float,
    explicit_segment_id: Any,
) -> str:
    explicit = str(explicit_segment_id or "").strip()
    if explicit:
        return canonicalize_segment_id(explicit)
    return build_stable_segment_id(
        meeting_id,
        speaker=speaker,
        start_time=start_time,
    )
