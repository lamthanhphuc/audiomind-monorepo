from __future__ import annotations

import pytest

from app.services.segment_identity import (
    assign_stable_segment_ids,
    build_stable_segment_id,
    canonicalize_segment_id,
    collect_allowed_segment_ids,
    format_aligned_transcript_for_analysis,
    format_segment_marker,
)


@pytest.mark.parametrize(
    ("meeting_id", "speaker", "start", "index", "collision", "expected"),
    [
        (12, "SPEAKER_1", 10.0, 0, 1, "meeting-12-start-10.000-speaker_1"),
        (12, "Speaker_1", 10.1234567, 0, 1, "meeting-12-start-10.123-speaker_1"),
        (7, None, 5.0, 0, 1, "meeting-7-start-5.000-speaker_unknown"),
        (3, "SPEAKER_1", None, 0, 1, "meeting-3-index-0-speaker_1"),
        (3, "SPEAKER_1", 10.0, 0, 2, "meeting-3-start-10.000-speaker_1-seq-2"),
    ],
)
def test_build_stable_segment_id_vectors(
    meeting_id, speaker, start, index, collision, expected
):
    assert (
        build_stable_segment_id(
            meeting_id,
            speaker=speaker,
            start_time=start,
            zero_based_index=index,
            collision_index=collision,
        )
        == expected
    )


def test_assign_stable_segment_ids_handles_collisions():
    segments = [
        {"speaker": "SPEAKER_1", "start_time": 1.0, "text": "one"},
        {"speaker": "SPEAKER_1", "start_time": 1.0, "text": "two"},
    ]
    enriched = assign_stable_segment_ids(42, segments)
    assert enriched[0]["segment_id"] == "meeting-42-start-1.000-speaker_1"
    assert enriched[1]["segment_id"] == "meeting-42-start-1.000-speaker_1-seq-2"
    assert enriched[0]["event_id"] == enriched[0]["segment_id"]
    assert collect_allowed_segment_ids(enriched) == {
        enriched[0]["segment_id"],
        enriched[1]["segment_id"],
    }


def test_canonicalize_segment_id_rewrites_legacy_format():
    assert (
        canonicalize_segment_id("meeting-55-1.250-speaker_1-1")
        == "meeting-55-start-1.250-speaker_1"
    )


def test_format_aligned_transcript_for_analysis_includes_markers():
    transcript = format_aligned_transcript_for_analysis(
        [
            {
                "segment_id": "meeting-12-start-10.000-speaker_1",
                "speaker": "SPEAKER_1",
                "start": 10.0,
                "text": "Hello",
            }
        ]
    )
    assert (
        format_segment_marker("meeting-12-start-10.000-speaker_1") in transcript
    )
    assert "[00:10] SPEAKER_1: Hello" in transcript
