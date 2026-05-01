from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from uuid import uuid4

from loguru import logger

try:
    import websockets
except ImportError:  # pragma: no cover - import is validated by runtime tests
    websockets = None


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
    websocket: Any | None = None
    chunks: list[bytes] = field(default_factory=list)
    timestamps_ms: list[int] = field(default_factory=list)
    partial_events: list[dict[str, Any]] = field(default_factory=list)
    transcript: str = ""
    latest_partial: str = ""
    raw_response: dict[str, Any] | None = None
    closed: bool = False


class DeepgramSTTAdapter:
    """Stream audio chunks to Deepgram and collect partial transcripts."""

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
        session = _SessionBuffer(
            meeting_id=meeting_id,
            language=(language or "vi").strip() or "vi",
        )
        self._sessions[session_id] = session
        session.websocket = await self._connect_session(session)
        return session_id

    async def push_audio_chunk(
        self, session_id: str, pcm_chunk: bytes, ts_ms: int
    ) -> None:
        session = self._get_session(session_id)
        session.chunks.append(bytes(pcm_chunk or b""))
        session.timestamps_ms.append(int(ts_ms))

        if not session.websocket:
            raise RuntimeError("Deepgram session is not connected")

        await self._send_audio_chunk(session.websocket, pcm_chunk)
        session.partial_events.extend(
            await self._drain_transcript_events(session, ts_ms=ts_ms)
        )

    async def close_session(self, session_id: str) -> None:
        session = self._get_session(session_id)
        if session.websocket and not session.closed:
            session.partial_events.extend(
                await self._drain_transcript_events(
                    session,
                    ts_ms=session.timestamps_ms[-1] if session.timestamps_ms else 0,
                    drain_timeout=self.timeout_seconds,
                )
            )
            try:
                await session.websocket.close()
            finally:
                session.closed = True
                session.websocket = None

        if not session.transcript and session.latest_partial:
            session.transcript = session.latest_partial

        session.raw_response = {
            "transcript": session.transcript,
            "partials": list(session.partial_events),
            "closed": session.closed,
        }

    def get_transcript(self, session_id: str) -> str:
        session = self._get_session(session_id)
        return session.transcript

    def drain_partial_events(self, session_id: str) -> list[dict[str, Any]]:
        session = self._get_session(session_id)
        events = list(session.partial_events)
        session.partial_events.clear()
        return events

    def get_raw_response(self, session_id: str) -> dict[str, Any] | None:
        session = self._get_session(session_id)
        return session.raw_response

    def _get_session(self, session_id: str) -> _SessionBuffer:
        try:
            return self._sessions[session_id]
        except KeyError as exc:
            raise KeyError(f"Unknown STT session: {session_id}") from exc

    async def _connect_session(self, session: _SessionBuffer) -> Any:
        if websockets is None:
            raise RuntimeError(
                "websockets package is required for Deepgram streaming support"
            )

        connection_url = self._build_websocket_url(session.language)
        headers = [("Authorization", f"Token {self.api_key}")]

        last_error: Exception | None = None
        for attempt in range(1, 4):
            try:
                return await asyncio.wait_for(
                    websockets.connect(  # type: ignore[attr-defined]
                        connection_url,
                        extra_headers=headers,
                        open_timeout=self.timeout_seconds,
                        close_timeout=self.timeout_seconds,
                        ping_interval=None,
                    ),
                    timeout=self.timeout_seconds,
                )
            except Exception as exc:  # pragma: no cover - exercised via tests
                last_error = exc
                if attempt >= 3:
                    break
                await asyncio.sleep(min(0.25 * attempt, 1.0))

        raise RuntimeError("Failed to connect to Deepgram WebSocket") from last_error

    async def _send_audio_chunk(self, websocket: Any, pcm_chunk: bytes) -> None:
        try:
            await asyncio.wait_for(
                websocket.send(bytes(pcm_chunk or b"")), timeout=self.timeout_seconds
            )
        except Exception as exc:  # pragma: no cover - exercised via tests
            raise RuntimeError("Failed to send audio chunk to Deepgram") from exc

    async def _drain_transcript_events(
        self,
        session: _SessionBuffer,
        ts_ms: int,
        drain_timeout: float | None = None,
    ) -> list[dict[str, Any]]:
        websocket = session.websocket
        if websocket is None:
            return []

        timeout_seconds = self.timeout_seconds if drain_timeout is None else drain_timeout
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        events: list[dict[str, Any]] = []

        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                break

            try:
                raw_message = await asyncio.wait_for(websocket.recv(), timeout=remaining)
            except (asyncio.TimeoutError, TimeoutError):
                break
            except Exception as exc:
                if session.closed:
                    break
                raise RuntimeError("Deepgram WebSocket receive failed") from exc

            event = self._parse_transcript_message(raw_message, ts_ms=ts_ms)
            if event is None:
                continue

            events.append(event)
            if event.get("is_final"):
                session.transcript = self._merge_transcript(
                    session.transcript,
                    event["text"],
                )
            else:
                session.latest_partial = event["text"]

        return events

    def _build_websocket_url(self, language: str) -> str:
        normalized = self.base_url
        if normalized.startswith("https://"):
            normalized = "wss://" + normalized[len("https://") :]
        elif normalized.startswith("http://"):
            normalized = "ws://" + normalized[len("http://") :]
        elif not normalized.startswith(("ws://", "wss://")):
            normalized = f"wss://{normalized.lstrip('/')}"

        parsed = urlparse(normalized)
        query_pairs = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query_pairs.update(
            {
                "model": self.model,
                "language": language,
                "encoding": "linear16",
                "sample_rate": str(self.sample_rate),
                "channels": "1",
                "punctuate": "true",
                "smart_format": "true",
                "interim_results": "true",
                "utterances": "true",
            }
        )
        query = urlencode(query_pairs)
        return urlunparse(parsed._replace(query=query))

    def _parse_transcript_message(
        self, raw_message: Any, ts_ms: int
    ) -> dict[str, Any] | None:
        if isinstance(raw_message, bytes):
            try:
                raw_message = raw_message.decode("utf-8")
            except UnicodeDecodeError:
                return None

        if isinstance(raw_message, str):
            try:
                payload = json.loads(raw_message)
            except json.JSONDecodeError:
                return None
        elif isinstance(raw_message, dict):
            payload = raw_message
        else:
            return None

        transcript, confidence = self._extract_transcript(payload)
        if not transcript:
            return None

        is_final = bool(payload.get("is_final") or payload.get("speech_final"))
        return {
            "text": transcript,
            "confidence": confidence,
            "is_final": is_final,
            "ts_ms": ts_ms,
            "raw": payload,
        }

    def _extract_transcript(self, payload: dict[str, Any]) -> tuple[str, float | None]:
        channels: list[dict[str, Any]] = []

        results = payload.get("results")
        if isinstance(results, dict):
            channels = list(results.get("channels") or [])

        if not channels:
            channel = payload.get("channel")
            if isinstance(channel, dict):
                channels = [channel]

        for channel in channels:
            alternatives = channel.get("alternatives") or []
            if not alternatives:
                continue

            alternative = alternatives[0] or {}
            transcript = str(alternative.get("transcript") or "").strip()
            if not transcript:
                continue

            confidence_raw = alternative.get("confidence")
            confidence = (
                float(confidence_raw)
                if isinstance(confidence_raw, (int, float))
                else None
            )
            return transcript, confidence

        return "", None

    def _merge_transcript(self, current: str, next_text: str) -> str:
        current_text = (current or "").strip()
        incoming_text = (next_text or "").strip()

        if not current_text:
            return incoming_text

        if not incoming_text:
            return current_text

        if incoming_text == current_text or incoming_text.startswith(current_text):
            return incoming_text

        if current_text.endswith(incoming_text):
            return current_text

        return f"{current_text} {incoming_text}".strip()
