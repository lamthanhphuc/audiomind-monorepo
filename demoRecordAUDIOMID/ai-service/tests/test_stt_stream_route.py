import asyncio
from datetime import datetime, timezone
from tempfile import SpooledTemporaryFile
from types import SimpleNamespace

import app.main as main_module
import pytest
from app.models import Base, Transcript
from app.schemas import SttStreamResponse
from app.services.stt_persistence import (
    TranscriptFragmentInput,
    TranscriptPersistenceRepository,
)
from app.services.transcript_canonicalizer import canonicalize_segments
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
        self._segment_id = f"{self.meeting_key}-1.250-speaker_1-1"
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
            speaker="SPEAKER_1",
            segment_id=self._segment_id,
            start_time=1.25,
            end_time=2.5 + (0.25 * max(0, int(seq) - 1)),
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
            speaker="SPEAKER_1",
            segment_id=self._segment_id,
            start_time=1.25,
            end_time=3.1,
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


class _CaptureLogger:
    def __init__(self):
        self.messages = []

    def _format(self, message, *args):
        if args:
            try:
                return str(message).format(*args)
            except Exception:
                return str(message)
        return str(message)

    def info(self, message, *args, **kwargs):
        self.messages.append(self._format(message, *args))

    def warning(self, message, *args, **kwargs):
        self.messages.append(self._format(message, *args))

    def error(self, message, *args, **kwargs):
        self.messages.append(self._format(message, *args))


def _make_upload_file(payload: bytes):
    file_obj = SpooledTemporaryFile()
    file_obj.write(payload)
    file_obj.seek(0)
    return main_module.UploadFile(filename="chunk.wav", file=file_obj)


async def _fake_actor_factory(
    meeting_key,
    language,
    speaker_mode=None,
    *,
    seq=None,
    chunk_bytes=None,
    endpointing=None,
):
    existing = main_module._stt_stream_sessions.get(str(meeting_key))
    if existing is not None:
        return existing

    adapter = main_module._get_stt_adapter(endpointing=endpointing)
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


def _set_realtime_endpointing_settings(
    monkeypatch,
    *,
    default=None,
    vi=None,
    en=None,
    multi=None,
    legacy=None,
):
    monkeypatch.setattr(
        main_module.settings, "deepgram_realtime_endpointing_default", default
    )
    monkeypatch.setattr(main_module.settings, "deepgram_realtime_endpointing_vi", vi)
    monkeypatch.setattr(main_module.settings, "deepgram_realtime_endpointing_en", en)
    monkeypatch.setattr(
        main_module.settings, "deepgram_realtime_endpointing_multi", multi
    )
    monkeypatch.setattr(main_module.settings, "deepgram_endpointing", legacy)


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
    assert response.segment_id == "55-1.250-speaker_1-1"
    assert response.start_time == 1.25
    assert response.end_time == 3.1
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


def test_stream_stt_chunk_returns_segment_level_fields(monkeypatch):
    _reset_state(monkeypatch)

    async def run_flow():
        return await main_module.stream_stt_chunk(
            meeting_id=146,
            audio_chunk=_make_upload_file(b"ghi"),
            seq=1,
            language="vi",
            is_final=False,
        )

    response = asyncio.run(run_flow())

    assert response.segment_id == "146-1.250-speaker_1-1"
    assert response.start_time == 1.25
    assert response.end_time == 2.5
    assert response.speaker == "SPEAKER_1"
    assert response.is_final is False


def test_stream_stt_chunk_partial_end_time_changes_with_stable_segment_id(monkeypatch):
    _reset_state(monkeypatch)

    async def run_first_chunk():
        return await main_module.stream_stt_chunk(
            meeting_id=147,
            audio_chunk=_make_upload_file(b"abc"),
            seq=1,
            language="vi",
            is_final=False,
        )

    async def run_second_chunk():
        return await main_module.stream_stt_chunk(
            meeting_id=147,
            audio_chunk=_make_upload_file(b"def"),
            seq=2,
            language="vi",
            is_final=False,
        )

    first = asyncio.run(run_first_chunk())
    second = asyncio.run(run_second_chunk())

    assert first.segment_id == second.segment_id
    assert first.end_time < second.end_time


def test_stream_stt_chunk_final_keeps_same_segment_id_as_partial(monkeypatch):
    _reset_state(monkeypatch)

    async def run_partial():
        return await main_module.stream_stt_chunk(
            meeting_id=148,
            audio_chunk=_make_upload_file(b"abc"),
            seq=1,
            language="vi",
            is_final=False,
        )

    async def run_final():
        return await main_module.stream_stt_chunk(
            meeting_id=148,
            audio_chunk=_make_upload_file(b"def"),
            seq=2,
            language="vi",
            is_final=True,
        )

    partial = asyncio.run(run_partial())
    final = asyncio.run(run_final())

    assert partial.segment_id == final.segment_id
    assert partial.is_final is False
    assert final.is_final is True


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


def test_open_stt_session_uses_configured_default_when_language_missing(monkeypatch):
    _reset_state(monkeypatch)
    monkeypatch.setattr(main_module.settings, "deepgram_language", "multi")
    monkeypatch.setattr(
        main_module,
        "pipeline",
        SimpleNamespace(speech_recognizer=FakeWhisperRecognizer()),
    )

    async def run_flow():
        return await main_module.open_stt_session({"meeting_id": "test-456"})

    response = asyncio.run(run_flow())

    assert response["language"] == "multi"
    assert FakeActor.instances[0].language == "multi"


def test_open_stt_session_falls_back_to_vi_for_invalid_language_and_invalid_default(
    monkeypatch,
):
    _reset_state(monkeypatch)
    monkeypatch.setattr(main_module.settings, "deepgram_language", "bogus")
    monkeypatch.setattr(
        main_module,
        "pipeline",
        SimpleNamespace(speech_recognizer=FakeWhisperRecognizer()),
    )

    async def run_flow():
        return await main_module.open_stt_session(
            {"meeting_id": "test-789", "language": "fr"}
        )

    response = asyncio.run(run_flow())

    assert response["language"] == "vi"
    assert FakeActor.instances[0].language == "vi"


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


def test_get_stt_adapter_prefers_realtime_model_over_base_model(monkeypatch):
    _reset_state(monkeypatch)
    monkeypatch.setattr(main_module.settings, "deepgram_model", "nova-2")
    monkeypatch.setattr(main_module.settings, "deepgram_realtime_model", "nova-3")
    main_module._stt_adapter = None

    adapter = main_module._get_stt_adapter()

    assert adapter is not None
    assert isinstance(adapter, FakeAdapter)
    assert adapter.model == "nova-3"


def test_get_stt_adapter_falls_back_to_base_model_when_realtime_missing(monkeypatch):
    _reset_state(monkeypatch)
    monkeypatch.setattr(main_module.settings, "deepgram_model", "nova-2")
    monkeypatch.setattr(main_module.settings, "deepgram_realtime_model", "")
    main_module._stt_adapter = None

    adapter = main_module._get_stt_adapter()

    assert adapter is not None
    assert isinstance(adapter, FakeAdapter)
    assert adapter.model == "nova-2"


@pytest.mark.parametrize(
    (
        "language",
        "endpointing_kwargs",
        "expected_endpointing",
        "expected_env",
    ),
    [
        (
            "vi",
            {"vi": "300", "default": "250", "legacy": "900"},
            300,
            "DEEPGRAM_REALTIME_ENDPOINTING_VI",
        ),
        (
            "multi",
            {"multi": "410", "default": "250", "legacy": "900"},
            410,
            "DEEPGRAM_REALTIME_ENDPOINTING_MULTI",
        ),
        (
            "en",
            {"en": "420", "default": "250", "legacy": "900"},
            420,
            "DEEPGRAM_REALTIME_ENDPOINTING_EN",
        ),
    ],
)
def test_stream_stt_chunk_uses_language_specific_endpointing(
    monkeypatch,
    language,
    endpointing_kwargs,
    expected_endpointing,
    expected_env,
):
    _reset_state(monkeypatch)
    capture_logger = _CaptureLogger()
    monkeypatch.setattr(main_module, "logger", capture_logger)
    _set_realtime_endpointing_settings(
        monkeypatch,
        default=endpointing_kwargs.get("default"),
        vi=endpointing_kwargs.get("vi"),
        en=endpointing_kwargs.get("en"),
        multi=endpointing_kwargs.get("multi"),
        legacy=endpointing_kwargs.get("legacy"),
    )

    async def run_flow():
        return await main_module.stream_stt_chunk(
            meeting_id=77,
            audio_chunk=_make_upload_file(b"abc"),
            seq=3,
            language=language,
            speaker_mode="single",
            is_final=False,
        )

    response = asyncio.run(run_flow())

    assert response.transcript == "Xin chao audiomind"
    assert FakeAdapter.instances[0].kwargs["endpointing"] == expected_endpointing
    log_line = next(
        message
        for message in capture_logger.messages
        if message.startswith("STT_STREAM_EFFECTIVE_CONFIG")
    )
    assert f"endpointing={expected_endpointing}" in log_line
    assert "endpointing_source=language_specific" in log_line
    assert f"endpointing_env={expected_env}" in log_line
    diagnostics_line = next(
        message
        for message in capture_logger.messages
        if message.startswith("event=REALTIME_STT_DIAGNOSTIC_CONFIG")
    )
    assert f"requestedLanguage={language}" in diagnostics_line
    assert f"effectiveLanguage={language}" in diagnostics_line
    assert f"deepgramLanguage={language}" in diagnostics_line
    assert f"endpointing={expected_endpointing}" in diagnostics_line


@pytest.mark.parametrize("language", ["vi", "en"])
def test_stream_stt_chunk_vi_en_ignore_multi_only_endpointing(monkeypatch, language):
    _reset_state(monkeypatch)
    capture_logger = _CaptureLogger()
    monkeypatch.setattr(main_module, "logger", capture_logger)
    _set_realtime_endpointing_settings(
        monkeypatch,
        default="250",
        multi="410",
        legacy="900",
    )

    async def run_flow():
        return await main_module.stream_stt_chunk(
            meeting_id=88,
            audio_chunk=_make_upload_file(b"xyz"),
            seq=8,
            language=language,
            speaker_mode="single",
            is_final=False,
        )

    response = asyncio.run(run_flow())

    assert response.transcript == "Xin chao audiomind"
    assert FakeAdapter.instances[0].kwargs["endpointing"] == 250
    log_line = next(
        message
        for message in capture_logger.messages
        if message.startswith("STT_STREAM_EFFECTIVE_CONFIG")
    )
    assert "endpointing=250" in log_line
    assert "endpointing_source=realtime_default" in log_line
    assert "endpointing_env=DEEPGRAM_REALTIME_ENDPOINTING_DEFAULT" in log_line


def test_stream_stt_chunk_uses_realtime_default_then_legacy_fallback(monkeypatch):
    _reset_state(monkeypatch)
    capture_logger = _CaptureLogger()
    monkeypatch.setattr(main_module, "logger", capture_logger)
    _set_realtime_endpointing_settings(
        monkeypatch,
        default="250",
        legacy="900",
    )

    async def run_flow():
        return await main_module.stream_stt_chunk(
            meeting_id=78,
            audio_chunk=_make_upload_file(b"def"),
            seq=4,
            language="vi",
            speaker_mode="single",
            is_final=False,
        )

    response = asyncio.run(run_flow())

    assert response.transcript == "Xin chao audiomind"
    assert FakeAdapter.instances[0].kwargs["endpointing"] == 250
    log_line = next(
        message
        for message in capture_logger.messages
        if message.startswith("STT_STREAM_EFFECTIVE_CONFIG")
    )
    assert "endpointing=250" in log_line
    assert "endpointing_source=realtime_default" in log_line
    assert "endpointing_env=DEEPGRAM_REALTIME_ENDPOINTING_DEFAULT" in log_line

    _reset_state(monkeypatch)
    capture_logger = _CaptureLogger()
    monkeypatch.setattr(main_module, "logger", capture_logger)
    _set_realtime_endpointing_settings(monkeypatch, legacy="400")

    async def run_legacy_flow():
        return await main_module.stream_stt_chunk(
            meeting_id=79,
            audio_chunk=_make_upload_file(b"ghi"),
            seq=5,
            language="en",
            speaker_mode="single",
            is_final=False,
        )

    legacy_response = asyncio.run(run_legacy_flow())

    assert legacy_response.transcript == "Xin chao audiomind"
    assert FakeAdapter.instances[0].kwargs["endpointing"] == 400
    log_line = next(
        message
        for message in capture_logger.messages
        if message.startswith("STT_STREAM_EFFECTIVE_CONFIG")
    )
    assert "endpointing=400" in log_line
    assert "endpointing_source=legacy_global" in log_line
    assert "endpointing_env=DEEPGRAM_ENDPOINTING" in log_line


def test_stream_stt_chunk_falls_back_safely_for_invalid_endpointing(monkeypatch):
    _reset_state(monkeypatch)
    capture_logger = _CaptureLogger()
    monkeypatch.setattr(main_module, "logger", capture_logger)
    _set_realtime_endpointing_settings(
        monkeypatch,
        vi="bad-value",
        default="250",
        legacy="900",
    )

    async def run_flow():
        return await main_module.stream_stt_chunk(
            meeting_id=80,
            audio_chunk=_make_upload_file(b"jkl"),
            seq=6,
            language="vi",
            speaker_mode="single",
            is_final=False,
        )

    response = asyncio.run(run_flow())

    assert response.transcript == "Xin chao audiomind"
    assert FakeAdapter.instances[0].kwargs["endpointing"] == 250
    assert any(
        message.startswith("STT_STREAM_ENDPOINTING_INVALID")
        and "env=DEEPGRAM_REALTIME_ENDPOINTING_VI" in message
        for message in capture_logger.messages
    )
    log_line = next(
        message
        for message in capture_logger.messages
        if message.startswith("STT_STREAM_EFFECTIVE_CONFIG")
    )
    assert "endpointing=250" in log_line
    assert "endpointing_source=invalid_fallback" in log_line
    assert "endpointing_env=DEEPGRAM_REALTIME_ENDPOINTING_DEFAULT" in log_line


def test_stream_stt_chunk_omits_endpointing_when_all_values_invalid(monkeypatch):
    _reset_state(monkeypatch)
    capture_logger = _CaptureLogger()
    monkeypatch.setattr(main_module, "logger", capture_logger)
    _set_realtime_endpointing_settings(
        monkeypatch,
        default="nope",
        legacy="-1",
    )

    async def run_flow():
        return await main_module.stream_stt_chunk(
            meeting_id=81,
            audio_chunk=_make_upload_file(b"mno"),
            seq=7,
            language="multi",
            speaker_mode="single",
            is_final=False,
        )

    response = asyncio.run(run_flow())

    assert response.transcript == "Xin chao audiomind"
    assert FakeAdapter.instances[0].kwargs["endpointing"] is None
    assert any(
        message.startswith("STT_STREAM_ENDPOINTING_INVALID")
        and "env=DEEPGRAM_REALTIME_ENDPOINTING_DEFAULT" in message
        for message in capture_logger.messages
    )
    assert any(
        message.startswith("STT_STREAM_ENDPOINTING_INVALID")
        and "env=DEEPGRAM_ENDPOINTING" in message
        for message in capture_logger.messages
    )
    log_line = next(
        message
        for message in capture_logger.messages
        if message.startswith("STT_STREAM_EFFECTIVE_CONFIG")
    )
    assert "endpointing=omitted" in log_line
    assert "endpointing_source=invalid_fallback" in log_line
    assert "endpointing_env=omitted" in log_line


def test_resolve_effective_diarize_keeps_single_and_multiple_mapping():
    assert main_module._resolve_effective_diarize("single") is False
    assert main_module._resolve_effective_diarize("multiple") is True


@pytest.mark.parametrize("language", ["vi", "en", "multi"])
def test_open_stt_session_preserves_supported_languages(monkeypatch, language):
    _reset_state(monkeypatch)

    async def run_flow():
        return await main_module.open_stt_session(
            {"meeting_id": f"test-{language}", "language": language}
        )

    response = asyncio.run(run_flow())

    assert response["language"] == language
    assert FakeActor.instances[0].language == language


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


def test_get_transcript_returns_canonical_rows_when_sidecar_is_valid(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    db = SessionLocal()

    try:
        meeting_id = 125
        first = Transcript(
            meeting_id=meeting_id,
            speaker="SPEAKER_1",
            start_time=1.0,
            end_time=1.5,
            text="Vocabulary",
        )
        second = Transcript(
            meeting_id=meeting_id,
            speaker="SPEAKER_2",
            start_time=1.8,
            end_time=2.5,
            text="is a nightmare.",
        )
        third = Transcript(
            meeting_id=meeting_id,
            speaker="SPEAKER_1",
            start_time=4.0,
            end_time=5.0,
            text="Independent sentence.",
        )
        db.add(first)
        db.add(second)
        db.add(third)
        db.flush()

        canonical = canonicalize_segments(
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
                {
                    "speaker": "SPEAKER_1",
                    "start_time": 4.0,
                    "end_time": 5.0,
                    "text": "Independent sentence.",
                },
            ]
        )
        first.raw_transcript_hash = canonical.raw_hash
        first.canonical_transcript_rows = canonical.rows
        first.canonical_transcript_version = canonical.version
        first.canonical_transcript_hash = canonical.canonical_hash
        first.canonical_generated_at = datetime(
            2026, 6, 1, 10, 0, 0, tzinfo=timezone.utc
        )
        db.commit()

        monkeypatch.setattr(main_module, "pipeline", None)

        async def run_flow():
            return await main_module.get_transcript(meeting_id, db=db)

        response = asyncio.run(run_flow())

        assert response.meeting_id == meeting_id
        assert response.transcriptMode == "canonical"
        assert response.canonicalTranscriptVersion == canonical.version
        assert response.canonicalTranscriptHash == canonical.canonical_hash
        assert response.rawTranscripts is not None
        assert len(response.transcripts) < len(response.rawTranscripts)
        assert [segment.text for segment in response.transcripts] == [
            "Vocabulary is a nightmare.",
            "Independent sentence.",
        ]
        assert [segment.text for segment in response.rawTranscripts] == [
            "Vocabulary",
            "is a nightmare.",
            "Independent sentence.",
        ]
    finally:
        db.close()
        engine.dispose()


def test_get_transcript_falls_back_to_raw_when_canonical_sidecar_absent(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    db = SessionLocal()

    try:
        meeting_id = 126
        db.add(
            Transcript(
                meeting_id=meeting_id,
                speaker="SPEAKER_1",
                start_time=1.0,
                end_time=2.0,
                text="raw row one",
            )
        )
        db.add(
            Transcript(
                meeting_id=meeting_id,
                speaker="SPEAKER_2",
                start_time=2.2,
                end_time=3.3,
                text="raw row two",
            )
        )
        db.commit()

        monkeypatch.setattr(main_module, "pipeline", None)

        async def run_flow():
            return await main_module.get_transcript(meeting_id, db=db)

        response = asyncio.run(run_flow())

        assert response.meeting_id == meeting_id
        assert response.transcriptMode == "raw"
        assert response.rawTranscripts is None
        assert response.canonicalTranscriptVersion is None
        assert [segment.text for segment in response.transcripts] == [
            "raw row one",
            "raw row two",
        ]
    finally:
        db.close()
        engine.dispose()
