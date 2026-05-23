import asyncio

import pytest

import app.main as main_module
from app.services.stt_ownership import SttLease, SttOwnershipLost
from app.services.stt_session_actor import (
    AudioEnvelope,
    MeetingSessionActor,
    MeetingSessionState,
    PersistEnvelope,
)
from app.schemas import SttStreamResponse


class FakeOwnershipManager:
    def __init__(self, owner_id="owner-a"):
        self.owner_id = owner_id
        self.leases = {}
        self.released = []
        self.cooldowns = {}
        self.fence = 0
        self.validate_result = True

    def acquire(self, meeting_key):
        if meeting_key in self.leases:
            return None
        self.fence += 1
        lease = SttLease(
            meeting_key=str(meeting_key),
            owner_id=self.owner_id,
            token=f"token-{self.fence}",
            fencing_token=self.fence,
        )
        self.leases[str(meeting_key)] = lease
        return lease

    def validate(self, lease):
        return self.validate_result and self.leases.get(lease.meeting_key) == lease

    def refresh(self, lease):
        return self.validate(lease)

    def release(self, lease):
        self.released.append(lease)
        if self.leases.get(lease.meeting_key) != lease:
            return False
        self.leases.pop(lease.meeting_key, None)
        return True

    def get_cooldown_until(self, meeting_key):
        return self.cooldowns.get(str(meeting_key), 0.0)

    def set_cooldown_until(self, meeting_key, cooldown_until):
        self.cooldowns[str(meeting_key)] = float(cooldown_until)


class FakeAdapter:
    def __init__(self):
        self.closed = []
        self.pushes = []

    async def open_session(self, meeting_id, language, diarize=None):
        return f"session-{meeting_id}"

    async def close_session(self, session_id):
        self.closed.append(session_id)

    async def push_audio_chunk(
        self, session_id, pcm_chunk, ts_ms, seq=None, drain_transcript=True
    ):
        self.pushes.append((session_id, bytes(pcm_chunk), ts_ms, seq))

    async def recv_transcript_events(self, session_id, ts_ms, drain_timeout=None):
        return []

    def drain_partial_events(self, session_id):
        return []


class FactoryActor:
    instances = []

    def __init__(
        self, meeting_key, language, speaker_mode, adapter, lease, ownership_manager
    ):
        self.meeting_key = meeting_key
        self.language = language
        self.speaker_mode = speaker_mode
        self.adapter = adapter
        self.lease = lease
        self.ownership_manager = ownership_manager
        self.fencing_token = lease.fencing_token if lease is not None else 0
        self.session_id = f"session-{meeting_key}"
        self.state = MeetingSessionState.ACTIVE
        FactoryActor.instances.append(self)

    @classmethod
    async def create(cls, meeting_key, language, speaker_mode, adapter, **kwargs):
        return cls(
            meeting_key,
            language,
            speaker_mode,
            adapter,
            kwargs.get("lease"),
            kwargs.get("ownership_manager"),
        )

    def _owns_meeting(self):
        return self.ownership_manager.validate(self.lease)

    async def shutdown(self, grace_seconds=15.0):
        self.state = MeetingSessionState.CLOSED


def _reset_main(monkeypatch, manager):
    main_module._stt_stream_sessions.clear()
    main_module._stt_stream_retry_guards.clear()
    main_module._stt_finalized_responses.clear()
    main_module._stt_adapter = FakeAdapter()
    FactoryActor.instances.clear()
    monkeypatch.setattr(main_module, "get_stt_ownership_manager", lambda: manager)
    monkeypatch.setattr(main_module, "MeetingSessionActor", FactoryActor)


def test_get_or_create_rejects_duplicate_active_owner_across_replicas(monkeypatch):
    manager = FakeOwnershipManager()
    _reset_main(monkeypatch, manager)

    async def run_flow():
        first = await main_module._get_or_create_stt_actor("501", "vi", "single", seq=1)
        main_module._stt_stream_sessions.clear()
        with pytest.raises(main_module.HTTPException) as exc_info:
            await main_module._get_or_create_stt_actor("501", "vi", "single", seq=1)
        return first, exc_info.value

    first, exc = asyncio.run(run_flow())

    assert first.fencing_token == 1
    assert exc.status_code == 409
    assert "already owned" in exc.detail["reason"]
    assert len(FactoryActor.instances) == 1


def test_get_or_create_uses_shared_cooldown(monkeypatch):
    manager = FakeOwnershipManager()
    manager.cooldowns["502"] = 9999999999.0
    _reset_main(monkeypatch, manager)

    async def run_flow():
        with pytest.raises(main_module.HTTPException) as exc_info:
            await main_module._get_or_create_stt_actor("502", "vi", "single", seq=2)
        return exc_info.value

    exc = asyncio.run(run_flow())

    assert exc.status_code == 429
    assert exc.detail["reason"] == "reconnect cooldown active"


def test_stale_owner_cannot_send_persist_or_finalize():
    manager = FakeOwnershipManager()
    lease = manager.acquire("503")
    assert lease is not None
    actor = MeetingSessionActor(
        "503",
        "vi",
        "single",
        FakeAdapter(),
        lease=lease,
        ownership_manager=manager,
    )
    actor.state = MeetingSessionState.ACTIVE
    actor.session_id = "stale-session"
    manager.validate_result = False

    audio = AudioEnvelope(
        seq=1,
        pcm_chunk=b"abc",
        ts_ms=1,
        language="vi",
        is_final=False,
        size_bytes=3,
    )
    persist = PersistEnvelope(
        seq=1,
        ts_ms=1,
        is_final=False,
        event_id="evt",
        transcript_events=[],
        size_bytes=1,
    )

    async def run_flow():
        with pytest.raises(SttOwnershipLost):
            await actor._process_audio(audio)
        with pytest.raises(SttOwnershipLost):
            await actor._enqueue_persist(persist)
        with pytest.raises(SttOwnershipLost):
            await actor.finalize(seq=-1, ts_ms=-1)

    asyncio.run(run_flow())


def test_ownership_loss_fails_pending_finalization_future():
    manager = FakeOwnershipManager()
    lease = manager.acquire("505")
    assert lease is not None
    actor = MeetingSessionActor(
        "505",
        "vi",
        "single",
        FakeAdapter(),
        lease=lease,
        ownership_manager=manager,
    )
    actor.state = MeetingSessionState.ACTIVE

    async def run_flow():
        future = asyncio.get_running_loop().create_future()
        actor._finalization_future = future
        actor._pending_futures[-1] = future

        actor._mark_ownership_lost("persist")

        assert future.done()
        with pytest.raises(SttOwnershipLost):
            future.result()

    asyncio.run(run_flow())


def test_valid_owner_can_return_cached_finalization_response():
    manager = FakeOwnershipManager()
    lease = manager.acquire("506")
    assert lease is not None
    actor = MeetingSessionActor(
        "506",
        "vi",
        "single",
        FakeAdapter(),
        lease=lease,
        ownership_manager=manager,
    )
    actor.state = MeetingSessionState.ACTIVE
    actor._final_response = SttStreamResponse(
        transcript="cached final",
        is_final=True,
        confidence=None,
    )

    async def run_flow():
        return await actor.finalize(seq=-1, ts_ms=-1)

    response = asyncio.run(run_flow())

    assert response.transcript == "cached final"
    assert response.is_final is True


def test_shutdown_releases_only_matching_lease():
    manager = FakeOwnershipManager()
    original = manager.acquire("504")
    assert original is not None
    replacement = SttLease(
        meeting_key="504",
        owner_id="owner-b",
        token="new-token",
        fencing_token=99,
    )
    manager.leases["504"] = replacement
    actor = MeetingSessionActor(
        "504",
        "vi",
        "single",
        FakeAdapter(),
        lease=original,
        ownership_manager=manager,
    )
    actor.state = MeetingSessionState.ACTIVE
    actor.session_id = "stale-session"

    asyncio.run(actor.shutdown(grace_seconds=0.1))

    assert manager.leases["504"] == replacement
    assert manager.released == [original]
    assert actor.adapter.closed == []
