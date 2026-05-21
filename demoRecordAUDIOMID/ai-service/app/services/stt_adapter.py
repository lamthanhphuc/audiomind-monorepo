from __future__ import annotations

import asyncio
import json
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from uuid import uuid4

from loguru import logger

try:
    import websockets
except ImportError:  # pragma: no cover - import is validated by runtime tests
    websockets = None

try:
    import httpx
except ImportError:  # pragma: no cover
    httpx = None


_TERMINAL_ERROR_NAME_HINTS = (
    "ConnectionClosed",
    "WebSocketClosed",
    "InvalidState",
)


def _iter_exception_chain(exc: BaseException):
    seen: set[int] = set()
    current: BaseException | None = exc

    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def is_terminal_error(exc: BaseException) -> bool:
    """Return True when the websocket/session is no longer usable."""

    for cause in _iter_exception_chain(exc):
        name = type(cause).__name__
        text = f"{name} {cause}".lower()
        code = getattr(cause, "code", None)

        if isinstance(code, (int, float)) and int(code) >= 1000:
            return True
        if isinstance(code, str) and code.isdigit() and int(code) >= 1000:
            return True

        if any(hint.lower() in text for hint in _TERMINAL_ERROR_NAME_HINTS):
            return True

        if "1011" in text or "net0001" in text:
            return True

        if "invalid websocket" in text or "invalid session" in text:
            return True

        if "unknown stt session" in text or "deepgram session is not connected" in text:
            return True

        if "websocket is closed" in text or "websocket closed" in text:
            return True

        if name in {"ConnectionClosed", "ConnectionClosedError", "ConnectionClosedOK"}:
            return True

    return False


def is_transient_error(exc: BaseException) -> bool:
    """Return True when the failure can be retried on the same websocket."""

    if is_terminal_error(exc):
        return False

    for cause in _iter_exception_chain(exc):
        if isinstance(
            cause, (TimeoutError, asyncio.TimeoutError, ConnectionError, OSError)
        ):
            return True

        message = f"{type(cause).__name__} {cause}".lower()
        if "failed to send audio chunk to deepgram" in message:
            return True
        if "timed out" in message or "timeout" in message:
            return True
        if "temporary" in message or "backpressure" in message or "stall" in message:
            return True

    return False


@runtime_checkable
class STTStreamAdapter(Protocol):
    async def open_session(self, meeting_id: int, language: str) -> str: ...

    async def send_audio_chunk(
        self, session_id: str, pcm_chunk: bytes, seq: int | None = None
    ) -> None: ...

    async def recv_transcript_events(
        self, session_id: str, ts_ms: int, drain_timeout: float | None = None
    ) -> list[dict[str, Any]]: ...

    async def push_audio_chunk(
        self,
        session_id: str,
        pcm_chunk: bytes,
        ts_ms: int,
        seq: int | None = None,
        drain_transcript: bool = True,
    ) -> None: ...

    async def close_session(self, session_id: str) -> None: ...


@dataclass
class _SessionBuffer:
    session_id: str
    meeting_id: int
    language: str
    websocket: Any | None = None
    state_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    recv_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    chunks: list[bytes] = field(default_factory=list)
    timestamps_ms: list[int] = field(default_factory=list)
    partial_events: list[dict[str, Any]] = field(default_factory=list)
    transcript: str = ""
    latest_partial: str = ""
    raw_response: dict[str, Any] | None = None
    closed: bool = False
    last_activity_at: float = field(default_factory=time.time)
    metadata_events: int = 0
    results_events: int = 0
    speech_started_events: int = 0
    utterance_end_events: int = 0
    other_events: int = 0


class DeepgramSTTAdapter:
    """Stream audio chunks to Deepgram and collect partial transcripts."""

    CLOSED_RESPONSE_CACHE_MAX_ITEMS = 256
    KEEPALIVE_AFTER_IDLE_SECONDS = 15.0

    def __init__(
        self,
        api_key: str,
        model: str = "nova-2",
        base_url: str = "https://api.deepgram.com/v1/listen",
        timeout_seconds: int = 30,
        sample_rate: int = 16000,
        simplify_streaming_url: bool = False,
        debug_raw_messages: bool = False,
    ) -> None:
        self.api_key = (api_key or "").strip()
        self.model = (model or "nova-2").strip() or "nova-2"
        self.base_url = (base_url or "https://api.deepgram.com/v1/listen").rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.sample_rate = sample_rate
        self.simplify_streaming_url = bool(simplify_streaming_url)
        self.debug_raw_messages = bool(debug_raw_messages)
        self._sessions: dict[str, _SessionBuffer] = {}
        self._closed_responses: OrderedDict[str, dict[str, Any]] = OrderedDict()
        # Don't force an encoding; frontend sends webm/opus and Deepgram will infer from container
        self.container = "webm"

        if not self.api_key:
            logger.warning(
                "Deepgram API key is empty; transcription calls will fail until configured."
            )

    async def open_session(self, meeting_id: int, language: str) -> str:
        session_id = uuid4().hex
        session = _SessionBuffer(
            session_id=session_id,
            meeting_id=meeting_id,
            language=(language or "vi").strip() or "vi",
        )
        self._sessions[session_id] = session
        session.websocket = await self._connect_session(session, session_id)
        return session_id

    async def push_audio_chunk(
        self,
        session_id: str,
        pcm_chunk: bytes,
        ts_ms: int,
        seq: int | None = None,
        drain_transcript: bool = True,
    ) -> None:
        await self.send_audio_chunk(session_id, pcm_chunk, seq=seq)
        if drain_transcript:
            await self.recv_transcript_events(session_id, ts_ms)

    async def send_audio_chunk(
        self, session_id: str, pcm_chunk: bytes, seq: int | None = None
    ) -> None:
        session = self._get_session(session_id)
        async with session.state_lock:
            chunk_bytes = bytes(pcm_chunk or b"")
            session.chunks.append(chunk_bytes)
            session.last_activity_at = time.time()

            logger.info(
                "DG SEND session_id={} seq={} bytes={} first16hex={}",
                session_id,
                -1 if seq is None else int(seq),
                len(chunk_bytes),
                chunk_bytes[:16].hex(),
            )

            websocket = session.websocket
            if not websocket or session.closed:
                raise RuntimeError("Deepgram session is not connected")

        await self._send_audio_chunk(websocket, chunk_bytes)

    async def recv_transcript_events(
        self, session_id: str, ts_ms: int, drain_timeout: float | None = None
    ) -> list[dict[str, Any]]:
        session = self._get_session(session_id)
        async with session.state_lock:
            session.timestamps_ms.append(int(ts_ms))
            if session.websocket is None:
                return []

            idle_seconds = time.time() - float(session.last_activity_at or 0.0)
            if idle_seconds >= self.KEEPALIVE_AFTER_IDLE_SECONDS:
                ping = getattr(session.websocket, "ping", None)
                if callable(ping):
                    try:
                        waiter = ping()
                        if hasattr(waiter, "__await__"):
                            await waiter
                        logger.info(
                            "DG_KEEPALIVE_SENT session_id={} meeting_id={}",
                            session.session_id,
                            session.meeting_id,
                        )
                    except Exception:
                        logger.warning(
                            "DG_KEEPALIVE_FAILED session_id={} meeting_id={}",
                            session.session_id,
                            session.meeting_id,
                        )
                session.last_activity_at = time.time()

        async with session.recv_lock:
            events = await self._drain_transcript_events(
                session, ts_ms=ts_ms, drain_timeout=drain_timeout
            )
        async with session.state_lock:
            session.partial_events.extend(events)
            session.last_activity_at = time.time()
        return events

    async def close_session(self, session_id: str) -> None:
        session = self._sessions.get(session_id)
        if session is None:
            if session_id in self._closed_responses:
                return
            self._get_session(session_id)
            return
        async with session.state_lock:
            session.closed = True
            websocket = session.websocket
            close_ts_ms = session.timestamps_ms[-1] if session.timestamps_ms else 0

        final_events: list[dict[str, Any]] = []
        if websocket is not None:
            async with session.recv_lock:
                final_events.extend(
                    await self._drain_transcript_events(
                        session,
                        ts_ms=close_ts_ms,
                        drain_timeout=self.timeout_seconds,
                    )
                )
            try:
                await websocket.close()
            finally:
                async with session.state_lock:
                    session.websocket = None

        async with session.state_lock:
            if final_events:
                session.partial_events.extend(final_events)

            if not session.transcript and session.latest_partial:
                session.transcript = session.latest_partial

            raw_response = {
                "transcript": session.transcript,
                "partials": list(session.partial_events),
                "closed": session.closed,
            }
            session.raw_response = raw_response

        self._closed_responses[session_id] = raw_response
        self._closed_responses.move_to_end(session_id)
        while len(self._closed_responses) > self.CLOSED_RESPONSE_CACHE_MAX_ITEMS:
            self._closed_responses.popitem(last=False)
        self._sessions.pop(session_id, None)

    def get_transcript(self, session_id: str) -> str:
        session = self._sessions.get(session_id)
        if session is not None:
            return session.transcript
        raw_response = self._closed_responses.get(session_id)
        if raw_response is not None:
            return str(raw_response.get("transcript") or "")
        self._get_session(session_id)
        return ""

    def drain_partial_events(self, session_id: str) -> list[dict[str, Any]]:
        session = self._get_session(session_id)
        events = list(session.partial_events)
        session.partial_events.clear()
        return events

    async def drain_transcript_events(
        self, session_id: str, ts_ms: int, drain_timeout: float | None = None
    ) -> list[dict[str, Any]]:
        return await self.recv_transcript_events(
            session_id=session_id,
            ts_ms=ts_ms,
            drain_timeout=drain_timeout,
        )

    def get_raw_response(self, session_id: str) -> dict[str, Any] | None:
        session = self._sessions.get(session_id)
        if session is not None:
            return session.raw_response
        return self._closed_responses.get(session_id)

    def _get_session(self, session_id: str) -> _SessionBuffer:
        try:
            return self._sessions[session_id]
        except KeyError as exc:
            raise KeyError(f"Unknown STT session: {session_id}") from exc

    async def _connect_session(self, session: _SessionBuffer, session_id: str) -> Any:
        if websockets is None:
            raise RuntimeError(
                "websockets package is required for Deepgram streaming support"
            )

        connection_url = self._build_websocket_url(session.language)
        headers = [("Authorization", f"Token {self.api_key}")]
        safe_url = connection_url
        logger.info(
            "DG CONNECT session_id={} meeting_id={} language={} url={}",
            session_id,
            session.meeting_id,
            session.language,
            safe_url,
        )

        last_error: Exception | None = None
        for attempt in range(1, 4):
            try:
                websocket = await asyncio.wait_for(
                    websockets.connect(  # type: ignore[attr-defined]
                        connection_url,
                        extra_headers=headers,
                        open_timeout=self.timeout_seconds,
                        close_timeout=self.timeout_seconds,
                        ping_interval=None,
                    ),
                    timeout=self.timeout_seconds,
                )
                logger.info("DG CONNECTED session_id={}", session_id)
                return websocket
            except Exception as exc:  # pragma: no cover - exercised via tests
                last_error = exc
                logger.exception("DG SOCKET ERROR error={}", repr(exc))
                if attempt >= 3:
                    break
                await asyncio.sleep(min(0.25 * attempt, 1.0))

        raise RuntimeError("Failed to connect to Deepgram WebSocket") from last_error

    async def _send_audio_chunk(self, websocket: Any, pcm_chunk: bytes) -> None:
        try:
            await asyncio.wait_for(
                websocket.send(bytes(pcm_chunk or b"")), timeout=self.timeout_seconds
            )
        except asyncio.TimeoutError:
            raise
        except Exception as exc:  # pragma: no cover - exercised via tests
            if is_terminal_error(exc):
                raise
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

        timeout_seconds = (
            self.timeout_seconds if drain_timeout is None else drain_timeout
        )
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        events: list[dict[str, Any]] = []

        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                break

            try:
                raw_message = await asyncio.wait_for(
                    websocket.recv(), timeout=remaining
                )
            except (asyncio.TimeoutError, TimeoutError):
                break
            except Exception as exc:
                if session.closed or is_terminal_error(exc):
                    break
                logger.exception("DG SOCKET ERROR error={}", repr(exc))
                raise RuntimeError("Deepgram WebSocket receive failed") from exc

            self._log_raw_message(session.session_id, raw_message)
            event = self._parse_transcript_message(
                raw_message,
                ts_ms=ts_ms,
                session=session,
            )
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
                "interim_results": "true",
                # Do not send explicit encoding; keep container only to match webm/opus
                "container": self.container,
            }
        )
        if not self.simplify_streaming_url:
            query_pairs.update(
                {
                    "smart_format": "true",
                    "utterances": "true",
                }
            )
        query = urlencode(query_pairs)
        return urlunparse(parsed._replace(query=query))

    def _parse_transcript_message(
        self,
        raw_message: Any,
        ts_ms: int,
        session: _SessionBuffer | None = None,
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
        start_time, end_time = self._extract_timing(payload)
        self._record_event_count(session, payload)

        if self._is_results_payload(payload):
            logger.info(
                "DG RAW EVENT Results meeting_ts_ms={} type={} has_channel={} has_alternatives={} is_final={} speech_final={} text_len={} keys={}",
                ts_ms,
                payload.get("type"),
                isinstance(payload.get("channel"), dict),
                self._has_alternatives(payload),
                bool(payload.get("is_final")),
                bool(payload.get("speech_final")),
                len(transcript),
                list(payload.keys()),
            )

            if not transcript:
                logger.info(
                    "DG EMPTY RESULTS session_id={} meeting_ts_ms={} event_type={} is_final={} speech_final={} text_len={} alternatives_count={} event_count={}",
                    session.session_id if session is not None else None,
                    ts_ms,
                    payload.get("type"),
                    bool(payload.get("is_final")),
                    bool(payload.get("speech_final")),
                    len(transcript),
                    self._count_alternatives(payload),
                    session.results_events if session is not None else None,
                )

        # If payload contains metadata, emit a concise metadata event log
        try:
            if (
                isinstance(payload.get("metadata"), dict)
                or payload.get("type") == "Metadata"
            ):
                metadata_duration = (
                    payload.get("metadata", {}).get("duration")
                    if isinstance(payload.get("metadata"), dict)
                    else None
                )
                logger.info(
                    "DG RAW EVENT Metadata meeting_ts_ms={} duration={}",
                    ts_ms,
                    metadata_duration,
                )
        except Exception:
            pass

        if not transcript:
            return None

        is_final = bool(payload.get("is_final") or payload.get("speech_final"))
        segment_id = self._resolve_segment_id(
            payload, session, start_time, end_time, ts_ms
        )

        # Emit a concise parsed transcript log (truncated) for debugging
        try:
            logger.info(
                "Parsed Deepgram transcript ts_ms={} is_final={} confidence={} text={}",
                ts_ms,
                is_final,
                repr(confidence),
                transcript[:400],
            )
        except Exception:
            pass

        return {
            "text": transcript,
            "confidence": confidence,
            "is_final": is_final,
            "ts_ms": ts_ms,
            "segment_id": segment_id,
            "start_time": start_time,
            "end_time": end_time,
            "raw": payload,
        }

    def _log_raw_message(self, session_id: str, raw_message: Any) -> None:
        if not self.debug_raw_messages:
            return
        if not isinstance(raw_message, str):
            return

        preview = raw_message.replace("\r", " ").replace("\n", " ")[:1000]
        logger.info(
            "DG RAW MESSAGE session_id={} len={} preview={}",
            session_id,
            len(raw_message),
            preview,
        )

    def _record_event_count(
        self,
        session: _SessionBuffer | None,
        payload: dict[str, Any],
    ) -> None:
        if session is None:
            return

        event_type = str(payload.get("type") or "").lower()
        if self._is_results_payload(payload):
            session.results_events += 1
        elif event_type == "metadata" or isinstance(payload.get("metadata"), dict):
            session.metadata_events += 1
        elif event_type in {"speechstarted", "speech_started"}:
            session.speech_started_events += 1
        elif event_type in {"utteranceend", "utterance_end"}:
            session.utterance_end_events += 1
        else:
            session.other_events += 1

        logger.info(
            "DG_EVENT_COUNTS session_id={} metadata={} results={} speech_started={} utterance_end={} other={}",
            session.session_id,
            session.metadata_events,
            session.results_events,
            session.speech_started_events,
            session.utterance_end_events,
            session.other_events,
        )

    def _is_results_payload(self, payload: dict[str, Any]) -> bool:
        event_type = str(payload.get("type") or "").lower()
        return (
            event_type == "results"
            or isinstance(payload.get("channel"), dict)
            or isinstance(payload.get("results"), dict)
        )

    def _has_alternatives(self, payload: dict[str, Any]) -> bool:
        results = payload.get("results")
        if isinstance(results, dict):
            channels = results.get("channels") or []
            if channels and isinstance(channels[0], dict):
                return bool(channels[0].get("alternatives"))

        channel = payload.get("channel")
        if isinstance(channel, dict):
            return bool(channel.get("alternatives"))

        return False

    def _count_alternatives(self, payload: dict[str, Any]) -> int:
        results = payload.get("results")
        if isinstance(results, dict):
            channels = results.get("channels") or []
            if channels and isinstance(channels[0], dict):
                return len(channels[0].get("alternatives") or [])

        channel = payload.get("channel")
        if isinstance(channel, dict):
            return len(channel.get("alternatives") or [])

        return 0

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

    def _extract_timing(
        self, payload: dict[str, Any]
    ) -> tuple[float | None, float | None]:
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
            start_time = self._first_float_value(
                alternative.get("start"),
                alternative.get("start_time"),
                channel.get("start"),
                channel.get("start_time"),
                payload.get("start"),
                payload.get("start_time"),
            )
            end_time = self._first_float_value(
                alternative.get("end"),
                alternative.get("end_time"),
                channel.get("end"),
                channel.get("end_time"),
                payload.get("end"),
                payload.get("end_time"),
            )
            duration = self._first_float_value(
                alternative.get("duration"),
                alternative.get("duration_seconds"),
                channel.get("duration"),
                payload.get("duration"),
            )

            if start_time is None and end_time is None and duration is None:
                continue

            if start_time is None and end_time is not None and duration is not None:
                start_time = max(0.0, end_time - duration)
            if start_time is None and end_time is not None:
                start_time = end_time
            if end_time is None and start_time is not None and duration is not None:
                end_time = start_time + duration
            if end_time is None and start_time is not None:
                end_time = start_time

            return start_time, end_time

        return None, None

    def _resolve_segment_id(
        self,
        payload: dict[str, Any],
        session: _SessionBuffer | None,
        start_time: float | None,
        end_time: float | None,
        ts_ms: int,
    ) -> str:
        explicit_id = str(
            payload.get("segment_id")
            or payload.get("segmentId")
            or payload.get("event_id")
            or payload.get("eventId")
            or ""
        ).strip()
        if explicit_id:
            return explicit_id

        meeting_part = (
            f"meeting-{session.meeting_id}" if session is not None else "meeting-0"
        )
        if start_time is not None:
            return f"{meeting_part}-start-{start_time:.3f}"
        if end_time is not None:
            return f"{meeting_part}-end-{end_time:.3f}"
        return f"{meeting_part}-ts-{int(ts_ms)}"

    def _first_float_value(self, *values: Any) -> float | None:
        for value in values:
            if isinstance(value, (int, float)):
                return float(value)
            if isinstance(value, str):
                stripped = value.strip()
                if not stripped:
                    continue
                try:
                    return float(stripped)
                except ValueError:
                    continue
        return None

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

    def batch_transcribe_file(
        self, file_path: str, language: str = "vi", model: str | None = None
    ) -> dict[str, Any]:
        """
        Batch transcribe audio file using Deepgram prerecorded endpoint.

        Args:
            file_path: Path to audio file (e.g., .m4a, .mp3, .wav)
            language: Language code (e.g., 'vi')
            model: Deepgram model to use (defaults to nova-2)

        Returns:
            Dictionary with transcription results including segments, text, timing

        Raises:
            RuntimeError: If API key is not configured or HTTP request fails
        """
        if httpx is None:
            raise ImportError("httpx is required for batch transcription")

        if not self.api_key:
            raise RuntimeError(
                "Deepgram API key is not configured; batch transcription unavailable"
            )

        api_model = (model or self.model or "nova-2").strip() or "nova-2"
        safe_language = (language or "vi").strip() or "vi"

        logger.info(
            f"BATCH_STT_START file={file_path} model={api_model} language={safe_language}"
        )

        try:
            with open(file_path, "rb") as f:
                audio_data = f.read()
        except FileNotFoundError:
            logger.error(f"Audio file not found: {file_path}")
            raise RuntimeError(f"Audio file not found: {file_path}")
        except Exception as e:
            logger.error(f"Failed to read audio file {file_path}: {repr(e)}")
            raise

        # Deepgram prerecorded endpoint
        url = f"{self.base_url}?model={api_model}&language={safe_language}&smart_format=true&utterances=true"

        headers = {
            "Authorization": f"Token {self.api_key}",
            "Content-Type": "audio/mpeg",  # Deepgram auto-detects format
        }

        try:
            with httpx.Client(timeout=self.timeout_seconds) as client:
                response = client.post(url, content=audio_data, headers=headers)
                response.raise_for_status()
                result = response.json()
        except Exception as e:
            logger.error(f"Deepgram batch request failed: {repr(e)}")
            raise RuntimeError(f"Deepgram batch transcription failed: {repr(e)}")

        # Parse Deepgram response
        transcript_text = ""
        segments = []

        try:
            results = result.get("results", {})
            channels = results.get("channels", [])

            if not channels:
                logger.warning(f"No channels in Deepgram response for {file_path}")
                return {
                    "transcript": "",
                    "segments": [],
                    "raw_response": result,
                }

            # Extract transcript and timing from first channel
            channel = channels[0]
            alternatives = channel.get("alternatives", [])

            if not alternatives:
                logger.warning(f"No alternatives in Deepgram response for {file_path}")
                return {
                    "transcript": "",
                    "segments": [],
                    "raw_response": result,
                }

            alternative = alternatives[0]
            transcript_text = alternative.get("transcript", "").strip()

            # Extract utterance-level timing for segment alignment
            utterances = results.get("utterances", [])

            if utterances:
                # Use utterances for cleaner segmentation
                for utterance in utterances:
                    start = utterance.get("start", 0.0)
                    end = utterance.get("end", 0.0)
                    text = utterance.get("transcript", "").strip()
                    if text:
                        segments.append(
                            {
                                "start": float(start),
                                "end": float(end),
                                "text": text,
                            }
                        )
            else:
                # Fallback: create single segment
                if transcript_text:
                    segments.append(
                        {
                            "start": 0.0,
                            "end": float(alternative.get("duration", 0.0) or 0.0),
                            "text": transcript_text,
                        }
                    )

        except Exception as e:
            logger.error(f"Failed to parse Deepgram response: {repr(e)}")
            raise RuntimeError(f"Failed to parse Deepgram response: {repr(e)}")

        logger.info(
            f"BATCH_STT_COMPLETE file={file_path} segments={len(segments)} text_len={len(transcript_text)}"
        )

        return {
            "transcript": transcript_text,
            "segments": segments,
            "raw_response": result,
        }
