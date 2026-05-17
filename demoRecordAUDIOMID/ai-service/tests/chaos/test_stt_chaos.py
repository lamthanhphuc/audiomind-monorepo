import asyncio
import pytest

from app.services import stt_session_actor as actor_module
from app.services.stt_session_actor import MeetingSessionActor, MeetingSessionState
from tests.helpers.fake_stt import FakeAdapter
from tests.helpers.teardown import assert_no_pending_stt_tasks


class _FakeDBSession:
    def commit(self):
        return None

    def close(self):
        return None


class _FakeRepo:
    def __init__(self, db):
        self._frags = []

    def upsert_checkpoint(self, meeting_id, **kwargs):
        return None

    def append_fragment(self, fragment):
        self._frags.append(fragment)
        return fragment

    def assemble_transcript_text(self, meeting_id):
        return " ".join([f.text for f in self._frags])


@pytest.mark.anyio
async def test_websocket_close_during_send(monkeypatch):
    adapter = FakeAdapter()
    monkeypatch.setattr(actor_module, "TranscriptPersistenceRepository", _FakeRepo)

    actor = await MeetingSessionActor.create(
        "42", "vi", adapter, db_session_factory=lambda: _FakeDBSession()
    )

    class ConnectionClosedError(RuntimeError):
        pass

    original_send_audio_chunk = adapter.send_audio_chunk
    send_calls = 0

    async def send_and_close(session_id, chunk):
        nonlocal send_calls
        send_calls += 1
        await original_send_audio_chunk(session_id, chunk)
        if send_calls == 1:
            await adapter.close_session(session_id)
            raise ConnectionClosedError("websocket closed during send")

    adapter.send_audio_chunk = send_and_close

    first = await actor.submit_chunk(1, b"audio1", ts_ms=1, is_final=False)
    second = await actor.submit_chunk(2, b"audio2", ts_ms=2, is_final=True)

    assert first.transcript == "chunk1"
    assert second.transcript == "chunk2"

    try:
        await asyncio.sleep(0.1)
        assert actor.state in {
            MeetingSessionState.ACTIVE,
            MeetingSessionState.DRAINING,
            MeetingSessionState.CLOSED,
        }
    finally:
        await actor.shutdown()
        assert_no_pending_stt_tasks(actor)


@pytest.mark.anyio
async def test_deepgram_1011_reconnect_loop(monkeypatch):
    # Adapter that fails to open_session to simulate reconnect loop
    adapter = FakeAdapter(behavior={"open_fail": True})

    monkeypatch.setattr(actor_module, "TranscriptPersistenceRepository", _FakeRepo)

    # Creating actor should raise due to open failure
    with pytest.raises(Exception):
        await MeetingSessionActor.create(
            "999", "vi", adapter, db_session_factory=lambda: _FakeDBSession()
        )


@pytest.mark.anyio
async def test_queue_overload_flood(monkeypatch):
    adapter = FakeAdapter()
    monkeypatch.setattr(actor_module, "TranscriptPersistenceRepository", _FakeRepo)

    actor = await MeetingSessionActor.create(
        "77", "vi", adapter, db_session_factory=lambda: _FakeDBSession()
    )

    original_send_audio_chunk = adapter.send_audio_chunk

    async def slow_send_audio_chunk(session_id, chunk):
        await asyncio.sleep(0.05)
        return await original_send_audio_chunk(session_id, chunk)

    adapter.send_audio_chunk = slow_send_audio_chunk

    # Temporarily shrink the queue so flood pressure is deterministic even with the fake adapter.
    actor._audio_queue.max_items = 4
    actor._audio_queue.max_bytes = 8 * 1024

    tasks = [
        asyncio.create_task(
            actor.submit_chunk(i + 1, b"x" * 1024, ts_ms=i + 1, is_final=False)
        )
        for i in range(actor.AUDIO_QUEUE_MAX_ITEMS + 10)
    ]

    try:
        results = await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        await actor.shutdown()

    retryable_errors = [
        result
        for result in results
        if isinstance(result, Exception) and "Queue" in type(result).__name__
    ]

    assert actor._audio_queue.qsize() <= actor.AUDIO_QUEUE_MAX_ITEMS
    assert retryable_errors
    assert not any(type(result).__name__ == "ExceptionGroup" for result in results)
    assert actor.state in {
        MeetingSessionState.ACTIVE,
        MeetingSessionState.DEGRADED,
        MeetingSessionState.FAILED,
        MeetingSessionState.CLOSED,
    }
    assert_no_pending_stt_tasks(actor)
