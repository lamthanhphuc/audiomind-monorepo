import asyncio

from app.services.stt_adapter import DeepgramSTTAdapter, STTStreamAdapter


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _FakeAsyncClient:
    last_request = None

    def __init__(self, timeout=None):
        self.timeout = timeout

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def post(self, url, params=None, content=None, headers=None):
        _FakeAsyncClient.last_request = {
            "url": url,
            "params": params,
            "content": content,
            "headers": headers,
            "timeout": self.timeout,
        }
        return _FakeResponse(
            {
                "results": {
                    "channels": [
                        {"alternatives": [{"transcript": "xin chao audiomind"}]}
                    ]
                }
            }
        )


def test_deepgram_adapter_matches_protocol_and_transcribes(monkeypatch):
    from app.services import stt_adapter as stt_module

    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _FakeAsyncClient)

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
    assert _FakeAsyncClient.last_request["url"] == "https://api.deepgram.com/v1/listen"
    assert _FakeAsyncClient.last_request["params"]["language"] == "vi"
    assert _FakeAsyncClient.last_request["params"]["model"] == "nova-2"
    assert _FakeAsyncClient.last_request["content"] == b"abcdef"
    assert (
        _FakeAsyncClient.last_request["headers"]["Authorization"] == "Token dg-test-key"
    )
