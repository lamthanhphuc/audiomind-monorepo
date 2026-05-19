from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Deque
from uuid import uuid4

from loguru import logger
from sqlalchemy.exc import IntegrityError

from app.database import SessionLocal
from app.config import get_settings
from app.metrics import stt_metrics
from app.schemas import SttStreamResponse
from app.services.stt_adapter import (
    DeepgramSTTAdapter,
    _iter_exception_chain,
    is_terminal_error,
    is_transient_error,
)
from app.services.stt_persistence import (
    TranscriptFragmentInput,
    TranscriptPersistenceRepository,
    build_fragment_dedupe_key,
)
from app.services.stt_ownership import (
    SttLease,
    SttOwnershipLost,
    SttOwnershipManager,
)


class MeetingSessionState(str, Enum):
    CREATED = "CREATED"
    CONNECTING = "CONNECTING"
    ACTIVE = "ACTIVE"
    HALF_OPEN = "HALF_OPEN"
    DEGRADED = "DEGRADED"
    DRAINING = "DRAINING"
    CLOSING = "CLOSING"
    CLOSED = "CLOSED"
    FAILED = "FAILED"


class QueueCapacityError(RuntimeError):
    pass


class QueueShutdown(RuntimeError):
    pass


_WEBM_HEADER_MAGIC = bytes.fromhex("1a45dfa3")


@dataclass
class SizedEnvelope:
    size_bytes: int


@dataclass
class AudioEnvelope(SizedEnvelope):
    seq: int
    pcm_chunk: bytes
    ts_ms: int
    language: str
    is_final: bool
    event_id: str = field(default_factory=lambda: uuid4().hex)
    future: asyncio.Future | None = None


@dataclass
class RecvEnvelope(SizedEnvelope):
    seq: int
    ts_ms: int
    is_final: bool
    event_id: str
    future: asyncio.Future | None = None


@dataclass
class PersistEnvelope(SizedEnvelope):
    seq: int
    ts_ms: int
    is_final: bool
    event_id: str
    transcript_events: list[dict[str, Any]]
    future: asyncio.Future | None = None


class BoundedMessageQueue:
    def __init__(
        self,
        max_items: int,
        max_bytes: int,
        name: str,
        overload_ratio: float = 0.85,
        overload_policy: str = "drop_newest",
    ):
        self.max_items = max_items
        self.max_bytes = max_bytes
        self.name = name
        self.overload_ratio = max(0.0, min(float(overload_ratio), 1.0))
        self.overload_policy = (overload_policy or "drop_newest").strip().lower()
        self._items: Deque[SizedEnvelope] = deque()
        self._current_bytes = 0
        self._condition = asyncio.Condition()
        self._closed = False

    @property
    def current_bytes(self) -> int:
        return self._current_bytes

    def pressure_ratio(self) -> float:
        if self.max_items <= 0:
            return 1.0
        return min(1.0, len(self._items) / float(self.max_items))

    def qsize(self) -> int:
        return len(self._items)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        async with self._condition:
            self._condition.notify_all()

    async def clear(self) -> None:
        async with self._condition:
            self._items.clear()
            self._current_bytes = 0
            self._condition.notify_all()

    async def put(self, item: SizedEnvelope, timeout_seconds: float) -> None:
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        while True:
            async with self._condition:
                if self._closed:
                    raise QueueShutdown(f"{self.name} closed")
                if (
                    self.overload_policy == "drop_newest"
                    and self.pressure_ratio() >= self.overload_ratio
                ):
                    raise QueueCapacityError(f"{self.name} overloaded")
                if (
                    len(self._items) < self.max_items
                    and self._current_bytes + int(item.size_bytes or 0)
                    <= self.max_bytes
                ):
                    self._items.append(item)
                    self._current_bytes += int(item.size_bytes or 0)
                    self._condition.notify_all()
                    return

                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise QueueCapacityError(f"{self.name} capacity exceeded")

                try:
                    await asyncio.wait_for(self._condition.wait(), timeout=remaining)
                except (TimeoutError, asyncio.TimeoutError) as exc:
                    raise QueueCapacityError(f"{self.name} capacity exceeded") from exc

    async def get(self) -> SizedEnvelope:
        while True:
            async with self._condition:
                if self._items:
                    item = self._items.popleft()
                    self._current_bytes -= int(item.size_bytes or 0)
                    self._condition.notify_all()
                    return item
                if self._closed:
                    raise QueueShutdown(f"{self.name} closed")
                await self._condition.wait()


class MeetingSessionActor:
    AUDIO_QUEUE_MAX_ITEMS = 64
    AUDIO_QUEUE_MAX_BYTES = 8 * 1024 * 1024
    RECV_QUEUE_MAX_ITEMS = 256
    RECV_QUEUE_MAX_BYTES = 4 * 1024 * 1024
    PERSIST_QUEUE_MAX_ITEMS = 512
    PERSIST_QUEUE_MAX_BYTES = 16 * 1024 * 1024
    ENQUEUE_TIMEOUT_SECONDS = 2.0
    GAP_TIMEOUT_SECONDS = 1.0
    RECV_DRAIN_TIMEOUT_SECONDS = 1.0
    TRANSIENT_RETRY_BASE_SECONDS = 0.25
    TRANSIENT_RETRY_CAP_SECONDS = 2.0
    RECONNECT_BUDGET = 2
    RECONNECT_WINDOW_SECONDS = 60.0
    RECONNECT_COOLDOWN_SECONDS = 60.0
    _ALLOWED_TRANSITIONS: dict[MeetingSessionState, set[MeetingSessionState]] = {
        MeetingSessionState.CREATED: {
            MeetingSessionState.CONNECTING,
            MeetingSessionState.FAILED,
            MeetingSessionState.CLOSED,
        },
        MeetingSessionState.CONNECTING: {
            MeetingSessionState.ACTIVE,
            MeetingSessionState.HALF_OPEN,
            MeetingSessionState.DEGRADED,
            MeetingSessionState.FAILED,
            MeetingSessionState.CLOSING,
        },
        MeetingSessionState.ACTIVE: {
            MeetingSessionState.HALF_OPEN,
            MeetingSessionState.DEGRADED,
            MeetingSessionState.DRAINING,
            MeetingSessionState.CLOSING,
            MeetingSessionState.FAILED,
        },
        MeetingSessionState.HALF_OPEN: {
            MeetingSessionState.CONNECTING,
            MeetingSessionState.ACTIVE,
            MeetingSessionState.DEGRADED,
            MeetingSessionState.DRAINING,
            MeetingSessionState.CLOSING,
            MeetingSessionState.FAILED,
        },
        MeetingSessionState.DEGRADED: {
            MeetingSessionState.DRAINING,
            MeetingSessionState.CLOSING,
            MeetingSessionState.FAILED,
        },
        MeetingSessionState.DRAINING: {
            MeetingSessionState.CLOSING,
            MeetingSessionState.CLOSED,
            MeetingSessionState.FAILED,
        },
        MeetingSessionState.CLOSING: {
            MeetingSessionState.CLOSED,
            MeetingSessionState.FAILED,
        },
        MeetingSessionState.CLOSED: set(),
        MeetingSessionState.FAILED: {
            MeetingSessionState.CONNECTING,
            MeetingSessionState.DRAINING,
            MeetingSessionState.CLOSING,
            MeetingSessionState.CLOSED,
        },
    }

    def __init__(
        self,
        meeting_key: str,
        language: str,
        adapter: DeepgramSTTAdapter,
        db_session_factory: Callable[[], Any] = SessionLocal,
        lease: SttLease | None = None,
        ownership_manager: SttOwnershipManager | None = None,
    ):
        settings = get_settings()
        self.meeting_key = str(meeting_key)
        self.language = (language or "vi").strip() or "vi"
        self.adapter = adapter
        self.db_session_factory = db_session_factory
        self.lease = lease
        self.ownership_manager = ownership_manager
        self.fencing_token = lease.fencing_token if lease is not None else 0
        self.session_id: str | None = None
        self.state = MeetingSessionState.CREATED
        self._state_lock = asyncio.Lock()
        self._state_history: list[tuple[str, str]] = []
        self._state_entered_at = time.time()
        self._last_activity_at = self._state_entered_at
        self._last_send_at = self._state_entered_at
        self._last_recv_at = self._state_entered_at
        self._last_persist_at = self._state_entered_at
        self._watchdog_started_at = self._state_entered_at
        self._shutdown_started_at: float | None = None
        self._actor_counted = False
        self._settings = settings
        self.AUDIO_QUEUE_MAX_ITEMS = int(settings.stt_audio_queue_max_items)
        self.AUDIO_QUEUE_MAX_BYTES = int(settings.stt_audio_queue_max_bytes)
        self.RECV_QUEUE_MAX_ITEMS = int(settings.stt_recv_queue_max_items)
        self.RECV_QUEUE_MAX_BYTES = int(settings.stt_recv_queue_max_bytes)
        self.PERSIST_QUEUE_MAX_ITEMS = int(settings.stt_persist_queue_max_items)
        self.PERSIST_QUEUE_MAX_BYTES = int(settings.stt_persist_queue_max_bytes)
        self.ENQUEUE_TIMEOUT_SECONDS = float(settings.stt_enqueue_timeout_seconds)
        self.GAP_TIMEOUT_SECONDS = float(settings.stt_gap_timeout_seconds)
        self.RECV_DRAIN_TIMEOUT_SECONDS = float(settings.stt_recv_drain_timeout_seconds)
        self.TRANSIENT_RETRY_BASE_SECONDS = float(
            settings.stt_transient_retry_base_seconds
        )
        self.TRANSIENT_RETRY_CAP_SECONDS = float(
            settings.stt_transient_retry_cap_seconds
        )
        self.RECONNECT_BUDGET = int(settings.stt_reconnect_budget)
        self.RECONNECT_WINDOW_SECONDS = float(settings.stt_reconnect_window_seconds)
        self.RECONNECT_COOLDOWN_SECONDS = float(settings.stt_reconnect_cooldown_seconds)
        self._watchdog_interval_seconds = float(settings.stt_watchdog_interval_seconds)
        self._recv_stall_seconds = float(settings.stt_recv_stall_seconds)
        self._persist_stall_seconds = float(settings.stt_persist_stall_seconds)
        self._half_open_stall_seconds = float(settings.stt_half_open_stall_seconds)
        self._shutdown_grace_seconds = float(settings.stt_shutdown_grace_seconds)
        self._queue_pressure_ratio = float(settings.stt_queue_pressure_ratio)
        self._overload_policy = (
            (settings.stt_overload_policy or "drop_newest").strip().lower()
        )
        self._audio_queue = BoundedMessageQueue(
            self.AUDIO_QUEUE_MAX_ITEMS,
            self.AUDIO_QUEUE_MAX_BYTES,
            "audio_queue",
            overload_ratio=self._queue_pressure_ratio,
            overload_policy=self._overload_policy,
        )
        self._recv_queue = BoundedMessageQueue(
            self.RECV_QUEUE_MAX_ITEMS,
            self.RECV_QUEUE_MAX_BYTES,
            "recv_queue",
            overload_ratio=self._queue_pressure_ratio,
            overload_policy=self._overload_policy,
        )
        self._persist_queue = BoundedMessageQueue(
            self.PERSIST_QUEUE_MAX_ITEMS,
            self.PERSIST_QUEUE_MAX_BYTES,
            "persist_queue",
            overload_ratio=self._queue_pressure_ratio,
            overload_policy=self._overload_policy,
        )
        self._pending_audio: dict[int, AudioEnvelope] = {}
        self._pending_recv: dict[int, RecvEnvelope] = {}
        self._pending_persist: dict[int, PersistEnvelope] = {}
        self._response_cache: dict[int, SttStreamResponse] = {}
        self._pending_futures: dict[int, asyncio.Future] = {}
        self._last_ack_seq = 0
        self._last_persisted_seq = 0
        self._last_finalized_seq = 0
        self._last_persisted_response: SttStreamResponse | None = None
        self._shutdown_requested = False
        self._shutdown_complete = asyncio.Event()
        self._gap_deadline: float | None = None
        self._reconnect_history: list[float] = []
        self._cooldown_until: float = 0.0
        self._requires_new_stream: bool = False
        self._last_terminal_close_code: str | None = None
        self._last_terminal_close_reason: str | None = None
        self._last_terminal_close_error: str | None = None
        self._send_task: asyncio.Task | None = None
        self._recv_task: asyncio.Task | None = None
        self._persist_task: asyncio.Task | None = None
        self._watchdog_task: asyncio.Task | None = None
        self._final_response: SttStreamResponse | None = None
        self._finalization_future: asyncio.Future | None = None
        self._finalization_seq: int | None = None
        self._send_lock = asyncio.Lock()

    def _log_context(self, **extra: Any) -> dict[str, Any]:
        context = {
            "meeting_id": self.meeting_key,
            "actor_state": self.state.value,
            "ack_seq": self._last_ack_seq,
            "persisted_seq": self._last_persisted_seq,
            "finalized_seq": self._last_finalized_seq,
            "reconnect_budget_remaining": max(
                0, self.RECONNECT_BUDGET - len(self._reconnect_history)
            ),
            "queue_depth": {
                "audio": self._audio_queue.qsize(),
                "recv": self._recv_queue.qsize(),
                "persist": self._persist_queue.qsize(),
            },
            "websocket_state": "open" if self.session_id else "closed",
            "fencing_token": self.fencing_token,
        }
        context.update(extra)
        return context

    def _record_queue_metrics(self) -> None:
        stt_metrics.record_queue_depths(
            self._audio_queue.qsize(),
            self._recv_queue.qsize(),
            self._persist_queue.qsize(),
        )

    def _record_state_metrics(self, state: MeetingSessionState) -> None:
        stt_metrics.record_state(state.value)

    def _mark_activity(self) -> None:
        self._last_activity_at = time.time()

    def _mark_send_activity(self) -> None:
        self._last_send_at = time.time()
        self._mark_activity()

    def _mark_recv_activity(self) -> None:
        self._last_recv_at = time.time()
        self._mark_activity()

    def _mark_persist_activity(self) -> None:
        self._last_persist_at = time.time()
        self._mark_activity()

    @classmethod
    async def create(
        cls,
        meeting_key: str,
        language: str,
        adapter: DeepgramSTTAdapter,
        db_session_factory: Callable[[], Any] = SessionLocal,
        lease: SttLease | None = None,
        ownership_manager: SttOwnershipManager | None = None,
    ) -> "MeetingSessionActor":
        actor = cls(
            meeting_key,
            language,
            adapter,
            db_session_factory=db_session_factory,
            lease=lease,
            ownership_manager=ownership_manager,
        )
        await actor._connect_session()
        actor._send_task = asyncio.create_task(
            actor._send_pump(), name=f"stt-send-{actor.meeting_key}"
        )
        await actor._transition(MeetingSessionState.CONNECTING, "open_session")
        actor._recv_task = asyncio.create_task(
            actor._recv_pump(), name=f"stt-recv-{actor.meeting_key}"
        )
        actor._persist_task = asyncio.create_task(
            actor._persist_pump(), name=f"stt-persist-{actor.meeting_key}"
        )
        actor._watchdog_task = asyncio.create_task(
            actor._watchdog_loop(), name=f"stt-watchdog-{actor.meeting_key}"
        )
        await actor._transition(MeetingSessionState.ACTIVE, "session_ready")
        if not actor._actor_counted:
            stt_metrics.actor_started()
            actor._actor_counted = True
        actor._record_state_metrics(actor.state)
        actor._record_queue_metrics()
        return actor

    def snapshot(self) -> dict[str, Any]:
        return {
            "meeting_id": self.meeting_key,
            "session_id": self.session_id,
            "state": self.state.value,
            "last_ack_seq": self._last_ack_seq,
            "last_persisted_seq": self._last_persisted_seq,
            "last_finalized_seq": self._last_finalized_seq,
            "audio_queue": self._audio_queue.qsize(),
            "recv_queue": self._recv_queue.qsize(),
            "persist_queue": self._persist_queue.qsize(),
            "last_activity_at": self._last_activity_at,
            "watchdog_started_at": self._watchdog_started_at,
            "fencing_token": self.fencing_token,
            "owner_id": self.lease.owner_id if self.lease is not None else None,
        }

    def retry_guard_snapshot(self) -> dict[str, Any]:
        return {
            "cooldown_until": float(self._cooldown_until or 0.0),
            "requires_new_stream": bool(self._requires_new_stream),
            "last_terminal_close_code": self._last_terminal_close_code,
            "last_terminal_close_reason": self._last_terminal_close_reason,
            "last_terminal_close_error": self._last_terminal_close_error,
        }

    @property
    def websocket_state(self) -> str:
        return "open" if self.session_id else "closed"

    async def _watchdog_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(self._watchdog_interval_seconds)
                await self._watchdog_tick()
        except asyncio.CancelledError:
            return

    async def _watchdog_tick(self) -> None:
        if self.state in {MeetingSessionState.CLOSED, MeetingSessionState.FAILED}:
            return
        if not self._refresh_or_mark_ownership_lost("watchdog"):
            return

        self._record_queue_metrics()
        now = time.time()
        has_inflight = bool(
            self._pending_audio or self._pending_recv or self._pending_persist
        )
        if not has_inflight:
            return

        if (
            self.state == MeetingSessionState.HALF_OPEN
            and now - self._state_entered_at >= self._half_open_stall_seconds
        ):
            logger.warning(
                "STT_WATCHDOG_HALF_OPEN_STALL {}",
                self._log_context(
                    elapsed_seconds=round(now - self._state_entered_at, 3)
                ),
            )
            await self._transition(
                MeetingSessionState.FAILED, "watchdog_half_open_stall"
            )
            self._cancel_pending_futures(TimeoutError("STT half-open watchdog timeout"))
            return

        recv_stalled = now - self._last_recv_at >= self._recv_stall_seconds
        persist_stalled = now - self._last_persist_at >= self._persist_stall_seconds
        if recv_stalled or persist_stalled:
            if self.state == MeetingSessionState.DEGRADED:
                await self._transition(
                    MeetingSessionState.FAILED, "watchdog_stall_timeout"
                )
                self._cancel_pending_futures(TimeoutError("STT watchdog stall timeout"))
                return

            stall_reason = "recv" if recv_stalled else "persist"
            logger.warning(
                "STT_WATCHDOG_STALL {}",
                self._log_context(
                    stall_reason=stall_reason,
                    elapsed_seconds=round(
                        now - min(self._last_recv_at, self._last_persist_at), 3
                    ),
                ),
            )
            try:
                await self._transition(
                    MeetingSessionState.DEGRADED, f"watchdog_{stall_reason}_stall"
                )
            except RuntimeError:
                pass

    async def _transition(self, next_state: MeetingSessionState, reason: str) -> None:
        async with self._state_lock:
            current = self.state
            if current == next_state:
                return
            if not self._is_transition_allowed(current, next_state):
                logger.error(
                    "ACTOR_STATE_TRANSITION invalid meeting_id={} current={} next={} reason={}",
                    self.meeting_key,
                    current.value,
                    next_state.value,
                    reason,
                )
                raise RuntimeError(
                    f"Invalid STT actor transition {current.value}->{next_state.value}"
                )
            logger.info(
                "ACTOR_STATE_TRANSITION meeting_id={} current={} next={} reason={}",
                self.meeting_key,
                current.value,
                next_state.value,
                reason,
            )
            self._state_history.append((current.value, next_state.value))
            self.state = next_state
            self._state_entered_at = time.time()
            self._record_state_metrics(next_state)
            stt_metrics.record_transition(current.value, next_state.value)

    @staticmethod
    def _is_transition_allowed(
        current: MeetingSessionState, next_state: MeetingSessionState
    ) -> bool:
        if current == next_state:
            return True
        return next_state in MeetingSessionActor._ALLOWED_TRANSITIONS.get(
            current, set()
        )

    async def _connect_session(self) -> None:
        await self._transition(MeetingSessionState.CONNECTING, "open_session")
        try:
            try:
                meeting_id_value: int | str = int(self.meeting_key)
            except (TypeError, ValueError):
                meeting_id_value = self.meeting_key
            self.session_id = await self.adapter.open_session(
                meeting_id_value, self.language
            )
            logger.info(
                "DG SESSION OWNED meeting_id={} session_id={}",
                self.meeting_key,
                self.session_id,
            )
        except Exception:
            await self._transition(MeetingSessionState.FAILED, "open_session_failed")
            raise

    async def submit_chunk(
        self,
        seq: int,
        pcm_chunk: bytes,
        ts_ms: int,
        is_final: bool,
    ) -> SttStreamResponse:
        if bool(is_final) and (int(seq) < 0 or not pcm_chunk):
            return await self.finalize(seq=seq, ts_ms=ts_ms)

        self._assert_owns_meeting("submit")

        if self.state == MeetingSessionState.FAILED:
            if not await self._retry_failed_session():
                raise RuntimeError(
                    f"STT actor is not available in state {self.state.value}"
                )

        if self.state == MeetingSessionState.CLOSED:
            raise RuntimeError(
                f"STT actor is not available in state {self.state.value}"
            )

        if seq <= self._last_ack_seq and seq in self._response_cache:
            stt_metrics.replay_seq()
            logger.info(
                "STT_REPLAY_BOUNDARY meeting_id={} seq={} last_ack_seq={}",
                self.meeting_key,
                seq,
                self._last_ack_seq,
            )
            return self._response_cache[seq]

        if seq in self._pending_futures:
            stt_metrics.duplicate_seq()
            logger.info(
                "STT_REPLAY_BOUNDARY meeting_id={} seq={} reason=in_flight",
                self.meeting_key,
                seq,
            )
            return await self._pending_futures[seq]

        future = asyncio.get_running_loop().create_future()
        audio = AudioEnvelope(
            seq=seq,
            pcm_chunk=bytes(pcm_chunk or b""),
            ts_ms=int(ts_ms),
            language=self.language,
            is_final=bool(is_final),
            size_bytes=len(pcm_chunk or b""),
            future=future,
        )
        self._pending_futures[seq] = future
        try:
            await self._enqueue_audio(audio)
            return await future
        finally:
            self._pending_futures.pop(seq, None)

    async def finalize(self, seq: int, ts_ms: int = 0) -> SttStreamResponse:
        self._assert_owns_meeting("finalize")
        if self._final_response is not None:
            return self._final_response
        if seq in self._response_cache:
            return self._response_cache[seq]
        if self._finalization_future is not None:
            return await self._finalization_future
        if self.state == MeetingSessionState.CLOSED:
            raise RuntimeError(
                f"STT actor is not available in state {self.state.value}"
            )

        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._finalization_future = future
        self._finalization_seq = int(seq)

        try:
            await self._transition(
                MeetingSessionState.DRAINING, "finalization_requested"
            )
        except RuntimeError:
            pass

        event_id = uuid4().hex
        self._pending_futures[seq] = future
        try:
            transcript_events: list[dict[str, Any]] = []
            if self.session_id is not None:
                try:
                    recv_started = time.perf_counter()
                    if hasattr(self.adapter, "recv_transcript_events"):
                        transcript_events = await self.adapter.recv_transcript_events(
                            self.session_id,
                            int(ts_ms),
                            drain_timeout=self.RECV_DRAIN_TIMEOUT_SECONDS,
                        )
                    else:
                        transcript_events = self.adapter.drain_partial_events(
                            self.session_id
                        )
                    stt_metrics.observe_recv_latency_ms(
                        (time.perf_counter() - recv_started) * 1000.0
                    )
                    self._mark_recv_activity()
                except Exception as exc:
                    if is_transient_error(exc):
                        logger.warning(
                            "STT_RECV_BACKPRESSURE meeting_id={} seq={} error={}",
                            self.meeting_key,
                            seq,
                            repr(exc),
                        )
                    else:
                        raise

            await self._enqueue_persist(
                PersistEnvelope(
                    seq=int(seq),
                    ts_ms=int(ts_ms),
                    is_final=True,
                    event_id=event_id,
                    transcript_events=list(transcript_events),
                    size_bytes=max(1, len(transcript_events) or 1),
                    future=future,
                )
            )
            return await future
        finally:
            self._pending_futures.pop(seq, None)

    async def shutdown(self, grace_seconds: float = 15.0) -> None:
        if self._shutdown_requested:
            await asyncio.wait_for(
                self._shutdown_complete.wait(), timeout=grace_seconds
            )
            return

        self._shutdown_requested = True
        self._shutdown_started_at = time.time()
        shutdown_start = time.perf_counter()
        logger.info(
            "STT_SHUTDOWN_DRAIN_BEGIN meeting_id={} state={}",
            self.meeting_key,
            self.state.value,
        )
        try:
            await self._transition(MeetingSessionState.DRAINING, "shutdown_requested")
        except RuntimeError:
            pass

        await self._audio_queue.close()
        await self._recv_queue.close()
        await self._persist_queue.close()

        current_task = asyncio.current_task()
        tasks = [
            task
            for task in [
                self._send_task,
                self._recv_task,
                self._persist_task,
                self._watchdog_task,
            ]
            if task and task is not current_task
        ]
        for task in tasks:
            task.cancel()

        if self.session_id is not None:
            try:
                if self._owns_meeting():
                    await self.adapter.close_session(self.session_id)
            except Exception as exc:
                logger.warning(
                    "STT_SHUTDOWN_CLOSE_ERROR meeting_id={} session_id={} error={}",
                    self.meeting_key,
                    self.session_id,
                    repr(exc),
                )
        self._release_lease()
        try:
            await asyncio.wait_for(
                asyncio.gather(*tasks, return_exceptions=True), timeout=grace_seconds
            )
        except Exception:
            for task in tasks:
                task.cancel()
            try:
                await asyncio.wait_for(
                    asyncio.gather(*tasks, return_exceptions=True),
                    timeout=grace_seconds,
                )
            except Exception:
                pass

        await self._audio_queue.clear()
        await self._recv_queue.clear()
        await self._persist_queue.clear()

        self._cancel_pending_futures(RuntimeError("STT actor shut down"))

        if self._actor_counted:
            stt_metrics.actor_stopped()
            self._actor_counted = False

        try:
            await self._transition(MeetingSessionState.CLOSED, "shutdown_complete")
        except RuntimeError:
            pass
        self._shutdown_complete.set()
        stt_metrics.observe_shutdown_drain_ms(
            (time.perf_counter() - shutdown_start) * 1000.0
        )
        logger.info(
            "STT_SHUTDOWN_DRAIN_END meeting_id={} state={}",
            self.meeting_key,
            self.state.value,
        )

    async def _enqueue_audio(self, audio: AudioEnvelope) -> None:
        self._assert_owns_meeting("enqueue_audio")
        try:
            logger.info(
                "STT_QUEUE_PRESSURE {}",
                self._log_context(
                    seq=audio.seq,
                    queue_name="audio",
                    queue_depth=self._audio_queue.qsize(),
                    queue_bytes=self._audio_queue.current_bytes,
                ),
            )
            await self._audio_queue.put(
                audio, timeout_seconds=self.ENQUEUE_TIMEOUT_SECONDS
            )
            self._record_queue_metrics()
        except QueueCapacityError as exc:
            stt_metrics.dropped_chunk("audio")
            await self._transition(MeetingSessionState.DEGRADED, "audio_queue_pressure")
            raise QueueCapacityError(str(exc)) from exc
        except QueueShutdown as exc:
            raise RuntimeError(str(exc)) from exc

    async def _enqueue_recv(self, recv: RecvEnvelope) -> None:
        self._assert_owns_meeting("enqueue_recv")
        try:
            await self._recv_queue.put(
                recv, timeout_seconds=self.ENQUEUE_TIMEOUT_SECONDS
            )
            self._record_queue_metrics()
        except QueueCapacityError as exc:
            stt_metrics.dropped_chunk("recv")
            await self._transition(MeetingSessionState.DEGRADED, "recv_queue_pressure")
            logger.warning(
                "STT_RECV_BACKPRESSURE meeting_id={} seq={} error={}",
                self.meeting_key,
                recv.seq,
                repr(exc),
            )
            raise QueueCapacityError(str(exc)) from exc
        except QueueShutdown as exc:
            raise RuntimeError(str(exc)) from exc

    async def _enqueue_persist(self, persist: PersistEnvelope) -> None:
        self._assert_owns_meeting("enqueue_persist")
        try:
            await self._persist_queue.put(
                persist, timeout_seconds=self.ENQUEUE_TIMEOUT_SECONDS
            )
            self._record_queue_metrics()
        except QueueCapacityError as exc:
            stt_metrics.dropped_chunk("persist")
            await self._transition(
                MeetingSessionState.DEGRADED, "persist_queue_pressure"
            )
            raise RuntimeError(str(exc)) from exc
        except QueueShutdown as exc:
            raise RuntimeError(str(exc)) from exc

    async def _send_pump(self) -> None:
        try:
            while True:
                audio = await self._audio_queue.get()
                self._pending_audio[audio.seq] = audio
                self._record_queue_metrics()
                await self._drain_ready_audio()
        except asyncio.CancelledError:
            return
        except QueueShutdown:
            return
        except Exception as exc:
            logger.exception(
                "STT_SEND_RETRY meeting_id={} error={} next_retry_backoff={}",
                self.meeting_key,
                repr(exc),
                self.TRANSIENT_RETRY_BASE_SECONDS,
            )
            await self._transition(MeetingSessionState.FAILED, "send_pump_error")
            raise

    async def _drain_ready_audio(self) -> None:
        async with self._send_lock:
            while True:
                expected_seq = self._next_expected_seq()
                audio = self._pending_audio.get(expected_seq)
                if audio is None:
                    pending_seqs = sorted(
                        seq for seq in self._pending_audio.keys() if seq > expected_seq
                    )
                    if not pending_seqs:
                        self._gap_deadline = None
                        return

                    if self._gap_deadline is None:
                        self._gap_deadline = (
                            asyncio.get_running_loop().time() + self.GAP_TIMEOUT_SECONDS
                        )
                    elif asyncio.get_running_loop().time() > self._gap_deadline:
                        logger.error(
                            "STT_SEQ_GAP meeting_id={} expected_seq={} pending_seqs={}",
                            self.meeting_key,
                            expected_seq,
                            pending_seqs,
                        )
                        await self._transition(
                            MeetingSessionState.FAILED, "sequence_gap_timeout"
                        )
                        raise RuntimeError("Sequence gap timeout")
                    return

                self._gap_deadline = None
                await self._process_audio(audio)

    async def _process_audio(self, audio: AudioEnvelope) -> None:
        self._assert_owns_meeting("send")
        if self.session_id is None:
            raise RuntimeError("STT session is not connected")

        send_attempt = 0
        try:
            while True:
                self._assert_owns_meeting("send_attempt")
                send_attempt += 1
                try:
                    logger.info(
                        "STT_SEND_TO_ADAPTER meeting_id={} seq={} size={} first16hex={}",
                        self.meeting_key,
                        audio.seq,
                        len(audio.pcm_chunk),
                        bytes(audio.pcm_chunk or b"")[:16].hex(),
                    )
                    send_started = time.perf_counter()
                    await self.adapter.push_audio_chunk(
                        self.session_id,
                        audio.pcm_chunk,
                        audio.ts_ms,
                        seq=audio.seq,
                        drain_transcript=False,
                    )
                    stt_metrics.observe_send_latency_ms(
                        (time.perf_counter() - send_started) * 1000.0
                    )
                    self._mark_send_activity()
                    await self._enqueue_recv(
                        RecvEnvelope(
                            seq=audio.seq,
                            ts_ms=audio.ts_ms,
                            is_final=audio.is_final,
                            event_id=audio.event_id,
                            size_bytes=max(1, len(audio.pcm_chunk)),
                            future=audio.future,
                        )
                    )
                    break
                except Exception as exc:
                    if is_transient_error(exc):
                        logger.warning(
                            "STT_SEND_RETRY meeting_id={} session_id={} seq={} attempt={} error={}",
                            self.meeting_key,
                            self.session_id,
                            audio.seq,
                            send_attempt,
                            repr(exc),
                        )
                        await asyncio.sleep(
                            min(
                                self.TRANSIENT_RETRY_BASE_SECONDS * send_attempt,
                                self.TRANSIENT_RETRY_CAP_SECONDS,
                            )
                        )
                        continue

                    if is_terminal_error(exc):
                        await self._transition(
                            MeetingSessionState.HALF_OPEN, "terminal_send_failure"
                        )
                        if await self._maybe_reconnect_or_fail(exc, audio):
                            continue
                        return

                    raise
        finally:
            self._pending_audio.pop(audio.seq, None)

    async def _retry_failed_session(self) -> bool:
        now = time.time()
        self._reconnect_history = [
            item
            for item in self._reconnect_history
            if now - item <= self.RECONNECT_WINDOW_SECONDS
        ]
        if now < self._cooldown_until:
            return False
        if len(self._reconnect_history) >= self.RECONNECT_BUDGET:
            self._cooldown_until = now + self.RECONNECT_COOLDOWN_SECONDS
            self._set_shared_cooldown(self._cooldown_until)
            return False

        stt_metrics.reconnect_attempt()
        self._reconnect_history.append(now)
        if self.session_id is not None:
            try:
                await self.adapter.close_session(self.session_id)
            except Exception:
                pass
            finally:
                self.session_id = None

        try:
            await self._connect_session()
            await self._transition(
                MeetingSessionState.ACTIVE, "failed_reconnect_success"
            )
            return True
        except Exception as reconnect_error:
            logger.warning(
                "STT_SEND_RETRY meeting_id={} reconnect_failed error={}",
                self.meeting_key,
                repr(reconnect_error),
            )
            self._cooldown_until = max(
                self._cooldown_until, now + self.RECONNECT_COOLDOWN_SECONDS
            )
            self._set_shared_cooldown(self._cooldown_until)
            try:
                await self._transition(
                    MeetingSessionState.FAILED, "failed_reconnect_failed"
                )
            except RuntimeError:
                pass
            return False

    async def _maybe_reconnect_or_fail(
        self, exc: Exception, audio: AudioEnvelope
    ) -> bool:
        now = time.time()
        self._reconnect_history = [
            item
            for item in self._reconnect_history
            if now - item <= self.RECONNECT_WINDOW_SECONDS
        ]

        code, reason, error_name = self._describe_terminal_error(exc)
        self._last_terminal_close_code = code
        self._last_terminal_close_reason = reason
        self._last_terminal_close_error = error_name
        logger.warning(
            "STT_SOCKET_TERMINAL_CLOSE meeting_id={} seq={} code={} reason={} error={}",
            self.meeting_key,
            audio.seq,
            code,
            reason,
            error_name,
        )

        if self._should_block_reconnect_for_audio(audio):
            self._requires_new_stream = True
            self._cooldown_until = max(
                self._cooldown_until, now + self.RECONNECT_COOLDOWN_SECONDS
            )
            self._set_shared_cooldown(self._cooldown_until)
            logger.warning(
                "STT_RECONNECT_BLOCKED_WEBM_CONTINUATION meeting_id={} seq={} last_ack_seq={} reason={}",
                self.meeting_key,
                audio.seq,
                self._last_ack_seq,
                self._last_terminal_close_error or "terminal_close_after_continuation",
            )
            self._fail_pending(audio, exc)
            try:
                await self._transition(
                    MeetingSessionState.FAILED, "webm_continuation_terminal_close"
                )
            except RuntimeError:
                pass
            return False

        if now < self._cooldown_until:
            stt_metrics.reconnect_cooldown_hit()
            logger.warning(
                "STT_RECONNECT_COOLDOWN meeting_id={} cooldown_until={} now={}",
                self.meeting_key,
                self._cooldown_until,
                now,
            )
            self._fail_pending(audio, exc)
            return False

        if len(self._reconnect_history) >= self.RECONNECT_BUDGET:
            stt_metrics.reconnect_budget_exhausted()
            self._cooldown_until = now + self.RECONNECT_COOLDOWN_SECONDS
            self._set_shared_cooldown(self._cooldown_until)
            self._requires_new_stream = True
            logger.warning(
                "STT_RECONNECT_COOLDOWN meeting_id={} reason=budget_exhausted cooldown_until={}",
                self.meeting_key,
                self._cooldown_until,
            )
            self._fail_pending(audio, exc)
            return False

        stt_metrics.reconnect_attempt()
        self._reconnect_history.append(now)
        try:
            if self.state == MeetingSessionState.ACTIVE:
                await self._transition(
                    MeetingSessionState.HALF_OPEN, "reconnect_half_open"
                )
            self.session_id = None
            await self._transition(
                MeetingSessionState.CONNECTING, "reconnect_requested"
            )
            await self._connect_session()
            await self._transition(MeetingSessionState.ACTIVE, "reconnect_success")
            return True
        except Exception as reconnect_error:
            logger.warning(
                "STT_SEND_RETRY meeting_id={} reconnect_failed error={}",
                self.meeting_key,
                repr(reconnect_error),
            )
            self._fail_pending(audio, reconnect_error)
            await self._transition(MeetingSessionState.FAILED, "reconnect_failed")
            return False

    def _should_block_reconnect_for_audio(self, audio: AudioEnvelope) -> bool:
        if audio.seq <= 1:
            return False
        return not self._is_webm_header_chunk(audio.pcm_chunk)

    def _is_webm_header_chunk(self, pcm_chunk: bytes) -> bool:
        return bytes(pcm_chunk[:4]) == _WEBM_HEADER_MAGIC

    def _describe_terminal_error(
        self, exc: BaseException
    ) -> tuple[str | None, str | None, str]:
        for cause in _iter_exception_chain(exc):
            code = getattr(cause, "code", None)
            reason = getattr(cause, "reason", None)
            if code is not None or reason is not None:
                return (
                    None if code is None else str(code),
                    None if reason is None else str(reason),
                    type(cause).__name__,
                )
        return None, None, type(exc).__name__

    def _fail_pending(self, audio: AudioEnvelope, exc: Exception) -> None:
        future = audio.future
        if future is not None and not future.done():
            future.set_exception(exc)
        self._pending_futures.pop(audio.seq, None)
        self._response_cache.pop(audio.seq, None)
        stt_metrics.dropped_chunk("audio")

    def _cancel_pending_futures(self, exc: Exception) -> None:
        for seq, future in list(self._pending_futures.items()):
            if future is self._finalization_future:
                continue
            if not future.done():
                future.set_exception(exc)
            self._pending_futures.pop(seq, None)

    async def _recv_pump(self) -> None:
        try:
            logger.info(
                "STT_RECV_PUMP_RUNNING meeting_id={} session_id={}",
                self.meeting_key,
                self.session_id,
            )
            while True:
                recv = await self._recv_queue.get()
                self._assert_owns_meeting("recv")
                self._record_queue_metrics()
                if self.session_id is None:
                    raise RuntimeError("STT session is not connected")
                transcript_events: list[dict[str, Any]] = []
                try:
                    recv_started = time.perf_counter()
                    if hasattr(self.adapter, "recv_transcript_events"):
                        transcript_events = await self.adapter.recv_transcript_events(
                            self.session_id,
                            recv.ts_ms,
                            drain_timeout=self.RECV_DRAIN_TIMEOUT_SECONDS,
                        )
                    else:
                        transcript_events = self.adapter.drain_partial_events(
                            self.session_id
                        )
                    stt_metrics.observe_recv_latency_ms(
                        (time.perf_counter() - recv_started) * 1000.0
                    )
                    self._mark_recv_activity()
                except Exception as exc:
                    if is_transient_error(exc):
                        logger.warning(
                            "STT_RECV_BACKPRESSURE meeting_id={} seq={} error={}",
                            self.meeting_key,
                            recv.seq,
                            repr(exc),
                        )
                        await asyncio.sleep(self.TRANSIENT_RETRY_BASE_SECONDS)
                        transcript_events = []
                    else:
                        raise
                await self._enqueue_persist(
                    PersistEnvelope(
                        seq=recv.seq,
                        ts_ms=recv.ts_ms,
                        is_final=recv.is_final,
                        event_id=recv.event_id,
                        transcript_events=list(transcript_events),
                        size_bytes=max(1, len(transcript_events) or 1),
                        future=recv.future,
                    )
                )
        except asyncio.CancelledError:
            return
        except Exception:
            await self._transition(MeetingSessionState.FAILED, "recv_pump_error")
            raise

    async def _persist_pump(self) -> None:
        db = self.db_session_factory()
        try:
            repository = TranscriptPersistenceRepository(db)
            while True:
                persist = await self._persist_queue.get()
                self._assert_owns_meeting("persist")
                self._record_queue_metrics()
                persist_started = time.perf_counter()
                dedupe_key = self._build_persist_dedupe_key(persist)
                response: SttStreamResponse | None = None
                retry_due_to_dedupe = False
                while True:
                    try:
                        response = self._persist_event(repository, persist)
                        if response is not None:
                            self._response_cache[persist.seq] = response
                            self._last_persisted_response = response
                        self._last_ack_seq = max(self._last_ack_seq, persist.seq)
                        self._last_persisted_seq = max(
                            self._last_persisted_seq, persist.seq
                        )
                        stt_metrics.observe_persist_lag_ms(
                            max(0.0, time.time() * 1000.0 - float(persist.ts_ms))
                        )
                        stt_metrics.observe_ack_lag_ms(
                            max(0.0, time.time() * 1000.0 - float(persist.ts_ms))
                        )
                        repository.upsert_checkpoint(
                            (
                                int(self.meeting_key)
                                if str(self.meeting_key).isdigit()
                                else 0
                            ),
                            last_ack_seq=self._last_ack_seq,
                            last_persisted_seq=self._last_persisted_seq,
                            last_finalized_seq=self._last_finalized_seq,
                        )
                        db.commit()
                        break
                    except IntegrityError as exc:
                        db.rollback()
                        if retry_due_to_dedupe or not self._is_dedupe_integrity_error(
                            exc
                        ):
                            raise
                        logger.info(
                            "STT_FRAGMENT_DEDUPE_HIT meeting_id={} seq={} dedupe_key={}",
                            self.meeting_key,
                            persist.seq,
                            dedupe_key,
                        )
                        retry_due_to_dedupe = True
                        continue
                stt_metrics.observe_persist_duration_ms(
                    (time.perf_counter() - persist_started) * 1000.0
                )
                self._mark_persist_activity()
                logger.info(
                    "STT_ACK_ADVANCE meeting_id={} seq={} last_ack_seq={} last_persisted_seq={}",
                    self.meeting_key,
                    persist.seq,
                    self._last_ack_seq,
                    self._last_persisted_seq,
                )
                await self._drain_ready_audio()
                if persist.is_final:
                    self._last_finalized_seq = max(
                        self._last_finalized_seq, persist.seq
                    )
                    logger.info(
                        "STT_FINALIZATION_FLUSH_BARRIER meeting_id={} seq={}",
                        self.meeting_key,
                        persist.seq,
                    )
                    if response is not None and response.transcript:
                        self._final_response = response
                    else:
                        final_text = repository.assemble_transcript_text(
                            int(self.meeting_key)
                            if str(self.meeting_key).isdigit()
                            else 0
                        )
                        self._final_response = SttStreamResponse(
                            transcript=final_text,
                            is_final=True,
                            confidence=None,
                        )
                    try:
                        await self._transition(
                            MeetingSessionState.DRAINING, "finalization_complete"
                        )
                    except RuntimeError:
                        pass
                    self._pending_futures.pop(persist.seq, None)
                    await self.shutdown()
                    if persist.future is not None and not persist.future.done():
                        persist.future.set_result(
                            self._final_response
                            or response
                            or self._response_cache.get(persist.seq)
                            or SttStreamResponse(
                                transcript="", is_final=True, confidence=None
                            )
                        )
                    return
                if persist.future is not None and not persist.future.done():
                    persist.future.set_result(
                        response
                        or self._response_cache.get(persist.seq)
                        or SttStreamResponse(
                            transcript="", is_final=persist.is_final, confidence=None
                        )
                    )
        except asyncio.CancelledError:
            return
        except Exception as exc:
            logger.exception(
                "STT_PERSIST_CHECKPOINT meeting_id={} error={}",
                self.meeting_key,
                repr(exc),
            )
            await self._transition(MeetingSessionState.FAILED, "persist_pump_error")
            raise
        finally:
            db.close()

    def _is_dedupe_integrity_error(self, exc: BaseException) -> bool:
        text = f"{type(exc).__name__} {exc}".lower()
        return (
            "uq_transcript_fragments_dedupe_key" in text
            or "transcript_fragments_dedupe_key" in text
            or ("dedupe_key" in text and "unique" in text)
            or "duplicate key value violates unique constraint" in text
        )

    def _persist_event(
        self,
        repository: TranscriptPersistenceRepository,
        persist: PersistEnvelope,
    ) -> SttStreamResponse | None:
        meeting_id_int = int(self.meeting_key) if str(self.meeting_key).isdigit() else 0
        last_response: SttStreamResponse | None = None
        for event in persist.transcript_events:
            text = str(event.get("text") or "").strip()
            if not text:
                continue
            start_time = self._coerce_fragment_time(
                event.get("start_time"),
                fallback_seconds=float(persist.ts_ms) / 1000.0,
            )
            end_time = self._coerce_fragment_time(
                event.get("end_time"),
                fallback_seconds=(
                    start_time
                    if start_time is not None
                    else float(persist.ts_ms) / 1000.0
                ),
            )
            duration = self._coerce_fragment_time(
                event.get("duration"), fallback_seconds=None
            )
            if start_time is None and end_time is not None and duration is not None:
                start_time = max(0.0, end_time - duration)
            if start_time is None and end_time is not None:
                start_time = end_time
            if end_time is None and start_time is not None and duration is not None:
                end_time = start_time + duration
            if end_time is None and start_time is not None:
                end_time = start_time
            if start_time is None:
                start_time = max(0.0, float(persist.ts_ms) / 1000.0)
            if end_time is None:
                end_time = start_time
            start_time = max(0.0, float(start_time))
            end_time = max(start_time, float(end_time))
            fragment = TranscriptFragmentInput(
                meeting_id=meeting_id_int,
                seq=persist.seq,
                text=text,
                speaker=str(event.get("speaker") or "system"),
                start_time=start_time,
                end_time=end_time,
                event_id=str(
                    event.get("segment_id") or event.get("event_id") or persist.event_id
                ),
                is_final=bool(event.get("is_final") or persist.is_final),
                confidence=(
                    float(event.get("confidence"))
                    if isinstance(event.get("confidence"), (int, float))
                    else None
                ),
            )
            repository.append_fragment(fragment)
            last_response = SttStreamResponse(
                transcript=text,
                is_final=bool(fragment.is_final),
                confidence=fragment.confidence,
            )

        if last_response is None:
            last_response = SttStreamResponse(
                transcript="", is_final=bool(persist.is_final), confidence=None
            )
        return last_response

    def _coerce_fragment_time(
        self, value: Any, fallback_seconds: float | None
    ) -> float | None:
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            stripped = value.strip()
            if stripped:
                try:
                    return float(stripped)
                except ValueError:
                    pass
        return fallback_seconds

    def _build_persist_dedupe_key(self, persist: PersistEnvelope) -> str | None:
        meeting_id_int = int(self.meeting_key) if str(self.meeting_key).isdigit() else 0
        for event in persist.transcript_events:
            text = str(event.get("text") or "").strip()
            if not text:
                continue
            start_time = self._coerce_fragment_time(
                event.get("start_time"), fallback_seconds=float(persist.ts_ms) / 1000.0
            )
            end_time = self._coerce_fragment_time(
                event.get("end_time"), fallback_seconds=start_time
            )
            if start_time is None:
                start_time = max(0.0, float(persist.ts_ms) / 1000.0)
            if end_time is None:
                end_time = start_time
            fragment = TranscriptFragmentInput(
                meeting_id=meeting_id_int,
                seq=persist.seq,
                text=text,
                speaker=str(event.get("speaker") or "system"),
                start_time=float(start_time),
                end_time=max(float(start_time), float(end_time)),
                event_id=str(
                    event.get("segment_id") or event.get("event_id") or persist.event_id
                ),
                is_final=bool(event.get("is_final") or persist.is_final),
                confidence=(
                    float(event.get("confidence"))
                    if isinstance(event.get("confidence"), (int, float))
                    else None
                ),
            )
            return build_fragment_dedupe_key(fragment)
        return None

    def _next_expected_seq(self) -> int:
        return self._last_ack_seq + 1

    def _owns_meeting(self) -> bool:
        if self.lease is None or self.ownership_manager is None:
            return True
        try:
            return self.ownership_manager.validate(self.lease)
        except Exception as exc:
            logger.warning(
                "STT_OWNERSHIP_VALIDATE_ERROR meeting_id={} fencing_token={} error={}",
                self.meeting_key,
                self.fencing_token,
                repr(exc),
            )
            return False

    def _refresh_or_mark_ownership_lost(self, operation: str) -> bool:
        if self.lease is None or self.ownership_manager is None:
            return True
        try:
            if self.ownership_manager.refresh(self.lease):
                return True
        except Exception as exc:
            logger.warning(
                "STT_OWNERSHIP_REFRESH_ERROR meeting_id={} operation={} fencing_token={} error={}",
                self.meeting_key,
                operation,
                self.fencing_token,
                repr(exc),
            )
        self._mark_ownership_lost(operation)
        return False

    def _assert_owns_meeting(self, operation: str) -> None:
        if self._refresh_or_mark_ownership_lost(operation):
            return
        raise SttOwnershipLost(
            f"STT ownership lost for meeting {self.meeting_key} during {operation}"
        )

    def _mark_ownership_lost(self, operation: str) -> None:
        exc = SttOwnershipLost(
            f"STT ownership lost for meeting {self.meeting_key} during {operation}"
        )
        logger.warning(
            "STT_OWNERSHIP_LOST meeting_id={} operation={} fencing_token={}",
            self.meeting_key,
            operation,
            self.fencing_token,
        )
        stt_metrics.ownership_event("lost")
        if self.state not in {MeetingSessionState.CLOSED, MeetingSessionState.FAILED}:
            try:
                self.state = MeetingSessionState.FAILED
                self._record_state_metrics(self.state)
            except Exception:
                pass
        self._cancel_pending_futures(exc)
        if (
            self._finalization_future is not None
            and not self._finalization_future.done()
        ):
            self._finalization_future.set_exception(exc)

    def _release_lease(self) -> None:
        if self.lease is None or self.ownership_manager is None:
            return
        try:
            released = self.ownership_manager.release(self.lease)
        except Exception as exc:
            logger.warning(
                "STT_OWNERSHIP_RELEASE_ERROR meeting_id={} fencing_token={} error={}",
                self.meeting_key,
                self.fencing_token,
                repr(exc),
            )
            return
        if not released:
            stt_metrics.ownership_event("release_skipped")
            logger.warning(
                "STT_OWNERSHIP_RELEASE_SKIPPED meeting_id={} fencing_token={} reason=lease_mismatch",
                self.meeting_key,
                self.fencing_token,
            )
        else:
            stt_metrics.ownership_event("released")

    def _set_shared_cooldown(self, cooldown_until: float) -> None:
        if self.ownership_manager is None:
            return
        try:
            self.ownership_manager.set_cooldown_until(
                self.meeting_key, float(cooldown_until)
            )
        except Exception as exc:
            logger.warning(
                "STT_OWNERSHIP_COOLDOWN_WRITE_ERROR meeting_id={} error={}",
                self.meeting_key,
                repr(exc),
            )
