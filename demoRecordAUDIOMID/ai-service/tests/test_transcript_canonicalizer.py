from __future__ import annotations

import copy
from datetime import datetime, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import Base, Transcript
from app.scripts import backfill_canonical as backfill_module
from app.services.stt_persistence import (
    TranscriptFragmentInput,
    TranscriptPersistenceRepository,
)
from app.services import transcript_canonicalizer as canonicalizer


def _make_session_factory():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_local = sessionmaker(bind=engine)
    return session_local, engine


def _seed_visible_fragments(session, meeting_id: int) -> None:
    repo = TranscriptPersistenceRepository(session)
    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=meeting_id,
            seq=1,
            text="We should finalize the launch plan.",
            speaker="SPEAKER_1",
            start_time=1.0,
            end_time=3.0,
            event_id=f"meeting-{meeting_id}-start-1.000",
            is_final=True,
            confidence=0.95,
        )
    )
    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=meeting_id,
            seq=2,
            text="Launch plan",
            speaker="SPEAKER_2",
            start_time=1.2,
            end_time=2.8,
            event_id=f"meeting-{meeting_id}-start-1.200",
            is_final=True,
            confidence=0.88,
        )
    )
    session.commit()


def _seed_adjacent_visible_fragments(session, meeting_id: int) -> None:
    repo = TranscriptPersistenceRepository(session)
    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=meeting_id,
            seq=1,
            text="Vocabulary",
            speaker="SPEAKER_1",
            start_time=1.0,
            end_time=1.5,
            event_id=f"meeting-{meeting_id}-start-1.000",
            is_final=True,
            confidence=0.95,
        )
    )
    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=meeting_id,
            seq=2,
            text="is a nightmare.",
            speaker="SPEAKER_2",
            start_time=1.8,
            end_time=2.5,
            event_id=f"meeting-{meeting_id}-start-1.800",
            is_final=True,
            confidence=0.95,
        )
    )
    session.commit()


def _adjacent_pair(left: str, right: str, *, right_speaker: str = "SPEAKER_1"):
    return [
        {
            "speaker": "SPEAKER_1",
            "start_time": 10.0,
            "end_time": 10.5,
            "text": left,
        },
        {
            "speaker": right_speaker,
            "start_time": 11.0,
            "end_time": 12.0,
            "text": right,
        },
    ]


def _smoke_like_adjacent_segments():
    return [
        {
            "speaker": "SPEAKER_1",
            "start_time": 1.0,
            "end_time": 1.5,
            "text": "Vocabulary",
        },
        {
            "speaker": "SPEAKER_2",
            "start_time": 1.8,
            "end_time": 2.5,
            "text": "is a nightmare.",
        },
        {
            "speaker": "SPEAKER_1",
            "start_time": 4.0,
            "end_time": 4.4,
            "text": "Tomorrow",
        },
        {
            "speaker": "SPEAKER_1",
            "start_time": 4.8,
            "end_time": 5.8,
            "text": "never comes, Tom.",
        },
        {
            "speaker": "SPEAKER_1",
            "start_time": 8.0,
            "end_time": 8.4,
            "text": "Great",
        },
        {
            "speaker": "SPEAKER_1",
            "start_time": 8.9,
            "end_time": 10.2,
            "text": "dream. Let's not give up then.",
        },
        {
            "speaker": "SPEAKER_1",
            "start_time": 14.0,
            "end_time": 15.0,
            "text": "Independent sentence.",
        },
    ]


def test_canonicalizer_merges_vocabulary_fragment():
    result = canonicalizer.canonicalize_segments(
        _adjacent_pair("Vocabulary", "is a nightmare.")
    )

    assert [row["text"] for row in result.rows] == ["Vocabulary is a nightmare."]
    assert result.rows[0]["start_time"] == 10.0
    assert result.rows[0]["end_time"] == 12.0
    assert result.stats["merged_adjacent"] == 1


def test_canonicalizer_merges_tomorrow_fragment_with_speaker_instability():
    result = canonicalizer.canonicalize_segments(
        _adjacent_pair("Tomorrow", "never comes, Tom.", right_speaker="SPEAKER_2")
    )

    assert [row["text"] for row in result.rows] == ["Tomorrow never comes, Tom."]
    assert result.rows[0]["speaker"] == "SPEAKER_1"
    assert result.stats["merged_adjacent"] == 1


def test_canonicalizer_merges_great_dream_fragment():
    result = canonicalizer.canonicalize_segments(
        _adjacent_pair("Great", "dream. Let's not give up then.")
    )

    assert [row["text"] for row in result.rows] == [
        "Great dream. Let's not give up then."
    ]
    assert result.stats["merged_adjacent"] == 1


def test_canonicalizer_smoke_like_sample_has_fewer_rows_than_raw():
    raw_segments = _smoke_like_adjacent_segments()

    result = canonicalizer.canonicalize_segments(raw_segments)

    assert len(result.rows) < len(raw_segments)
    assert [row["text"] for row in result.rows] == [
        "Vocabulary is a nightmare.",
        "Tomorrow never comes, Tom.",
        "Great dream. Let's not give up then.",
        "Independent sentence.",
    ]


def test_canonicalizer_is_deterministic_and_keeps_input_unchanged():
    segments = [
        {"speaker": "alice", "start_time": 0.0, "end_time": 1.0, "text": "Hello world"},
        {"speaker": "alice", "start_time": 0.5, "end_time": 1.5, "text": "hello world"},
        {"speaker": "bob", "start_time": 2.0, "end_time": 3.0, "text": "  "},
        {
            "speaker": "alice",
            "start_time": 3.0,
            "end_time": 4.0,
            "text": "This is a test",
        },
        {"speaker": "alice", "start_time": 3.2, "end_time": 3.8, "text": "a test"},
    ]
    snapshot = copy.deepcopy(segments)

    first = canonicalizer.canonicalize_segments(segments)
    second = canonicalizer.canonicalize_segments(segments)

    assert segments == snapshot
    assert first.version == canonicalizer.CANONICAL_VERSION
    assert first.rows == second.rows
    assert first.raw_hash == second.raw_hash
    assert first.canonical_hash == second.canonical_hash
    assert first.stats["input_rows"] == 5
    assert first.stats["output_rows"] == 2
    assert first.stats["dropped_duplicates"] >= 1
    assert first.stats["dropped_contained"] >= 1


def test_hash_changes_when_raw_or_version_changes():
    first = canonicalizer.canonicalize_segments(
        [
            {
                "speaker": "speaker_1",
                "start_time": 0.0,
                "end_time": 1.0,
                "text": "first row",
            }
        ]
    )
    second = canonicalizer.canonicalize_segments(
        [
            {
                "speaker": "speaker_1",
                "start_time": 0.0,
                "end_time": 1.0,
                "text": "second row",
            }
        ]
    )
    canonical_hash_v1 = canonicalizer.build_canonical_transcript_hash(
        first.rows, version="canonical-transcript-v1"
    )

    assert first.raw_hash != second.raw_hash
    assert first.canonical_hash != second.canonical_hash
    assert canonical_hash_v1 != first.canonical_hash


def test_backfill_writes_canonical_sidecar_without_mutating_raw_rows(monkeypatch):
    session_local, engine = _make_session_factory()
    session = session_local()
    try:
        meeting_id = 4201
        session.add(
            Transcript(
                meeting_id=meeting_id,
                speaker="SPEAKER_1",
                start_time=1.0,
                end_time=3.0,
                text="We should finalize the launch plan.",
            )
        )
        session.add(
            Transcript(
                meeting_id=meeting_id,
                speaker="SPEAKER_2",
                start_time=1.2,
                end_time=2.8,
                text="Launch plan",
            )
        )
        session.commit()
        _seed_visible_fragments(session, meeting_id)
        session.close()

        monkeypatch.setattr(backfill_module, "SessionLocal", session_local)
        outcome = backfill_module.backfill(
            meeting_id,
            generated_at=datetime(2026, 6, 1, 1, 2, 3, tzinfo=timezone.utc),
        )

        assert outcome.status == "updated"
        assert outcome.row_count >= 1

        verify_session = session_local()
        rows = (
            verify_session.query(Transcript)
            .filter(Transcript.meeting_id == meeting_id)
            .order_by(Transcript.id.asc())
            .all()
        )
        assert len(rows) == 2
        assert rows[0].canonical_transcript_rows
        assert rows[0].canonical_transcript_version == canonicalizer.CANONICAL_VERSION
        assert rows[0].canonical_transcript_hash
        assert rows[0].raw_transcript_hash
        # Raw transcript fields remain untouched.
        assert rows[0].text == "We should finalize the launch plan."
        assert rows[1].text == "Launch plan"
    finally:
        try:
            verify_session.close()
        except Exception:
            pass
        try:
            session.close()
        except Exception:
            pass
        engine.dispose()


def test_backfill_is_idempotent_by_meeting_raw_hash_and_version(monkeypatch):
    session_local, engine = _make_session_factory()
    session = session_local()
    try:
        meeting_id = 4202
        session.add(
            Transcript(
                meeting_id=meeting_id,
                speaker="SPEAKER_1",
                start_time=1.0,
                end_time=3.0,
                text="We should finalize the launch plan.",
            )
        )
        session.commit()
        _seed_visible_fragments(session, meeting_id)
        session.close()

        monkeypatch.setattr(backfill_module, "SessionLocal", session_local)

        first = backfill_module.backfill(
            meeting_id,
            generated_at=datetime(2026, 6, 1, 8, 0, 0, tzinfo=timezone.utc),
        )
        second = backfill_module.backfill(
            meeting_id,
            generated_at=datetime(2026, 6, 1, 9, 0, 0, tzinfo=timezone.utc),
        )

        assert first.status == "updated"
        assert second.status == "noop_idempotent"

        verify_session = session_local()
        row = (
            verify_session.query(Transcript)
            .filter(Transcript.meeting_id == meeting_id)
            .order_by(Transcript.id.asc())
            .first()
        )
        assert row is not None
        assert row.canonical_generated_at == datetime(2026, 6, 1, 8, 0, 0)
    finally:
        try:
            verify_session.close()
        except Exception:
            pass
        try:
            session.close()
        except Exception:
            pass
        engine.dispose()


def test_backfill_rebuilds_when_canonical_version_changes(monkeypatch):
    session_local, engine = _make_session_factory()
    session = session_local()
    try:
        meeting_id = 4205
        raw_rows = [
            {
                "speaker": "SPEAKER_1",
                "start_time": 1.0,
                "end_time": 1.5,
                "text": "Vocabulary",
            },
            {
                "speaker": "SPEAKER_2",
                "start_time": 1.8,
                "end_time": 2.5,
                "text": "is a nightmare.",
            },
        ]
        session.add(
            Transcript(
                meeting_id=meeting_id,
                speaker="SPEAKER_1",
                start_time=1.0,
                end_time=1.5,
                text="Vocabulary",
                raw_transcript_hash=canonicalizer.build_raw_transcript_hash(raw_rows),
                canonical_transcript_rows=raw_rows,
                canonical_transcript_version="canonical-transcript-v1",
                canonical_transcript_hash=canonicalizer.build_canonical_transcript_hash(
                    raw_rows, version="canonical-transcript-v1"
                ),
                canonical_generated_at=datetime(
                    2026, 6, 1, 6, 0, 0, tzinfo=timezone.utc
                ),
            )
        )
        session.commit()
        _seed_adjacent_visible_fragments(session, meeting_id)
        session.close()

        monkeypatch.setattr(backfill_module, "SessionLocal", session_local)
        result = backfill_module.backfill(
            meeting_id,
            generated_at=datetime(2026, 6, 1, 7, 0, 0, tzinfo=timezone.utc),
        )

        assert result.status == "updated"
        assert result.canonical_version == canonicalizer.CANONICAL_VERSION

        verify_session = session_local()
        row = (
            verify_session.query(Transcript)
            .filter(Transcript.meeting_id == meeting_id)
            .order_by(Transcript.id.asc())
            .first()
        )
        assert row is not None
        assert row.canonical_transcript_version == canonicalizer.CANONICAL_VERSION
        assert row.canonical_transcript_rows == [
            {
                "speaker": "SPEAKER_1",
                "start_time": 1.0,
                "end_time": 2.5,
                "text": "Vocabulary is a nightmare.",
            }
        ]
        assert row.canonical_generated_at == datetime(2026, 6, 1, 7, 0, 0)
    finally:
        try:
            verify_session.close()
        except Exception:
            pass
        try:
            session.close()
        except Exception:
            pass
        engine.dispose()


def test_backfill_rebuilds_when_canonical_rows_are_missing(monkeypatch):
    session_local, engine = _make_session_factory()
    session = session_local()
    try:
        meeting_id = 4206
        _seed_adjacent_visible_fragments(session, meeting_id)
        expected = canonicalizer.canonicalize_segments(
            [
                {
                    "speaker": "SPEAKER_1",
                    "start_time": 1.0,
                    "end_time": 1.5,
                    "text": "Vocabulary",
                },
                {
                    "speaker": "SPEAKER_2",
                    "start_time": 1.8,
                    "end_time": 2.5,
                    "text": "is a nightmare.",
                },
            ]
        )
        session.add(
            Transcript(
                meeting_id=meeting_id,
                speaker="SPEAKER_1",
                start_time=1.0,
                end_time=1.5,
                text="Vocabulary",
                raw_transcript_hash=expected.raw_hash,
                canonical_transcript_rows=None,
                canonical_transcript_version=expected.version,
                canonical_transcript_hash=expected.canonical_hash,
            )
        )
        session.commit()
        session.close()

        monkeypatch.setattr(backfill_module, "SessionLocal", session_local)
        result = backfill_module.backfill(meeting_id)

        assert result.status == "updated"
        verify_session = session_local()
        row = (
            verify_session.query(Transcript)
            .filter(Transcript.meeting_id == meeting_id)
            .order_by(Transcript.id.asc())
            .first()
        )
        assert row.canonical_transcript_rows == expected.rows
    finally:
        try:
            verify_session.close()
        except Exception:
            pass
        try:
            session.close()
        except Exception:
            pass
        engine.dispose()


def test_backfill_rebuilds_when_canonical_hash_mismatches(monkeypatch):
    session_local, engine = _make_session_factory()
    session = session_local()
    try:
        meeting_id = 4207
        _seed_adjacent_visible_fragments(session, meeting_id)
        expected = canonicalizer.canonicalize_segments(
            [
                {
                    "speaker": "SPEAKER_1",
                    "start_time": 1.0,
                    "end_time": 1.5,
                    "text": "Vocabulary",
                },
                {
                    "speaker": "SPEAKER_2",
                    "start_time": 1.8,
                    "end_time": 2.5,
                    "text": "is a nightmare.",
                },
            ]
        )
        session.add(
            Transcript(
                meeting_id=meeting_id,
                speaker="SPEAKER_1",
                start_time=1.0,
                end_time=1.5,
                text="Vocabulary",
                raw_transcript_hash=expected.raw_hash,
                canonical_transcript_rows=expected.rows,
                canonical_transcript_version=expected.version,
                canonical_transcript_hash="wrong-hash",
            )
        )
        session.commit()
        session.close()

        monkeypatch.setattr(backfill_module, "SessionLocal", session_local)
        result = backfill_module.backfill(meeting_id)

        assert result.status == "updated"
        assert result.canonical_hash == expected.canonical_hash
        verify_session = session_local()
        row = (
            verify_session.query(Transcript)
            .filter(Transcript.meeting_id == meeting_id)
            .order_by(Transcript.id.asc())
            .first()
        )
        assert row.canonical_transcript_hash == expected.canonical_hash
    finally:
        try:
            verify_session.close()
        except Exception:
            pass
        try:
            session.close()
        except Exception:
            pass
        engine.dispose()


def test_backfill_does_not_overwrite_newer_canonical_version(monkeypatch):
    session_local, engine = _make_session_factory()
    session = session_local()
    try:
        meeting_id = 4203
        session.add(
            Transcript(
                meeting_id=meeting_id,
                speaker="SPEAKER_1",
                start_time=1.0,
                end_time=3.0,
                text="We should finalize the launch plan.",
                canonical_transcript_rows=[
                    {
                        "speaker": "SPEAKER_1",
                        "start_time": 1.0,
                        "end_time": 3.0,
                        "text": "already canonical",
                    }
                ],
                canonical_transcript_version="canonical-transcript-v3",
                canonical_transcript_hash="newerhash",
                raw_transcript_hash="newerrawhash",
                canonical_generated_at=datetime(
                    2026, 6, 1, 6, 0, 0, tzinfo=timezone.utc
                ),
            )
        )
        session.commit()
        _seed_visible_fragments(session, meeting_id)
        session.close()

        monkeypatch.setattr(backfill_module, "SessionLocal", session_local)
        result = backfill_module.backfill(
            meeting_id,
            generated_at=datetime(2026, 6, 1, 7, 0, 0, tzinfo=timezone.utc),
        )

        assert result.status == "skipped_existing_newer"

        verify_session = session_local()
        row = (
            verify_session.query(Transcript)
            .filter(Transcript.meeting_id == meeting_id)
            .order_by(Transcript.id.asc())
            .first()
        )
        assert row is not None
        assert row.canonical_transcript_version == "canonical-transcript-v3"
        assert row.canonical_transcript_hash == "newerhash"
        assert row.raw_transcript_hash == "newerrawhash"
        assert row.canonical_generated_at == datetime(2026, 6, 1, 6, 0, 0)
    finally:
        try:
            verify_session.close()
        except Exception:
            pass
        try:
            session.close()
        except Exception:
            pass
        engine.dispose()


def test_backfill_uses_persisted_segments_without_external_processing(monkeypatch):
    session_local, engine = _make_session_factory()
    session = session_local()
    captured = {"repo_calls": 0, "segments": None}

    class FakeRepo:
        def __init__(self, _db):
            pass

        def assemble_visible_transcript_segments(self, meeting_id):
            captured["repo_calls"] += 1
            assert meeting_id == 4204
            return [
                {
                    "speaker": "SPEAKER_1",
                    "start_time": 1.0,
                    "end_time": 2.0,
                    "text": "segment from storage",
                }
            ]

    def fake_canonicalize(segments):
        captured["segments"] = segments
        return canonicalizer.CanonicalResult(
            version=canonicalizer.CANONICAL_VERSION,
            rows=segments,
            canonical_hash="c" * 64,
            raw_hash="r" * 64,
            stats={
                "input_rows": 1,
                "output_rows": 1,
                "dropped_duplicates": 0,
                "dropped_contained": 0,
            },
        )

    try:
        session.add(
            Transcript(
                meeting_id=4204,
                speaker="SPEAKER_1",
                start_time=1.0,
                end_time=2.0,
                text="raw row",
            )
        )
        session.commit()
        session.close()

        monkeypatch.setattr(backfill_module, "SessionLocal", session_local)
        monkeypatch.setattr(
            backfill_module, "TranscriptPersistenceRepository", FakeRepo
        )
        monkeypatch.setattr(backfill_module, "canonicalize_segments", fake_canonicalize)

        result = backfill_module.backfill(4204)

        assert result.status == "updated"
        assert captured["repo_calls"] == 1
        assert captured["segments"] == [
            {
                "speaker": "SPEAKER_1",
                "start_time": 1.0,
                "end_time": 2.0,
                "text": "segment from storage",
            }
        ]
    finally:
        try:
            session.close()
        except Exception:
            pass
        engine.dispose()
