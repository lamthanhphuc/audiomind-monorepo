import asyncio
from tempfile import SpooledTemporaryFile
from types import SimpleNamespace

import pytest

import app.main as main_module
from app.models import Base
from app.schemas import SttStreamResponse
from app.services.stt_persistence import (
    TranscriptFragmentInput,
    TranscriptPersistenceRepository,
)
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


class FakeConnectionClosedError(Exception):
    pass


class ConnectionClosedOK(Exception):
    code = 1000
    reason = ""


class FakeActor:
    instances = []
    next_submit_exc = None

    def __init__(self, meeting_key, language, adapter):
        self.meeting_key = str(meeting_key)
        self.language = language
        self.adapter = adapter
        self.session_id = f"session-{self.meeting_key}"
        self.close_count = 0
        self.closed = False
        self.submit_calls = []
        self.finalize_calls = []
        FakeActor.instances.append(self)

    async def submit_chunk(self, seq, pcm_chunk, ts_ms, is_final):
        next_exc = FakeActor.next_submit_exc
        FakeActor.next_submit_exc = None
        if next_exc is not None:
            raise next_exc

        self.submit_calls.append((seq, bytes(pcm_chunk), ts_ms, is_final))
        self.adapter.sent_chunks.append((self.session_id, bytes(pcm_chunk), ts_ms))
        response = SttStreamResponse(
            transcript="Xin chao audiomind",
            is_final=is_final,
            confidence=0.97 if is_final else 0.91,
        )
        if is_final:
            await self.shutdown()
        return response

    async def finalize(self, seq, ts_ms=0):
        self.finalize_calls.append((seq, ts_ms))
        response = SttStreamResponse(
            transcript="Xin chao audiomind",
            is_final=True,
            confidence=0.97,
        )
        await self.shutdown()
        return response

    def retry_guard_snapshot(self):
        return {
            "cooldown_until": 0.0,
            "requires_new_stream": False,
            "last_terminal_close_code": None,
            "last_terminal_close_reason": None,
            "last_terminal_close_error": None,
        }

    async def shutdown(self, grace_seconds=None):
        self.close_count += 1
        if not self.closed:
            self.closed = True
            await self.adapter.close_session(self.session_id)


class FakeAdapter:
    instances = []

    def __init__(self, api_key, model, base_url, timeout_seconds, **kwargs):
        self.api_key = api_key
        self.model = model
        self.base_url = base_url
        self.timeout_seconds = timeout_seconds
        self.kwargs = kwargs
        self.sent_chunks = []
        self.closed = False
        self.close_invocations = 0
        FakeAdapter.instances.append(self)

    async def close_session(self, session_id):
        self.close_invocations += 1
        self.closed = True


class FakeWhisperRecognizer:
    def __init__(self):
        self.calls = []

    def transcribe_segment(self, audio, sr=16000, language=None):
        self.calls.append((len(audio), sr, language))
        return {
            "text": "Xin chao fallback",
            "segments": [{"text": "Xin chao fallback", "confidence": 0.88}],
        }

    def get_full_text(self, result):
        return result.get("text", "")


def _make_upload_file(payload: bytes):
    file_obj = SpooledTemporaryFile()
    file_obj.write(payload)
    file_obj.seek(0)
    return main_module.UploadFile(filename="chunk.wav", file=file_obj)


async def _fake_actor_factory(meeting_key, language, *, seq=None, chunk_bytes=None):
    existing = main_module._stt_stream_sessions.get(str(meeting_key))
    if existing is not None:
        return existing

    adapter = main_module._get_stt_adapter()
    if adapter is None:
        raise RuntimeError("Deepgram STT adapter is unavailable")

    actor = FakeActor(meeting_key, language, adapter)
    main_module._stt_stream_sessions[str(meeting_key)] = actor
    return actor


def _reset_state(monkeypatch):
    monkeypatch.setattr(main_module, "DeepgramSTTAdapter", FakeAdapter)
    monkeypatch.setattr(main_module, "_get_or_create_stt_actor", _fake_actor_factory)
    monkeypatch.setattr(main_module.settings, "deepgram_api_key", "test-key")
    main_module._stt_adapter = None
    main_module._stt_stream_sessions.clear()
    main_module._stt_stream_retry_guards.clear()
    main_module._stt_finalized_responses.clear()
    FakeAdapter.instances.clear()
    FakeActor.instances.clear()
    FakeActor.next_submit_exc = None


def test_stream_stt_chunk_reuses_session_and_returns_partial(monkeypatch):
    _reset_state(monkeypatch)

    async def run_flow():
        response = await main_module.stream_stt_chunk(
            meeting_id=44,
            audio_chunk=_make_upload_file(b"abc"),
            seq=1,
            language="vi",
            is_final=False,
        )
        return response

    response = asyncio.run(run_flow())

    assert response.transcript == "Xin chao audiomind"
    assert response.is_final is False
    assert response.confidence == 0.91
    assert len(FakeActor.instances) == 1
    assert FakeActor.instances[0].submit_calls[0][1] == b"abc"


def test_stream_stt_chunk_closes_session_on_final(monkeypatch):
    _reset_state(monkeypatch)

    async def run_flow():
        response = await main_module.stream_stt_chunk(
            meeting_id=55,
            audio_chunk=_make_upload_file(b"def"),
            seq=2,
            language="vi",
            is_final=True,
        )
        return response

    response = asyncio.run(run_flow())

    assert response.transcript == "Xin chao audiomind"
    assert response.is_final is True
    assert response.confidence == 0.97
    assert FakeActor.instances[0].closed is True
    assert FakeActor.instances[0].close_count == 1
    assert FakeActor.instances[0].submit_calls == []
    assert FakeActor.instances[0].finalize_calls == [(2, 2)]
    assert "55" not in main_module._stt_stream_sessions
    assert (
        main_module._stt_finalized_responses["55"][0].transcript == "Xin chao audiomind"
    )


def test_stream_stt_chunk_transient_send_failure_keeps_session_alive(monkeypatch):
    _reset_state(monkeypatch)
    FakeActor.next_submit_exc = TimeoutError("send timed out")

    async def run_first_chunk():
        await main_module.stream_stt_chunk(
            meeting_id=91,
            audio_chunk=_make_upload_file(b"abc"),
            seq=1,
            language="vi",
            is_final=False,
        )

    try:
        asyncio.run(run_first_chunk())
    except Exception as exc:
        assert "STT stream failed" in str(exc)

    assert "91" in main_module._stt_stream_sessions
    assert len(FakeActor.instances) == 1
    assert FakeActor.instances[0].close_count == 0

    async def run_second_chunk():
        return await main_module.stream_stt_chunk(
            meeting_id=91,
            audio_chunk=_make_upload_file(b"def"),
            seq=2,
            language="vi",
            is_final=False,
        )

    response = asyncio.run(run_second_chunk())

    assert response.transcript == "Xin chao audiomind"
    assert len(FakeActor.instances) == 1
    assert FakeActor.instances[0].close_count == 0
    assert "91" in main_module._stt_stream_sessions


def test_stream_stt_chunk_terminal_error_retires_session(monkeypatch):
    _reset_state(monkeypatch)
    FakeActor.next_submit_exc = FakeConnectionClosedError("1011 Net0001")

    async def run_flow():
        await main_module.stream_stt_chunk(
            meeting_id=92,
            audio_chunk=_make_upload_file(b"abc"),
            seq=1,
            language="vi",
            is_final=False,
        )

    try:
        asyncio.run(run_flow())
    except Exception as exc:
        assert "new recording lifecycle required" in str(exc).lower()

    assert 92 not in main_module._stt_stream_sessions
    assert len(FakeActor.instances) == 1
    assert FakeActor.instances[0].close_count == 1


def test_stream_stt_chunk_seq_two_terminal_close_blocks_reconnect_and_new_actor_creation(
    monkeypatch,
):
    _reset_state(monkeypatch)

    async def run_first_chunk():
        return await main_module.stream_stt_chunk(
            meeting_id=95,
            audio_chunk=_make_upload_file(b"abc"),
            seq=1,
            language="vi",
            is_final=False,
        )

    first = asyncio.run(run_first_chunk())
    assert first.transcript == "Xin chao audiomind"
    assert len(FakeActor.instances) == 1

    FakeActor.next_submit_exc = ConnectionClosedOK("close")

    async def run_second_chunk():
        with pytest.raises(Exception):
            await main_module.stream_stt_chunk(
                meeting_id=95,
                audio_chunk=_make_upload_file(b"def"),
                seq=2,
                language="vi",
                is_final=False,
            )

    try:
        asyncio.run(run_second_chunk())
    except Exception:
        pass

    assert len(FakeActor.instances) == 1
    assert "95" not in main_module._stt_stream_sessions
    assert FakeActor.instances[0].close_count == 1

    async def run_blocked_retry():
        return await main_module.stream_stt_chunk(
            meeting_id=95,
            audio_chunk=_make_upload_file(b"ghi"),
            seq=3,
            language="vi",
            is_final=False,
        )

    with pytest.raises(Exception) as exc_info:
        asyncio.run(run_blocked_retry())
    assert "reconnect cooldown active" in str(exc_info.value).lower()
    assert len(FakeActor.instances) == 1


def test_stream_stt_chunk_seq_one_terminal_close_can_restart_with_fresh_header(
    monkeypatch,
):
    _reset_state(monkeypatch)
    FakeActor.next_submit_exc = ConnectionClosedOK("close")

    async def run_first_chunk():
        with pytest.raises(Exception):
            await main_module.stream_stt_chunk(
                meeting_id=96,
                audio_chunk=_make_upload_file(b"abc"),
                seq=1,
                language="vi",
                is_final=False,
            )

    try:
        asyncio.run(run_first_chunk())
    except Exception:
        pass

    assert len(FakeActor.instances) == 1
    assert FakeActor.instances[0].close_count == 1

    async def run_restart_chunk():
        return await main_module.stream_stt_chunk(
            meeting_id=96,
            audio_chunk=_make_upload_file(bytes.fromhex("1a45dfa3") + b"header"),
            seq=1,
            language="vi",
            is_final=False,
        )

    response = asyncio.run(run_restart_chunk())
    assert response.transcript == "Xin chao audiomind"
    assert len(FakeActor.instances) == 2


def test_stream_stt_chunk_finalization_is_idempotent(monkeypatch):
    _reset_state(monkeypatch)

    async def run_first_final():
        return await main_module.stream_stt_chunk(
            meeting_id=93,
            audio_chunk=_make_upload_file(b"ghi"),
            seq=3,
            language="vi",
            is_final=True,
        )

    first_response = asyncio.run(run_first_final())

    async def run_second_final():
        return await main_module.stream_stt_chunk(
            meeting_id=93,
            audio_chunk=_make_upload_file(b"ghi"),
            seq=3,
            language="vi",
            is_final=True,
        )

    second_response = asyncio.run(run_second_final())

    assert first_response.transcript == "Xin chao audiomind"
    assert second_response.transcript == "Xin chao audiomind"
    assert FakeActor.instances[0].close_count == 1
    assert 93 not in main_module._stt_stream_sessions


def test_stream_stt_chunk_final_signal_uses_finalize_path_for_synthetic_empty_chunk(
    monkeypatch,
):
    _reset_state(monkeypatch)

    async def run_flow():
        return await main_module.stream_stt_chunk(
            meeting_id=94,
            audio_chunk=_make_upload_file(b""),
            seq=-1,
            language="vi",
            is_final=True,
        )

    response = asyncio.run(run_flow())

    assert response.is_final is True
    assert FakeActor.instances[0].submit_calls == []
    assert FakeActor.instances[0].finalize_calls == [(-1, -1)]
    assert FakeAdapter.instances[0].sent_chunks == []
    assert FakeActor.instances[0].close_count == 1


def test_stream_stt_chunk_blocked_continuation_returns_structured_reset_required(
    monkeypatch,
):
    _reset_state(monkeypatch)
    guard = main_module._get_stream_retry_guard("971")
    guard.requires_new_stream = True
    guard.last_terminal_seq = 8
    guard.last_terminal_close_error = "ConnectionClosedError"

    async def run_flow():
        await main_module.stream_stt_chunk(
            meeting_id=971,
            audio_chunk=_make_upload_file(b"chunk-without-header"),
            seq=13,
            language="vi",
            is_final=False,
        )

    with pytest.raises(Exception) as exc_info:
        asyncio.run(run_flow())

    detail = getattr(exc_info.value, "detail", {})
    assert getattr(exc_info.value, "status_code", None) == 409
    assert detail.get("error") == "webm_continuation_after_reconnect_blocked"
    assert detail.get("reset_required") is True
    assert detail.get("last_ack_seq") == 8


def test_stream_stt_chunk_finalize_after_broken_stream_returns_partial_not_409(
    monkeypatch,
):
    _reset_state(monkeypatch)
    guard = main_module._get_stream_retry_guard("972")
    guard.requires_new_stream = True
    guard.last_terminal_seq = 8
    guard.last_terminal_close_error = "ConnectionClosedError"

    async def run_flow():
        return await main_module.stream_stt_chunk(
            meeting_id=972,
            audio_chunk=_make_upload_file(b""),
            seq=-1,
            language="vi",
            is_final=True,
        )

    response = asyncio.run(run_flow())
    assert response.is_final is True
    assert response.partial is True
    assert response.finalized is False
    assert response.reset_required is True


def test_open_stt_session_json_route(monkeypatch):
    _reset_state(monkeypatch)
    monkeypatch.setattr(
        main_module,
        "pipeline",
        SimpleNamespace(speech_recognizer=FakeWhisperRecognizer()),
    )

    async def run_flow():
        return await main_module.open_stt_session(
            {"meeting_id": "test-123", "language": "vi"}
        )

    response = asyncio.run(run_flow())

    assert response["status"] == "opened"
    assert response["session_id"]
    assert response["meeting_id"] == "test-123"
    assert response["language"] == "vi"


def test_stream_stt_chunk_uses_local_whisper_fallback(monkeypatch):
    fake_recognizer = FakeWhisperRecognizer()
    monkeypatch.setattr(
        main_module, "pipeline", SimpleNamespace(speech_recognizer=fake_recognizer)
    )
    monkeypatch.setattr(main_module.settings, "deepgram_api_key", "")
    main_module._stt_adapter = None
    main_module._stt_stream_sessions.clear()
    main_module._stt_finalized_responses.clear()

    async def run_flow():
        return await main_module.stream_stt_chunk(
            meeting_id=77,
            audio_chunk=_make_upload_file(b"\x01\x00\x02\x00\x03\x00\x04\x00"),
            seq=3,
            language="vi",
            is_final=False,
        )

    response = asyncio.run(run_flow())

    assert response.transcript == "Xin chao fallback"
    assert response.is_final is False
    assert response.confidence == 0.88
    assert fake_recognizer.calls


def test_get_transcript_returns_200_from_fragment_persistence(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    db = SessionLocal()
    repo = TranscriptPersistenceRepository(db)
    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=123,
            seq=1,
            text="Realtime transcript",
            speaker="system",
            start_time=3.0,
            end_time=5.2,
            event_id="evt-route-1",
            is_final=True,
            confidence=0.95,
        )
    )
    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=123,
            seq=2,
            text="Đáng sợ, mọi con quái bạn đối",
            speaker="Speaker 1",
            start_time=12.85,
            end_time=15.06,
            event_id="meeting-123-start-12.850",
            is_final=False,
            confidence=0.8,
        )
    )
    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=123,
            seq=2,
            text="Đáng sợ, mọi con quái bạn đối mặt",
            speaker="Speaker 1",
            start_time=12.85,
            end_time=15.06,
            event_id="meeting-123-start-12.850",
            is_final=True,
            confidence=0.95,
        )
    )
    repo.append_fragment(
        TranscriptFragmentInput(
            meeting_id=123,
            seq=3,
            text="Một câu chuyện khác bắt đầu",
            speaker="Speaker 1",
            start_time=25.0,
            end_time=27.4,
            event_id="meeting-123-start-25.000",
            is_final=True,
            confidence=0.91,
        )
    )
    db.commit()
    monkeypatch.setattr(main_module, "pipeline", None)

    async def run_flow():
        return await main_module.get_transcript(123, db=db)

    try:
        response = asyncio.run(run_flow())
    finally:
        db.close()
        engine.dispose()

    assert response.meeting_id == 123
    assert len(response.transcripts) == 3
    assert [segment.text for segment in response.transcripts] == [
        "Realtime transcript",
        "Đáng sợ, mọi con quái bạn đối mặt",
        "Một câu chuyện khác bắt đầu",
    ]
    assert [segment.start_time for segment in response.transcripts] == [
        3.0,
        12.85,
        25.0,
    ]
    assert [segment.end_time for segment in response.transcripts] == [5.2, 15.06, 27.4]


def test_get_transcript_empty_recording_returns_explicit_404(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    db = SessionLocal()
    monkeypatch.setattr(main_module, "pipeline", None)

    async def run_flow():
        return await main_module.get_transcript(124, db=db)

    try:
        try:
            asyncio.run(run_flow())
        except Exception as exc:
            assert getattr(exc, "status_code", None) == 404
            assert getattr(exc, "detail", None) == (
                "No transcript found for meeting; no speech was detected or no transcript fragments were persisted"
            )
        else:
            raise AssertionError("Expected 404 for empty transcript")
    finally:
        db.close()
        engine.dispose()
