import asyncio
import contextlib
from dataclasses import dataclass
from types import SimpleNamespace

import pytest
from sqlalchemy.exc import IntegrityError

from app.services import stt_session_actor as actor_module
from app.services.stt_session_actor import (
    AudioEnvelope,
    BoundedMessageQueue,
    MeetingSessionActor,
    MeetingSessionState,
    QueueCapacityError,
)


class ConnectionClosedOK(Exception):
    code = 1000
    reason = ""


@dataclass
class _FakeDBSession:
    closed: bool = False

    def commit(self):
        return None

    def close(self):
        self.closed = True


class _FakeRepository:
    def __init__(self):
        self.fragments = []
        self.checkpoints = []

    def append_fragment(self, fragment):
        fragment_key = (
            fragment.meeting_id,
            fragment.seq,
            fragment.text,
            fragment.event_id,
            fragment.is_final,
        )
        existing = next(
            (
                item
                for item in self.fragments
                if (
                    item.meeting_id,
                    item.seq,
                    item.text,
                    item.event_id,
                    item.is_final,
                )
                == fragment_key
            ),
            None,
        )
        if existing is not None:
            return existing
        self.fragments.append(fragment)
        return fragment

    def upsert_checkpoint(self, meeting_id, **kwargs):
        state = {"meeting_id": meeting_id, **kwargs}
        self.checkpoints.append(state)
        return SimpleNamespace(**state)

    def assemble_transcript_text(self, meeting_id):
        texts = [
            fragment.text
            for fragment in self.fragments
            if fragment.meeting_id == meeting_id
        ]
        return " ".join(texts).strip()

    def list_fragments(self, meeting_id):
        return [
            fragment for fragment in self.fragments if fragment.meeting_id == meeting_id
        ]


class _FakeAdapter:
    def __init__(self):
        self.session_id = None
        self.push_calls = []
        self.send_calls = []
        self.recv_calls = []
        self.events_by_ts = {}
        self.close_calls = 0
        self.open_calls = 0
        self.active_sends = 0
        self.max_active_sends = 0
        self.fail_next_send = False
        self.next_send_exc = None

    async def open_session(self, meeting_id, language):
        self.open_calls += 1
        self.session_id = f"session-{meeting_id}"
        return self.session_id

    async def send_audio_chunk(self, session_id, pcm_chunk):
        if self.next_send_exc is not None:
            exc = self.next_send_exc
            self.next_send_exc = None
            raise exc
        if self.fail_next_send:
            self.fail_next_send = False
            raise TimeoutError("send timed out")

        self.active_sends += 1
        self.max_active_sends = max(self.max_active_sends, self.active_sends)
        await asyncio.sleep(0.01)
        self.send_calls.append((session_id, bytes(pcm_chunk)))
        self.active_sends -= 1
        text = bytes(pcm_chunk).decode("utf-8", errors="ignore") or "chunk"
        self.events_by_ts.setdefault(len(self.send_calls), []).append(
            {
                "text": text,
                "is_final": False,
                "confidence": 0.91,
                "ts_ms": len(self.send_calls),
                "event_id": f"evt-{len(self.send_calls)}",
            }
        )

    async def push_audio_chunk(
        self, session_id, pcm_chunk, ts_ms, seq=None, drain_transcript=True
    ):
        self.push_calls.append(
            (session_id, bytes(pcm_chunk), int(ts_ms), seq, drain_transcript)
        )
        await self.send_audio_chunk(session_id, pcm_chunk)
        if drain_transcript:
            return await self.recv_transcript_events(session_id, ts_ms)
        return []

    async def recv_transcript_events(self, session_id, ts_ms, drain_timeout=None):
        self.recv_calls.append((session_id, int(ts_ms), drain_timeout))
        return self.events_by_ts.pop(ts_ms, [])

    async def close_session(self, session_id):
        self.close_calls += 1


class _MetadataOnlyAdapter(_FakeAdapter):
    async def send_audio_chunk(self, session_id, pcm_chunk):
        self.send_calls.append((session_id, bytes(pcm_chunk)))

    async def recv_transcript_events(self, session_id, ts_ms, drain_timeout=None):
        self.recv_calls.append((session_id, int(ts_ms), drain_timeout))
        return []


def _bind_fake_repository(monkeypatch):
    repo = _FakeRepository()
    monkeypatch.setattr(
        actor_module, "TranscriptPersistenceRepository", lambda db: repo
    )
    return repo


def _configure_gap_test_actor(actor):
    actor.GAP_TIMEOUT_SECONDS = 0.05
    actor._recv_stall_seconds = 999.0
    actor._persist_stall_seconds = 999.0
    actor._half_open_stall_seconds = 999.0
    return actor


def test_actor_replays_acked_seq_without_duplicate_persistence(monkeypatch):
    repo = _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="44",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        try:
            first = await actor.submit_chunk(1, b"xin", 1, False)
            second = await actor.submit_chunk(1, b"xin", 1, False)
            close_calls_before_shutdown = adapter.close_calls
            fragment_count = len(repo.fragments)
            return (
                actor,
                adapter,
                first,
                second,
                close_calls_before_shutdown,
                fragment_count,
            )
        finally:
            await actor.shutdown()

    actor, adapter, first, second, close_calls_before_shutdown, fragment_count = (
        asyncio.run(run_flow())
    )

    assert first.transcript == "xin"
    assert second.transcript == "xin"
    assert fragment_count == 1
    assert actor._last_ack_seq == 1
    assert actor._last_persisted_seq == 1
    assert close_calls_before_shutdown == 0


def test_actor_pushes_audio_chunks_to_adapter_in_sequence(monkeypatch):
    repo = _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="45",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        try:
            await asyncio.gather(
                actor.submit_chunk(1, b"one", 1, False),
                actor.submit_chunk(2, b"two", 2, False),
            )
            return (
                actor,
                adapter,
                adapter.close_calls,
                list(fragment.text for fragment in repo.fragments),
            )
        finally:
            await actor.shutdown()

    actor, adapter, close_calls_before_shutdown, fragment_texts = asyncio.run(
        run_flow()
    )

    assert [seq for _, _, _, seq, _ in adapter.push_calls] == [1, 2]
    assert [payload for _, payload in adapter.send_calls] == [b"one", b"two"]
    assert adapter.max_active_sends == 1
    assert fragment_texts == ["one", "two"]
    assert close_calls_before_shutdown == 0


def test_actor_final_signal_drains_and_closes_without_watchdog(monkeypatch):
    repo = _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="57",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        actor._recv_stall_seconds = 0.01
        actor._persist_stall_seconds = 0.01
        first = await actor.submit_chunk(1, b"one", 1, False)
        final = await actor.finalize(seq=-1, ts_ms=-1)
        await asyncio.sleep(0)
        return (
            actor,
            adapter,
            first,
            final,
            list(actor._state_history),
            [f.text for f in repo.fragments],
        )

    actor, adapter, first, final, state_history, fragment_texts = asyncio.run(
        run_flow()
    )

    assert first.transcript == "one"
    assert final.transcript == "one"
    assert final.is_final is True
    assert ("ACTIVE", "DRAINING") in state_history
    assert ("DRAINING", "CLOSED") in state_history
    assert not any(
        next_state in {"DEGRADED", "FAILED"} for _, next_state in state_history
    )
    assert actor.state == MeetingSessionState.CLOSED
    assert adapter.close_calls == 1
    assert fragment_texts == ["one"]


def test_actor_persists_parsed_transcript_fragment(monkeypatch):
    repo = _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="61",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        try:
            response = await actor.submit_chunk(1, b"parsed", 1, False)
            return actor, adapter, response, list(repo.fragments)
        finally:
            await actor.shutdown()

    actor, adapter, response, fragments = asyncio.run(run_flow())

    assert response.transcript == "parsed"
    assert len(fragments) == 1
    assert fragments[0].meeting_id == 61
    assert fragments[0].seq == 1
    assert fragments[0].text == "parsed"
    assert adapter.recv_calls
    assert actor.state == MeetingSessionState.CLOSED


def test_actor_blocks_reconnect_for_webm_continuation_after_terminal_close(monkeypatch):
    repo = _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="65",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        try:
            first = await actor.submit_chunk(1, b"one", 1, False)
            adapter.next_send_exc = ConnectionClosedOK("close")
            with pytest.raises(Exception):
                await actor.submit_chunk(2, b"two", 2, False)
            return actor, adapter, first, list(repo.fragments)
        finally:
            await actor.shutdown()

    actor, adapter, first, fragments = asyncio.run(run_flow())

    assert first.transcript == "one"
    assert adapter.open_calls == 1
    assert len(fragments) == 1
    assert (
        actor.state == MeetingSessionState.CLOSED
        or actor.state == MeetingSessionState.FAILED
    )
    assert (
        MeetingSessionState.HALF_OPEN.value,
        MeetingSessionState.FAILED.value,
    ) in actor._state_history


def test_actor_terminal_close_logs_code_and_reason(monkeypatch):
    repo = _bind_fake_repository(monkeypatch)

    logged = []
    monkeypatch.setattr(
        actor_module,
        "logger",
        SimpleNamespace(
            info=lambda *args, **kwargs: None,
            warning=lambda message, *args: logged.append((message, args)),
            exception=lambda *args, **kwargs: None,
        ),
    )

    class TerminalCloseError(ConnectionClosedOK):
        reason = "bye"

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="66",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        try:
            await actor.submit_chunk(1, b"one", 1, False)
            adapter.next_send_exc = TerminalCloseError("bye")
            with pytest.raises(Exception):
                await actor.submit_chunk(2, b"two", 2, False)
            return actor, adapter, list(repo.fragments)
        finally:
            await actor.shutdown()

    actor, adapter, fragments = asyncio.run(run_flow())

    assert adapter.open_calls == 1
    assert len(fragments) == 1
    assert any("STT_SOCKET_TERMINAL_CLOSE" in message for message, _ in logged)
    assert any(
        args[2] in {1000, "1000"}
        for message, args in logged
        if "STT_SOCKET_TERMINAL_CLOSE" in message
    )
    assert any(
        args[3] == "bye"
        for message, args in logged
        if "STT_SOCKET_TERMINAL_CLOSE" in message
    )


def test_actor_persists_seconds_based_timing_without_millisecond_scaling(monkeypatch):
    repo = _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()

        async def send_audio_chunk_with_timing(session_id, pcm_chunk):
            adapter.send_calls.append((session_id, bytes(pcm_chunk)))
            adapter.events_by_ts.setdefault(1, []).append(
                {
                    "text": "parsed",
                    "is_final": False,
                    "confidence": 0.91,
                    "ts_ms": 1,
                    "start_time": 12.85,
                    "end_time": 15.06,
                    "segment_id": "meeting-61-start-12.850",
                }
            )

        adapter.send_audio_chunk = send_audio_chunk_with_timing
        actor = await MeetingSessionActor.create(
            meeting_key="63",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        try:
            response = await actor.submit_chunk(1, b"parsed", 1, False)
            return actor, adapter, response, list(repo.fragments)
        finally:
            await actor.shutdown()

    actor, adapter, response, fragments = asyncio.run(run_flow())

    assert response.transcript == "parsed"
    assert len(fragments) == 1
    assert fragments[0].start_time == 12.85
    assert fragments[0].end_time == 15.06
    assert fragments[0].end_time >= fragments[0].start_time
    assert fragments[0].event_id == "meeting-61-start-12.850"
    assert actor.state == MeetingSessionState.CLOSED


class _IntegrityErrorOnceDBSession:
    def __init__(self):
        self.closed = False
        self.commit_calls = 0
        self.rollback_calls = 0

    def commit(self):
        self.commit_calls += 1
        if self.commit_calls == 1:
            raise IntegrityError(
                "INSERT INTO transcript_fragments",
                {},
                Exception(
                    'duplicate key value violates unique constraint "uq_transcript_fragments_dedupe_key"'
                ),
            )

    def rollback(self):
        self.rollback_calls += 1

    def close(self):
        self.closed = True


def test_actor_deduped_commit_retry_does_not_fail(monkeypatch):
    repo = _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()

        async def send_audio_chunk_with_duplicate(session_id, pcm_chunk):
            adapter.send_calls.append((session_id, bytes(pcm_chunk)))
            adapter.events_by_ts.setdefault(1, []).append(
                {
                    "text": "duplicate row",
                    "is_final": True,
                    "confidence": 0.95,
                    "ts_ms": 1,
                    "start_time": 12.85,
                    "end_time": 15.06,
                    "segment_id": "meeting-64-start-12.850",
                }
            )

        adapter.send_audio_chunk = send_audio_chunk_with_duplicate
        actor = await MeetingSessionActor.create(
            meeting_key="64",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _IntegrityErrorOnceDBSession(),
        )
        try:
            response = await actor.submit_chunk(1, b"duplicate row", 1, False)
            return actor, adapter, response, list(repo.fragments)
        finally:
            await actor.shutdown()

    actor, adapter, response, fragments = asyncio.run(run_flow())

    assert response.transcript == "duplicate row"
    assert len(fragments) == 1
    assert fragments[0].start_time == 12.85
    assert fragments[0].end_time == 15.06
    assert actor.state == MeetingSessionState.CLOSED
    assert not any(
        state == MeetingSessionState.FAILED for _, state in actor._state_history
    )


def test_actor_metadata_only_stream_finalizes_without_persisting_fragment(monkeypatch):
    repo = _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _MetadataOnlyAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="62",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        try:
            first = await actor.submit_chunk(1, b"webm-bytes", 1, False)
            final = await actor.finalize(seq=-1, ts_ms=-1)
            return actor, adapter, first, final, list(repo.fragments)
        finally:
            await actor.shutdown()

    actor, adapter, first, final, fragments = asyncio.run(run_flow())

    assert first.transcript == ""
    assert final.transcript == ""
    assert final.is_final is True
    assert fragments == []
    assert adapter.send_calls
    assert adapter.close_calls == 1
    assert actor.state == MeetingSessionState.CLOSED


def test_actor_synthetic_final_chunk_does_not_push_audio(monkeypatch):
    _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="58",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        final = await actor.submit_chunk(-1, b"", -1, True)
        return actor, adapter, final

    actor, adapter, final = asyncio.run(run_flow())

    assert final.is_final is True
    assert adapter.push_calls == []
    assert adapter.send_calls == []
    assert adapter.close_calls == 1
    assert actor.state == MeetingSessionState.CLOSED


def test_actor_finalization_closes_deepgram_once(monkeypatch):
    _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="59",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        await actor.finalize(seq=-1, ts_ms=-1)
        await actor.shutdown()
        return actor, adapter

    actor, adapter = asyncio.run(run_flow())

    assert actor.state == MeetingSessionState.CLOSED
    assert adapter.close_calls == 1


def test_actor_duplicate_finalization_returns_cached_response(monkeypatch):
    _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="60",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        await actor.submit_chunk(1, b"cached", 1, False)
        first = await actor.finalize(seq=-1, ts_ms=-1)
        second = await actor.finalize(seq=-1, ts_ms=-1)
        return actor, adapter, first, second

    actor, adapter, first, second = asyncio.run(run_flow())

    assert first == second
    assert first.transcript == "cached"
    assert first.is_final is True
    assert adapter.close_calls == 1
    assert actor.state == MeetingSessionState.CLOSED


def test_actor_ack_advances_only_after_push_succeeds(monkeypatch):
    _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="54",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        send_started = asyncio.Event()
        send_release = asyncio.Event()
        original_send_audio_chunk = adapter.send_audio_chunk

        async def gated_send_audio_chunk(session_id, pcm_chunk):
            send_started.set()
            await send_release.wait()
            return await original_send_audio_chunk(session_id, pcm_chunk)

        adapter.send_audio_chunk = gated_send_audio_chunk

        try:
            submit_task = asyncio.create_task(actor.submit_chunk(1, b"one", 1, False))
            await asyncio.wait_for(send_started.wait(), timeout=1.0)
            assert actor._last_ack_seq == 0
            send_release.set()
            response = await asyncio.wait_for(submit_task, timeout=1.0)
            return actor, adapter, response
        finally:
            await actor.shutdown()

    actor, adapter, response = asyncio.run(run_flow())

    assert response.transcript == "one"
    assert adapter.push_calls[0][3] == 1
    assert actor._last_ack_seq == 1


def test_actor_ack_does_not_advance_when_push_fails(monkeypatch):
    _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="55",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )

        async def failing_push_audio_chunk(
            session_id, pcm_chunk, ts_ms, seq=None, drain_transcript=True
        ):
            raise RuntimeError("terminal_send")

        adapter.push_audio_chunk = failing_push_audio_chunk

        try:
            audio = AudioEnvelope(
                seq=1,
                pcm_chunk=b"one",
                ts_ms=1,
                language="vi",
                is_final=False,
                size_bytes=3,
            )
            with pytest.raises(RuntimeError, match="terminal_send"):
                await actor._process_audio(audio)
            return actor
        finally:
            await actor.shutdown()

    actor = asyncio.run(run_flow())

    assert actor._last_ack_seq == 0


def test_actor_transient_retry_keeps_socket_open(monkeypatch):
    _bind_fake_repository(monkeypatch)
    adapter = _FakeAdapter()
    adapter.fail_next_send = True

    async def run_flow():
        actor = await MeetingSessionActor.create(
            meeting_key="46",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        try:
            response = await actor.submit_chunk(1, b"retry", 1, False)
            return response, actor, adapter.close_calls
        finally:
            await actor.shutdown()

    response, actor, close_calls_before_shutdown = asyncio.run(run_flow())

    assert response.transcript == "retry"
    assert close_calls_before_shutdown == 0
    assert actor.state == MeetingSessionState.CLOSED


def test_actor_recv_pump_stays_alive_after_dg_connected(monkeypatch):
    _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="56",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        try:
            assert actor._recv_task is not None and not actor._recv_task.done()
            response = await actor.submit_chunk(1, b"alive", 1, False)
            await asyncio.sleep(0.05)
            assert actor._recv_task is not None and not actor._recv_task.done()
            return actor, adapter, response
        finally:
            await actor.shutdown()

    actor, adapter, response = asyncio.run(run_flow())

    assert response.transcript == "alive"
    assert adapter.recv_calls


def test_actor_keeps_active_when_expected_seq_is_missing_and_no_higher_seq_is_pending(
    monkeypatch,
):
    _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="50",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        _configure_gap_test_actor(actor)
        try:
            response = await actor.submit_chunk(1, b"one", 1, False)
            await asyncio.sleep(0.12)
            await actor._drain_ready_audio()
            assert actor.state == MeetingSessionState.ACTIVE
            return actor, response, adapter
        finally:
            await actor.shutdown()

    actor, response, adapter = asyncio.run(run_flow())

    assert response.transcript == "one"
    assert actor.state == MeetingSessionState.CLOSED
    assert actor._last_ack_seq == 1
    assert adapter.close_calls == 1


def test_actor_accepts_late_next_seq_after_idle_gap(monkeypatch):
    _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="51",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        _configure_gap_test_actor(actor)
        try:
            first = await actor.submit_chunk(1, b"one", 1, False)
            await asyncio.sleep(0.12)
            second = await actor.submit_chunk(2, b"two", 2, False)
            return actor, first, second, adapter
        finally:
            await actor.shutdown()

    actor, first, second, adapter = asyncio.run(run_flow())

    assert first.transcript == "one"
    assert second.transcript == "two"
    assert actor._last_ack_seq == 2
    assert actor.state == MeetingSessionState.CLOSED
    assert adapter.close_calls == 1


def test_actor_only_times_out_when_higher_seq_is_pending(monkeypatch):
    _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="52",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        _configure_gap_test_actor(actor)
        pending_task = None
        try:
            await actor.submit_chunk(1, b"one", 1, False)
            pending_task = asyncio.create_task(
                actor.submit_chunk(3, b"three", 3, False)
            )
            await asyncio.sleep(0.12)
            with pytest.raises(RuntimeError, match="Sequence gap timeout"):
                await actor._drain_ready_audio()
            assert actor.state == MeetingSessionState.FAILED
            return actor, pending_task, adapter
        finally:
            if pending_task is not None:
                pending_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, RuntimeError):
                    await pending_task
            await actor.shutdown()

    actor, pending_task, adapter = asyncio.run(run_flow())

    assert actor.state == MeetingSessionState.CLOSED
    assert adapter.close_calls == 1
    assert pending_task.cancelled()


def test_actor_sparse_chunks_stay_active_and_continue_ordering(monkeypatch):
    _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="53",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        _configure_gap_test_actor(actor)
        try:
            first = await actor.submit_chunk(1, b"one", 1, False)
            await asyncio.sleep(0.12)
            await actor._drain_ready_audio()
            assert actor.state == MeetingSessionState.ACTIVE
            second = await actor.submit_chunk(2, b"two", 2, False)
            return actor, first, second, adapter
        finally:
            await actor.shutdown()

    actor, first, second, adapter = asyncio.run(run_flow())

    assert first.transcript == "one"
    assert second.transcript == "two"
    assert actor._last_ack_seq == 2
    assert actor.state == MeetingSessionState.CLOSED
    assert adapter.close_calls == 1


def test_actor_shutdown_is_idempotent(monkeypatch):
    _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="47",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        await actor.shutdown()
        await actor.shutdown()
        return actor, adapter

    actor, adapter = asyncio.run(run_flow())

    assert adapter.close_calls == 1
    assert actor.state == MeetingSessionState.CLOSED


def test_actor_queue_capacity_is_bounded():
    queue = BoundedMessageQueue(1, 4, "audio")
    item = AudioEnvelope(
        seq=1, pcm_chunk=b"ab", ts_ms=1, language="vi", is_final=False, size_bytes=2
    )

    async def run_flow():
        await queue.put(item, timeout_seconds=0.1)
        with pytest.raises(QueueCapacityError):
            await queue.put(
                AudioEnvelope(
                    seq=2,
                    pcm_chunk=b"cd",
                    ts_ms=2,
                    language="vi",
                    is_final=False,
                    size_bytes=3,
                ),
                timeout_seconds=0.05,
            )

    asyncio.run(run_flow())


def test_actor_queue_adaptive_rejection_trips_before_memory_growth():
    queue = BoundedMessageQueue(
        2, 8, "audio", overload_ratio=0.5, overload_policy="drop_newest"
    )
    first = AudioEnvelope(
        seq=1, pcm_chunk=b"ab", ts_ms=1, language="vi", is_final=False, size_bytes=2
    )
    second = AudioEnvelope(
        seq=2, pcm_chunk=b"cd", ts_ms=2, language="vi", is_final=False, size_bytes=2
    )

    async def run_flow():
        await queue.put(first, timeout_seconds=0.1)
        with pytest.raises(QueueCapacityError):
            await queue.put(second, timeout_seconds=0.1)

    asyncio.run(run_flow())


def test_actor_watchdog_fails_stuck_half_open_actor(monkeypatch):
    _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="49",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        try:
            await actor._transition(MeetingSessionState.HALF_OPEN, "test_half_open")
            actor._pending_audio[7] = AudioEnvelope(
                seq=7,
                pcm_chunk=b"zz",
                ts_ms=7,
                language="vi",
                is_final=False,
                size_bytes=2,
            )
            actor._state_entered_at = 0.0
            actor._last_recv_at = 0.0
            actor._last_persist_at = 0.0
            actor._half_open_stall_seconds = 0.0
            actor._recv_stall_seconds = 0.0
            actor._persist_stall_seconds = 0.0

            await actor._watchdog_tick()
            return actor, adapter
        finally:
            await actor.shutdown()

    actor, adapter = asyncio.run(run_flow())

    assert actor.state == MeetingSessionState.CLOSED
    assert adapter.close_calls == 1


def test_actor_reconnect_cooldown_is_enforced(monkeypatch):
    _bind_fake_repository(monkeypatch)

    async def run_flow():
        adapter = _FakeAdapter()
        actor = await MeetingSessionActor.create(
            meeting_key="48",
            language="vi",
            adapter=adapter,
            db_session_factory=lambda: _FakeDBSession(),
        )
        return actor, adapter

    actor, adapter = asyncio.run(run_flow())
    actor._reconnect_history = [0.0, 1.0]
    actor._cooldown_until = 10.0
    envelope = AudioEnvelope(
        seq=3, pcm_chunk=b"boom", ts_ms=3, language="vi", is_final=False, size_bytes=4
    )

    async def run_flow():
        await actor._maybe_reconnect_or_fail(TimeoutError("timeout"), envelope)

    try:
        asyncio.run(run_flow())
    finally:
        close_calls_before_shutdown = adapter.close_calls
        asyncio.run(actor.shutdown())

    assert actor._cooldown_until >= 10.0
    assert close_calls_before_shutdown == 0
