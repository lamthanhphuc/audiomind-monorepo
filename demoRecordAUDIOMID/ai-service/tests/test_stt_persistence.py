from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import sessionmaker

from app.models import Base
from app.services.stt_persistence import (
    TranscriptFragmentInput,
    TranscriptPersistenceRepository,
)


def _make_repo():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    return SessionLocal(), engine


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
    db, engine = _make_repo()
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
