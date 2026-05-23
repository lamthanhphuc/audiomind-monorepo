import asyncio
from typing import Any, Dict, List


class FakeAdapter:
    def __init__(self, behavior: Dict[str, Any] | None = None):
        self._behavior = behavior or {}
        self.sessions: Dict[str, Dict[str, Any]] = {}

    async def open_session(self, meeting_id: int | str, language: str, diarize: bool | None = None) -> str:
        sid = f"fake-{meeting_id}-{language}-{len(self.sessions)+1}"
        self.sessions[sid] = {"sent": [], "closed": False}
        if self._behavior.get("open_fail"):
            raise RuntimeError("open_failed")
        return sid

    async def send_audio_chunk(self, session_id: str, chunk: bytes) -> None:
        sess = self.sessions.get(session_id)
        if sess is None:
            raise RuntimeError("session_missing")
        # simulate occasional terminal or transient errors
        if self._behavior.get("send_terminal"):
            raise RuntimeError("terminal_send")
        if self._behavior.get("send_transient"):
            raise Exception("transient_send")
        sess["sent"].append(chunk)

    async def recv_transcript_events(
        self, session_id: str, ts_ms: int, drain_timeout: float = 1.0
    ):
        # Simulate delayed transcripts
        sess = self.sessions.get(session_id)
        if sess is None:
            raise RuntimeError("session_missing")
        await asyncio.sleep(self._behavior.get("recv_delay", 0))
        if self._behavior.get("recv_none"):
            return []
        # produce a simple transcript event per send
        events: List[dict] = []
        sent = sess.get("sent", [])
        if sent:
            seq_text = f"chunk{len(sent)}"
            events.append(
                {
                    "text": seq_text,
                    "is_final": False,
                    "ts_ms": ts_ms,
                    "event_id": f"evt-{len(sent)}",
                }
            )
        return events

    async def push_audio_chunk(
        self,
        session_id: str,
        pcm_chunk: bytes,
        ts_ms: int,
        seq: int | None = None,
        drain_transcript: bool = True,
    ) -> None:
        await self.send_audio_chunk(session_id, pcm_chunk)
        if drain_transcript:
            await self.recv_transcript_events(session_id, ts_ms)

    async def close_session(self, session_id: str) -> None:
        sess = self.sessions.get(session_id)
        if sess is None:
            return
        sess["closed"] = True

    def drain_partial_events(self, session_id: str):
        sess = self.sessions.get(session_id) or {}
        sent = sess.get("sent", [])
        if sent:
            return [
                {
                    "text": f"chunk{len(sent)}",
                    "is_final": False,
                    "event_id": f"evt-{len(sent)}",
                }
            ]
        return []

    def get_raw_response(self, session_id: str):
        return {
            "session_id": session_id,
            "sent_count": len(self.sessions.get(session_id, {}).get("sent", [])),
        }
