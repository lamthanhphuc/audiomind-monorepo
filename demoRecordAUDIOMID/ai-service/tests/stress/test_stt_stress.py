import asyncio
import pytest

from app.services import stt_session_actor as actor_module
from app.services.stt_session_actor import MeetingSessionActor
from tests.helpers.fake_stt import FakeAdapter
from tests.helpers.teardown import assert_no_pending_stt_tasks


class _FakeDBSession:
    def commit(self):
        return None

    def close(self):
        return None


@pytest.mark.anyio
async def test_1k_sequential_chunks(monkeypatch):
    adapter = FakeAdapter()

    class FakeRepo:
        def __init__(self, db):
            self._frags = []

        def upsert_checkpoint(self, meeting_id, **kwargs):
            return None

        def append_fragment(self, fragment):
            self._frags.append(fragment)
            return fragment

        def assemble_transcript_text(self, meeting_id):
            return " ".join([f.text for f in self._frags])

    monkeypatch.setattr(actor_module, "TranscriptPersistenceRepository", FakeRepo)

    actor = await MeetingSessionActor.create(
        "5000", "vi", adapter, db_session_factory=lambda: _FakeDBSession()
    )
    try:

        async def send_many():
            for i in range(1, 1001):
                await actor.submit_chunk(
                    i, b"audio" + bytes([i % 255]), ts_ms=i, is_final=(i == 1000)
                )

        await send_many()
        # after finalization, actor should be closed
        await asyncio.sleep(0.5)
        assert actor.state in {"DRAINING", "CLOSED", actor.state}
    finally:
        await actor.shutdown()
        assert_no_pending_stt_tasks(actor)
