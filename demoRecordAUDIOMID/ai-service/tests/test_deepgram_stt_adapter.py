import asyncio
import json

from app.services.stt_adapter import DeepgramSTTAdapter, STTStreamAdapter


class _FakeWebSocket:
    def __init__(self, messages):
        self.sent_messages = []
        self.messages = list(messages)
        self.closed = False

    async def send(self, payload):
        self.sent_messages.append(payload)

    async def recv(self):
        if self.messages:
            return self.messages.pop(0)
        raise asyncio.TimeoutError

    async def close(self):
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
