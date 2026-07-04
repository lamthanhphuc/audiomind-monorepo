from sqlalchemy import BigInteger, create_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import sessionmaker

import pytest

from app.models import Base, TranscriptAttemptCheckpoint, TranscriptFragment
from fastapi import Form, Query

from app.services.stt_persistence import (
    TranscriptFragmentInput,
    TranscriptPersistenceRepository,
    build_fragment_dedupe_key,
    validate_transcript_provenance,
)


def _make_repo(*, autoflush: bool = True):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=autoflush)
    return SessionLocal(), engine


def _make_repo_legacy():
    return _make_repo(autoflush=True)


def _index_columns(table, index_name: str) -> list[str]:
    for index in table.indexes:
        if index.name == index_name:
            return [column.name for column in index.columns]
    raise AssertionError(f"Missing index {index_name}")


def test_runtime_models_match_revision_010_provenance_metadata():
    attempt_checkpoint_pk = [
        column.name
        for column in TranscriptAttemptCheckpoint.__table__.primary_key.columns
    ]
    assert attempt_checkpoint_pk == [
        "meeting_id",
        "recording_session_id",
        "attempt_id",
        "stream_id",
    ]

    assert _index_columns(
        TranscriptAttemptCheckpoint.__table__,
        "ix_transcript_attempt_checkpoints_meeting_session_stream",
    ) == ["meeting_id", "recording_session_id", "stream_id"]

    assert _index_columns(
        TranscriptFragment.__table__,
        "ix_transcript_fragments_v2_event_identity",
    ) == [
        "meeting_id",
        "recording_session_id",
        "attempt_id",
        "stream_id",
        "seq",
    ]

    for column_name in ("recording_session_id", "attempt_id"):
        column = TranscriptFragment.__table__.c[column_name]
        assert column.nullable is True
        assert isinstance(column.type, BigInteger)

        individual_indexes = [
            index.name
            for index in TranscriptFragment.__table__.indexes
            if [indexed_column.name for indexed_column in index.columns]
            == [column_name]
        ]
        assert individual_indexes == []


def test_append_fragment_is_deduplicated_and_versioned():
    db, engine = _make_repo()
    repo = TranscriptPersistenceRepository(db)

    first = repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=101,
            seq=1,
            text="Xin chao audiomind",
            speaker="system",
            start_time=0.1,
            end_time=0.2,
            event_id="evt-1",
            is_final=False,
            confidence=0.9,
        )
    )
    second = repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=101,
            seq=1,
            text="Xin chao audiomind",
            speaker="system",
            start_time=0.1,
            end_time=0.2,
            event_id="evt-1",
            is_final=False,
            confidence=0.9,
        )
    )
    correction = repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=101,
            seq=1,
            text="Xin chao AudioMind",
            speaker="system",
            start_time=0.1,
            end_time=0.2,
            event_id="evt-2",
            is_final=True,
            confidence=0.97,
        )
    )

    db.commit()

    assert first.id == second.id
    assert correction.version == 2
    assert len(repo.list_fragments(101)) == 2
    assert repo.assemble_transcript_text(101) == "Xin chao audiomind Xin chao AudioMind"
    db.close()
    engine.dispose()


def test_append_fragment_prefers_final_when_same_dedupe_key_in_same_batch():
    db, engine = _make_repo_legacy()
    repo = TranscriptPersistenceRepository(db)

    interim = repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=111,
            seq=15,
            text="Xin chao",
            speaker="system",
            start_time=12.85,
            end_time=15.06,
            event_id="meeting-111-start-12.850",
            is_final=False,
            confidence=0.82,
        )
    )
    final = repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=111,
            seq=15,
            text="Xin chao",
            speaker="system",
            start_time=12.85,
            end_time=15.06,
            event_id="meeting-111-start-12.850",
            is_final=True,
            confidence=0.95,
        )
    )

    db.commit()

    assert interim.id == final.id
    assert final.is_final is True
    assert len(repo.list_fragments(111)) == 1
    db.close()
    engine.dispose()


def test_duplicate_dedupe_key_already_in_db_is_idempotent():
    db, engine = _make_repo()
    repo = TranscriptPersistenceRepository(db)

    first = repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=112,
            seq=22,
            text="Dao this in DB",
            speaker="system",
            start_time=25.0,
            end_time=27.0,
            event_id="meeting-112-start-25.000",
            is_final=True,
            confidence=0.91,
        )
    )
    db.commit()

    db2 = engine.connect()
    SessionLocal = sessionmaker(bind=db2)
    second_session = SessionLocal()
    try:
        repo2 = TranscriptPersistenceRepository(second_session)
        duplicate = repo2.append_fragment(
            TranscriptFragmentInput(
                meeting_id=112,
                seq=22,
                text="Dao this in DB",
                speaker="system",
                start_time=25.0,
                end_time=27.0,
                event_id="meeting-112-start-25.000",
                is_final=True,
                confidence=0.91,
            )
        )
        second_session.commit()
        assert duplicate.id == first.id
        assert len(repo2.list_fragments(112)) == 1
    finally:
        second_session.close()
        db2.close()
        db.close()
        engine.dispose()


def test_append_fragment_prefers_final_with_autoflush_disabled_session():
    db, engine = _make_repo(autoflush=False)
    repo = TranscriptPersistenceRepository(db)

    interim = repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=9,
            seq=6,
            text="AudioMine",
            speaker="speaker_1",
            start_time=6.98,
            end_time=8.5,
            event_id="meeting-9-start-6.980-speaker_1",
            is_final=False,
            confidence=0.82,
        )
    )
    final = repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=9,
            seq=6,
            text="AudioMine",
            speaker="speaker_1",
            start_time=6.98,
            end_time=8.5,
            event_id="meeting-9-start-6.980-speaker_1",
            is_final=True,
            confidence=0.95,
        )
    )

    db.commit()

    assert interim.id == final.id
    assert final.is_final is True
    assert len(repo.list_fragments(9)) == 1
    assert repo.assemble_transcript_text(9) == "AudioMine"
    db.close()
    engine.dispose()


def test_duplicate_identical_fragment_with_autoflush_disabled_is_idempotent():
    db, engine = _make_repo(autoflush=False)
    repo = TranscriptPersistenceRepository(db)

    first = repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=113,
            seq=4,
            text="AudioMine",
            speaker="speaker_1",
            start_time=6.98,
            end_time=8.5,
            event_id="meeting-113-start-6.980-speaker_1",
            is_final=True,
            confidence=0.91,
        )
    )
    duplicate = repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=113,
            seq=4,
            text="AudioMine",
            speaker="speaker_1",
            start_time=6.98,
            end_time=8.5,
            event_id="meeting-113-start-6.980-speaker_1",
            is_final=True,
            confidence=0.91,
        )
    )

    db.commit()

    assert first.id == duplicate.id
    assert len(repo.list_fragments(113)) == 1
    db.close()
    engine.dispose()


def test_checkpoint_upsert_advances_durability_boundary():
    db, engine = _make_repo()
    repo = TranscriptPersistenceRepository(db)

    checkpoint = repo.upsert_checkpoint(
        202, last_ack_seq=2, last_persisted_seq=1, last_finalized_seq=0
    )
    db.commit()
    checkpoint = repo.upsert_checkpoint(
        202, last_ack_seq=3, last_persisted_seq=3, last_finalized_seq=2
    )
    db.commit()

    assert checkpoint.last_ack_seq == 3
    assert checkpoint.last_persisted_seq == 3
    assert checkpoint.last_finalized_seq == 2
    db.close()
    engine.dispose()


def test_visible_transcript_fragments_collapse_interim_updates_and_keep_distinct_utterances():
    db, engine = _make_repo()
    repo = TranscriptPersistenceRepository(db)

    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=303,
            seq=1,
            text="Đáng sợ, mọi con quái bạn đối",
            speaker="Speaker 1",
            start_time=3.0,
            end_time=5.2,
            event_id="meeting-303-start-3.000",
            is_final=False,
            confidence=0.8,
        )
    )
    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=303,
            seq=1,
            text="Đáng sợ, mọi con quái bạn đối mặt",
            speaker="Speaker 1",
            start_time=3.0,
            end_time=5.8,
            event_id="meeting-303-start-3.000",
            is_final=True,
            confidence=0.95,
        )
    )
    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=303,
            seq=2,
            text="Một câu chuyện khác bắt đầu",
            speaker="Speaker 1",
            start_time=12.85,
            end_time=15.06,
            event_id="meeting-303-start-12.850",
            is_final=True,
            confidence=0.91,
        )
    )
    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=303,
            seq=3,
            text="Câu kết thúc ở cuối bản ghi",
            speaker="Speaker 1",
            start_time=25.0,
            end_time=27.4,
            event_id="meeting-303-start-25.000",
            is_final=True,
            confidence=0.93,
        )
    )

    db.commit()

    visible = repo.assemble_visible_transcript_segments(303)

    assert len(visible) == 3
    assert [segment["text"] for segment in visible] == [
        "Đáng sợ, mọi con quái bạn đối mặt",
        "Một câu chuyện khác bắt đầu",
        "Câu kết thúc ở cuối bản ghi",
    ]
    assert [segment["start_time"] for segment in visible] == [3.0, 12.85, 25.0]
    assert [segment["end_time"] for segment in visible] == [5.8, 15.06, 27.4]
    assert repo.assemble_transcript_text(303) == (
        "Đáng sợ, mọi con quái bạn đối mặt Một câu chuyện khác bắt đầu Câu kết thúc ở cuối bản ghi"
    )

    db.close()
    engine.dispose()


def test_legacy_dedupe_key_is_unchanged_by_provenance_support():
    fragment = TranscriptFragmentInput(
        meeting_id=401,
        seq=1,
        text="Xin chao",
        speaker="system",
        start_time=1.0,
        end_time=2.0,
        event_id="evt-legacy",
        is_final=True,
        confidence=0.91,
        stream_id="tab",
    )

    assert build_fragment_dedupe_key(fragment) == (
        "5e2bbab99e88e201eeea5968d6f79dd75a5b58f9079389dabc6d40c3be7c6178"
    )


def test_v2_dedupe_keys_differ_across_attempt_ids():
    first = TranscriptFragmentInput(
        meeting_id=402,
        recording_session_id=1001,
        attempt_id=1,
        stream_id="tab",
        seq=1,
        text="same",
        start_time=1.0,
        end_time=2.0,
        event_id="evt-v2",
    )
    second = TranscriptFragmentInput(
        meeting_id=402,
        recording_session_id=1001,
        attempt_id=2,
        stream_id="tab",
        seq=1,
        text="same",
        start_time=1.0,
        end_time=2.0,
        event_id="evt-v2",
    )

    assert build_fragment_dedupe_key(first) != build_fragment_dedupe_key(second)


def test_v2_same_meeting_stream_seq_across_attempts_creates_distinct_rows():
    db, engine = _make_repo()
    repo = TranscriptPersistenceRepository(db)

    first = repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=403,
            recording_session_id=1001,
            attempt_id=1,
            stream_id="mic",
            seq=1,
            text="attempt one",
            start_time=1.0,
            end_time=2.0,
            event_id="evt-shared",
        )
    )
    second = repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=403,
            recording_session_id=1001,
            attempt_id=2,
            stream_id="mic",
            seq=1,
            text="attempt two",
            start_time=1.0,
            end_time=2.0,
            event_id="evt-shared",
        )
    )
    db.commit()

    assert first.id != second.id
    assert first.version == 1
    assert second.version == 1
    assert (
        repo.list_attempt_fragments(
            403, recording_session_id=1001, attempt_id=1, stream_id="mic"
        )[0].text
        == "attempt one"
    )
    assert (
        repo.list_attempt_fragments(
            403, recording_session_id=1001, attempt_id=2, stream_id="mic"
        )[0].text
        == "attempt two"
    )
    db.close()
    engine.dispose()


def test_v2_same_attempt_seq_versions_within_attempt_scope():
    db, engine = _make_repo()
    repo = TranscriptPersistenceRepository(db)

    first = repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=404,
            recording_session_id=1001,
            attempt_id=1,
            stream_id="tab",
            seq=1,
            text="first",
            start_time=1.0,
            end_time=2.0,
            event_id="evt-first",
        )
    )
    correction = repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=404,
            recording_session_id=1001,
            attempt_id=1,
            stream_id="tab",
            seq=1,
            text="correction",
            start_time=1.0,
            end_time=2.0,
            event_id="evt-correction",
        )
    )
    db.commit()

    assert first.id != correction.id
    assert correction.version == 2
    db.close()
    engine.dispose()


def test_partial_provenance_and_default_stream_are_rejected_before_write():
    with pytest.raises(ValueError):
        TranscriptFragmentInput(
            meeting_id=405,
            recording_session_id=1001,
            attempt_id=None,
            seq=1,
            text="partial",
        )

    with pytest.raises(ValueError):
        TranscriptFragmentInput(
            meeting_id=405,
            recording_session_id=1001,
            attempt_id=1,
            stream_id="default",
            seq=1,
            text="bad stream",
        )


def test_legacy_reads_exclude_v2_rows_and_v2_reads_exclude_legacy_rows():
    db, engine = _make_repo()
    repo = TranscriptPersistenceRepository(db)

    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=406,
            seq=1,
            stream_id="tab",
            text="legacy",
            start_time=1.0,
            end_time=2.0,
            event_id="evt-legacy",
        )
    )
    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=406,
            recording_session_id=1001,
            attempt_id=1,
            seq=1,
            stream_id="tab",
            text="v2",
            start_time=1.0,
            end_time=2.0,
            event_id="evt-v2",
        )
    )
    db.commit()

    assert [item.text for item in repo.list_fragments(406)] == ["legacy"]
    assert repo.assemble_transcript_text(406) == "legacy"
    assert [
        item.text
        for item in repo.list_attempt_fragments(
            406, recording_session_id=1001, attempt_id=1, stream_id="tab"
        )
    ] == ["v2"]
    assert (
        repo.assemble_attempt_transcript_text(
            406, recording_session_id=1001, attempt_id=1, stream_id="tab"
        )
        == "v2"
    )
    db.close()
    engine.dispose()


def test_legacy_checkpoint_and_v2_attempt_checkpoints_are_independent():
    db, engine = _make_repo()
    repo = TranscriptPersistenceRepository(db)

    legacy = repo.upsert_checkpoint(
        407, stream_id="mic", last_ack_seq=2, last_persisted_seq=2
    )
    attempt_one = repo.upsert_attempt_checkpoint(
        407,
        recording_session_id=1001,
        attempt_id=1,
        stream_id="mic",
        last_ack_seq=1,
        last_persisted_seq=1,
    )
    attempt_two = repo.upsert_attempt_checkpoint(
        407,
        recording_session_id=1001,
        attempt_id=2,
        stream_id="mic",
        last_ack_seq=5,
        last_persisted_seq=5,
    )
    db.commit()

    assert legacy.last_ack_seq == 2
    assert attempt_one.last_ack_seq == 1
    assert attempt_two.last_ack_seq == 5
    assert repo.get_checkpoint(407, stream_id="mic").last_ack_seq == 2
    assert (
        repo.get_attempt_checkpoint(
            407, recording_session_id=1001, attempt_id=1, stream_id="mic"
        ).last_ack_seq
        == 1
    )
    assert (
        repo.get_attempt_checkpoint(
            407, recording_session_id=1001, attempt_id=2, stream_id="mic"
        ).last_ack_seq
        == 5
    )
    db.close()
    engine.dispose()


def test_validate_transcript_provenance_treats_omitted_fastapi_defaults_as_legacy():
    for omitted in (None, Query(default=None), Form(default=None)):
        provenance = validate_transcript_provenance(omitted, omitted)
        assert provenance.recording_session_id is None
        assert provenance.attempt_id is None
        assert provenance.is_v2 is False


@pytest.mark.parametrize("malformed", ["", " ", "not-an-int"])
def test_validate_transcript_provenance_rejects_malformed_recording_session_id(
    malformed,
):
    with pytest.raises(ValueError, match="recording_session_id must be an integer"):
        validate_transcript_provenance(malformed, 1)


def test_validate_transcript_provenance_rejects_malformed_values():
    with pytest.raises(ValueError, match="attempt_id must be an integer"):
        validate_transcript_provenance(1, "bad")

    with pytest.raises(ValueError, match="both be present or both be absent"):
        validate_transcript_provenance(1, None)
