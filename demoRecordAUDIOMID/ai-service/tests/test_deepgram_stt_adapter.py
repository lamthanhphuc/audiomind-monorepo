import asyncio
import json
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import pytest

from app.services.stt_adapter import (
    DeepgramSTTAdapter,
    STTStreamAdapter,
    is_terminal_error,
    is_transient_error,
)


class FakeConnectionClosedError(Exception):
    pass


class _FakeWebSocket:
    def __init__(self, messages):
        self.sent_messages = []
        self.messages = list(messages)
        self.closed = False
        self.close_calls = 0

    async def send(self, payload):
        self.sent_messages.append(payload)

    async def recv(self):
        if self.messages:
            return self.messages.pop(0)
        raise asyncio.TimeoutError

    async def close(self):
        self.close_calls += 1
        self.closed = True


class _FakeWebSocketModule:
    last_connection = None

    def __init__(self, messages):
        self.messages = messages

    async def connect(
        self,
        url,
        extra_headers=None,
        open_timeout=None,
        close_timeout=None,
        ping_interval=None,
    ):
        websocket = _FakeWebSocket(self.messages)
        _FakeWebSocketModule.last_connection = {
            "url": url,
            "extra_headers": extra_headers,
            "open_timeout": open_timeout,
            "close_timeout": close_timeout,
            "ping_interval": ping_interval,
            "websocket": websocket,
        }
        return websocket


def test_deepgram_adapter_matches_protocol_and_transcribes(monkeypatch):
    from app.services import stt_adapter as stt_module

    websocket_messages = [
        json.dumps(
            {
                "channel": {
                    "alternatives": [{"transcript": "xin chao", "confidence": 0.9}]
                },
                "is_final": False,
            }
        ),
        json.dumps(
            {
                "channel": {
                    "alternatives": [
                        {"transcript": "xin chao audiomind", "confidence": 0.97}
                    ]
                },
                "is_final": True,
            }
        ),
    ]
    monkeypatch.setattr(
        stt_module, "websockets", _FakeWebSocketModule(websocket_messages)
    )

    adapter = DeepgramSTTAdapter(
        api_key="dg-test-key",
        model="nova-2",
        base_url="https://api.deepgram.com/v1/listen",
        timeout_seconds=12,
        sample_rate=16000,
    )

    assert isinstance(adapter, STTStreamAdapter)

    async def run_flow():
        session_id = await adapter.open_session(meeting_id=101, language="vi")
        await adapter.push_audio_chunk(session_id, b"abc", 10)
        await adapter.push_audio_chunk(session_id, b"def", 20)
        await adapter.close_session(session_id)
        return session_id

    session_id = asyncio.run(run_flow())

    assert adapter.get_transcript(session_id) == "xin chao audiomind"
    assert adapter.get_raw_response(session_id)["closed"] is True

    connection = _FakeWebSocketModule.last_connection
    assert connection["url"].startswith("wss://api.deepgram.com/v1/listen")
    assert "language=vi" in connection["url"]
    assert "model=nova-2" in connection["url"]
    assert connection["extra_headers"] == [("Authorization", "Token dg-test-key")]
    assert connection["websocket"].sent_messages == [b"abc", b"def"]


def test_deepgram_error_classification_helpers():
    assert is_transient_error(TimeoutError("send timed out")) is True
    assert is_terminal_error(FakeConnectionClosedError("websocket closed")) is True
    assert is_transient_error(FakeConnectionClosedError("websocket closed")) is False


def test_deepgram_close_session_is_idempotent(monkeypatch):
    from app.services import stt_adapter as stt_module

    websocket_messages = [
        json.dumps(
            {
                "channel": {
                    "alternatives": [{"transcript": "xin chao", "confidence": 0.9}]
                },
                "is_final": True,
            }
        ),
    ]
    monkeypatch.setattr(
        stt_module, "websockets", _FakeWebSocketModule(websocket_messages)
    )

    adapter = DeepgramSTTAdapter(
        api_key="dg-test-key",
        model="nova-2",
        base_url="https://api.deepgram.com/v1/listen",
        timeout_seconds=12,
        sample_rate=16000,
    )

    async def run_flow():
        session_id = await adapter.open_session(meeting_id=202, language="vi")
        await adapter.push_audio_chunk(session_id, b"abc", 10)
        await adapter.close_session(session_id)
        await adapter.close_session(session_id)
        return session_id

    session_id = asyncio.run(run_flow())

    connection = _FakeWebSocketModule.last_connection
    assert connection["websocket"].close_calls == 1
    assert adapter.get_raw_response(session_id)["closed"] is True
    assert session_id not in adapter._sessions


def test_deepgram_results_payload_logs_text_len_and_parses(monkeypatch):
    from app.services import stt_adapter as stt_module

    logged = []
    monkeypatch.setattr(
        stt_module,
        "logger",
        SimpleNamespace(
            info=lambda message, *args: logged.append((message, args)),
            warning=lambda *args, **kwargs: None,
            exception=lambda *args, **kwargs: None,
        ),
    )

    adapter = DeepgramSTTAdapter(api_key="dg-test-key")
    event = adapter._parse_transcript_message(
        {
            "type": "Results",
            "channel": {
                "alternatives": [
                    {"transcript": "xin chao tu deepgram", "confidence": 0.88}
                ]
            },
            "speech_final": True,
            "is_final": True,
        },
        ts_ms=42,
    )

    assert event is not None
    assert event["text"] == "xin chao tu deepgram"
    assert event["confidence"] == 0.88
    assert event["is_final"] is True
    results_logs = [
        item for item in logged if item[0].startswith("DG RAW EVENT Results")
    ]
    assert results_logs
    assert "text_len={}" in results_logs[0][0]
    assert len("xin chao tu deepgram") in results_logs[0][1]


def test_deepgram_results_payload_extracts_timing_and_segment_identity():
    adapter = DeepgramSTTAdapter(api_key="dg-test-key")

    event = adapter._parse_transcript_message(
        {
            "type": "Results",
            "channel": {
                "alternatives": [
                    {
                        "transcript": "xin chao tu deepgram",
                        "confidence": 0.88,
                        "start": 12.85,
                        "duration": 2.21,
                    }
                ]
            },
            "speech_final": True,
            "is_final": True,
        },
        ts_ms=42,
    )

    assert event is not None
    assert event["text"] == "xin chao tu deepgram"
    assert event["is_final"] is True
    assert event["start_time"] == pytest.approx(12.85)
    assert event["end_time"] == pytest.approx(15.06)
    assert event["end_time"] >= event["start_time"]
    assert event["segment_id"] == "meeting-0-start-12.850"


def test_deepgram_results_payload_never_returns_end_before_start():
    adapter = DeepgramSTTAdapter(api_key="dg-test-key")

    event = adapter._parse_transcript_message(
        {
            "type": "Results",
            "channel": {
                "alternatives": [
                    {
                        "transcript": "xin chao tu deepgram",
                        "confidence": 0.88,
                        "start": 9.4,
                    }
                ]
            },
            "speech_final": False,
            "is_final": False,
        },
        ts_ms=42,
    )

    assert event is not None
    assert event["start_time"] == pytest.approx(9.4)
    assert event["end_time"] == pytest.approx(9.4)
    assert event["end_time"] >= event["start_time"]


def test_deepgram_simplified_streaming_url_disables_optional_params():
    adapter = DeepgramSTTAdapter(
        api_key="dg-test-key",
        model="nova-2",
        base_url="https://api.deepgram.com/v1/listen",
        simplify_streaming_url=True,
    )

    query = parse_qs(urlparse(adapter._build_websocket_url("vi")).query)

    assert query["model"] == ["nova-2"]
    assert query["language"] == ["vi"]
    assert query["interim_results"] == ["true"]
    assert query["container"] == ["webm"]
    assert "utterances" not in query
    assert "smart_format" not in query


def test_deepgram_raw_message_preview_is_debug_gated(monkeypatch):
    from app.services import stt_adapter as stt_module

    logged = []
    monkeypatch.setattr(
        stt_module,
        "logger",
        SimpleNamespace(
            info=lambda message, *args: logged.append((message, args)),
            warning=lambda *args, **kwargs: None,
            exception=lambda *args, **kwargs: None,
        ),
    )

    adapter = DeepgramSTTAdapter(api_key="dg-test-key")
    adapter._log_raw_message("session-1", '{"type":"Results"}')
    assert logged == []

    debug_adapter = DeepgramSTTAdapter(
        api_key="dg-test-key",
        debug_raw_messages=True,
    )
    debug_adapter._log_raw_message("session-1", '{"type":"Results"}')

    assert logged
    assert logged[0][0] == "DG RAW MESSAGE session_id={} len={} preview={}"
