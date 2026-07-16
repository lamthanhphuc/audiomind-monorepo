"""Tests for education realtime fragment scoping and stable segment ID resolution."""

from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import (
    _load_structured_fragments_for_education,
    _resolve_education_realtime_transcript_input,
)
from app.models import Base
from app.services.segment_identity import build_stable_segment_id
from app.services.stt_persistence import (
    TranscriptFragmentInput,
    TranscriptPersistenceRepository,
)


def _session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    return SessionLocal(), engine


def test_education_realtime_v2_only_uses_matching_session_attempt_fragments():
    db, engine = _session()
    repo = TranscriptPersistenceRepository(db)
    meeting_id = 801

    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=meeting_id,
            seq=1,
            text="Wrong attempt content",
            speaker="SPEAKER_1",
            start_time=1.0,
            end_time=2.0,
            event_id="evt-other-attempt",
            is_final=True,
            recording_session_id=10,
            attempt_id=1,
        )
    )
    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=meeting_id,
            seq=1,
            text="Current attempt content",
            speaker="SPEAKER_1",
            start_time=3.0,
            end_time=4.0,
            event_id="evt-current-attempt",
            is_final=True,
            recording_session_id=10,
            attempt_id=2,
        )
    )
    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=meeting_id,
            seq=1,
            text="Legacy null-scope content",
            speaker="SPEAKER_1",
            start_time=5.0,
            end_time=6.0,
            event_id="evt-legacy",
            is_final=True,
        )
    )
    db.commit()

    segments = _load_structured_fragments_for_education(
        db,
        meeting_id,
        recording_session_id=10,
        attempt_id=2,
    )
    texts = [segment["text"] for segment in segments]
    assert texts == ["Current attempt content"]
    assert segments[0]["segment_id"] == "evt-current-attempt"
    assert segments[0]["event_id"] == "evt-current-attempt"

    formatted, allowed, unavailable = _resolve_education_realtime_transcript_input(
        db=db,
        meeting_id=meeting_id,
        plain_transcript="fallback plain",
        recording_session_id=10,
        attempt_id=2,
    )
    assert unavailable is False
    assert allowed == ["evt-current-attempt"]
    assert "SEGMENT_ID=evt-current-attempt" in formatted
    assert "Wrong attempt" not in formatted
    assert "Legacy null-scope" not in formatted

    db.close()
    engine.dispose()


def test_education_realtime_collapses_multiple_versions_to_one_visible_segment():
    db, engine = _session()
    repo = TranscriptPersistenceRepository(db)
    meeting_id = 802

    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=meeting_id,
            seq=1,
            text="Interim draft",
            speaker="SPEAKER_1",
            start_time=10.0,
            end_time=11.0,
            event_id="evt-same-visible",
            is_final=False,
            recording_session_id=20,
            attempt_id=1,
        )
    )
    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=meeting_id,
            seq=1,
            text="Final visible wording",
            speaker="SPEAKER_1",
            start_time=10.0,
            end_time=12.0,
            event_id="evt-same-visible",
            is_final=True,
            recording_session_id=20,
            attempt_id=1,
        )
    )
    db.commit()

    segments = _load_structured_fragments_for_education(
        db,
        meeting_id,
        recording_session_id=20,
        attempt_id=1,
    )
    assert len(segments) == 1
    assert segments[0]["text"] == "Final visible wording"
    assert segments[0]["segment_id"] == "evt-same-visible"

    formatted, allowed, unavailable = _resolve_education_realtime_transcript_input(
        db=db,
        meeting_id=meeting_id,
        plain_transcript="plain",
        recording_session_id=20,
        attempt_id=1,
    )
    assert unavailable is False
    assert allowed == ["evt-same-visible"]
    assert "Final visible wording" in formatted
    assert "Interim draft" not in formatted

    db.close()
    engine.dispose()


def test_education_realtime_missing_event_id_gets_stable_segment_id():
    db, engine = _session()
    repo = TranscriptPersistenceRepository(db)
    meeting_id = 803
    speaker = "SPEAKER_1"
    start_time = 15.5

    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=meeting_id,
            seq=1,
            text="Structured without event id",
            speaker=speaker,
            start_time=start_time,
            end_time=16.5,
            event_id=None,
            is_final=True,
            recording_session_id=30,
            attempt_id=1,
        )
    )
    db.commit()

    expected_id = build_stable_segment_id(
        meeting_id,
        speaker=speaker,
        start_time=start_time,
    )
    segments = _load_structured_fragments_for_education(
        db,
        meeting_id,
        recording_session_id=30,
        attempt_id=1,
    )
    assert len(segments) == 1
    assert segments[0]["segment_id"] == expected_id
    assert segments[0]["event_id"] == expected_id

    formatted, allowed, unavailable = _resolve_education_realtime_transcript_input(
        db=db,
        meeting_id=meeting_id,
        plain_transcript="plain should not win",
        recording_session_id=30,
        attempt_id=1,
    )
    assert unavailable is False
    assert allowed == [expected_id]
    assert f"SEGMENT_ID={expected_id}" in formatted
    assert "Structured without event id" in formatted

    db.close()
    engine.dispose()
