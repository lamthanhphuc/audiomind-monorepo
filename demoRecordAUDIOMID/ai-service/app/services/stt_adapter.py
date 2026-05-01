from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable
from uuid import uuid4

import httpx
from loguru import logger


@runtime_checkable
class STTStreamAdapter(Protocol):
    async def open_session(self, meeting_id: int, language: str) -> str: ...

    async def push_audio_chunk(
        self, session_id: str, pcm_chunk: bytes, ts_ms: int
    ) -> None: ...

    async def close_session(self, session_id: str) -> None: ...


@dataclass
class _SessionBuffer:
    meeting_id: int
    language: str
    chunks: list[bytes] = field(default_factory=list)
    timestamps_ms: list[int] = field(default_factory=list)
    transcript: str = ""
    raw_response: dict[str, Any] | None = None


class DeepgramSTTAdapter:
    """Buffer audio chunks and submit them to Deepgram for transcription."""

    def __init__(
        self,
        api_key: str,
        model: str = "nova-2",
        base_url: str = "https://api.deepgram.com/v1/listen",
        timeout_seconds: int = 30,
        sample_rate: int = 16000,
    ) -> None:
        self.api_key = (api_key or "").strip()
        self.model = (model or "nova-2").strip() or "nova-2"
        self.base_url = (base_url or "https://api.deepgram.com/v1/listen").rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.sample_rate = sample_rate
        self._sessions: dict[str, _SessionBuffer] = {}

        if not self.api_key:
            logger.warning(
                "Deepgram API key is empty; transcription calls will fail until configured."
            )

    async def open_session(self, meeting_id: int, language: str) -> str:
        session_id = uuid4().hex
        self._sessions[session_id] = _SessionBuffer(
            meeting_id=meeting_id,
            language=(language or "vi").strip() or "vi",
        )
        return session_id

    async def push_audio_chunk(
        self, session_id: str, pcm_chunk: bytes, ts_ms: int
    ) -> None:
        session = self._get_session(session_id)
        session.chunks.append(bytes(pcm_chunk or b""))
        session.timestamps_ms.append(int(ts_ms))

    async def close_session(self, session_id: str) -> None:
        session = self._get_session(session_id)
        session.raw_response = await self._transcribe_buffer(session)
        session.transcript = self._extract_transcript(session.raw_response)

    def get_transcript(self, session_id: str) -> str:
        session = self._get_session(session_id)
        return session.transcript

    def get_raw_response(self, session_id: str) -> dict[str, Any] | None:
        session = self._get_session(session_id)
        return session.raw_response

    def _get_session(self, session_id: str) -> _SessionBuffer:
        try:
            return self._sessions[session_id]
        except KeyError as exc:
            raise KeyError(f"Unknown STT session: {session_id}") from exc

    async def _transcribe_buffer(self, session: _SessionBuffer) -> dict[str, Any]:
        if not session.chunks:
            return {}

        audio_payload = b"".join(session.chunks)
        headers = {
            "Authorization": f"Token {self.api_key}",
            "Content-Type": (
                f"audio/raw; encoding=linear16; sample_rate={self.sample_rate}; channels=1"
            ),
        }
        params = {
            "model": self.model,
            "language": session.language,
            "punctuate": "true",
            "smart_format": "true",
            "utterances": "true",
        }

        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            response = await client.post(
                self.base_url,
                params=params,
                content=audio_payload,
                headers=headers,
            )
            response.raise_for_status()
            return response.json()

    def _extract_transcript(self, payload: dict[str, Any] | None) -> str:
        if not payload:
            return ""

        results = payload.get("results") or {}
        channels = results.get("channels") or []
        if not channels:
            return ""

        alternatives = channels[0].get("alternatives") or []
        if not alternatives:
            return ""

        return str(alternatives[0].get("transcript") or "").strip()
