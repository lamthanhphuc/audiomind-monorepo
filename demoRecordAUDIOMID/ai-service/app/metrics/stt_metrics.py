from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from prometheus_client import Counter, Gauge, Histogram


class STTMetricState(str, Enum):
    CREATED = "CREATED"
    CONNECTING = "CONNECTING"
    ACTIVE = "ACTIVE"
    HALF_OPEN = "HALF_OPEN"
    DEGRADED = "DEGRADED"
    DRAINING = "DRAINING"
    CLOSING = "CLOSING"
    CLOSED = "CLOSED"
    FAILED = "FAILED"


_STT_ACTOR_COUNT = Gauge(
    "ai_stt_actor_count",
    "Number of active STT actors.",
)
_STT_ACTOR_STATE = Gauge(
    "ai_stt_actor_state",
    "Current actor state values, bounded by the finite state machine.",
    ["state"],
)
_STT_AUDIO_QUEUE_DEPTH = Gauge(
    "ai_stt_audio_queue_depth",
    "Current audio queue depth.",
)
_STT_RECV_QUEUE_DEPTH = Gauge(
    "ai_stt_recv_queue_depth",
    "Current recv queue depth.",
)
_STT_PERSIST_QUEUE_DEPTH = Gauge(
    "ai_stt_persist_queue_depth",
    "Current persist queue depth.",
)
_STT_RECONNECT_ATTEMPTS = Counter(
    "ai_stt_reconnect_attempts_total",
    "Total reconnect attempts.",
)
_STT_RECONNECT_BUDGET_EXHAUSTED = Counter(
    "ai_stt_reconnect_budget_exhausted_total",
    "Total reconnect budget exhaustion events.",
)
_STT_RECONNECT_COOLDOWN_HITS = Counter(
    "ai_stt_reconnect_cooldown_hits_total",
    "Total reconnect cooldown hits.",
)
_STT_DROPPED_CHUNKS = Counter(
    "ai_stt_dropped_chunks_total",
    "Total dropped chunks due to overload or shutdown.",
    ["queue"],
)
_STT_DUPLICATE_SEQ = Counter(
    "ai_stt_duplicate_seq_total",
    "Total duplicate sequence submissions.",
)
_STT_REPLAY_SEQ = Counter(
    "ai_stt_replay_seq_total",
    "Total replayed or deduplicated sequence submissions.",
)
_STT_RECV_LAG_MS = Histogram(
    "ai_stt_recv_lag_ms",
    "Lag between audio timestamp and recv processing.",
    buckets=(1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000),
)
_STT_PERSIST_LAG_MS = Histogram(
    "ai_stt_persist_lag_ms",
    "Lag between audio timestamp and persistence.",
    buckets=(1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000),
)
_STT_ACK_LAG_MS = Histogram(
    "ai_stt_ack_lag_ms",
    "Lag between audio timestamp and ack advancement.",
    buckets=(1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000),
)
_STT_WEBSOCKET_SEND_LATENCY_MS = Histogram(
    "ai_stt_websocket_send_latency_ms",
    "Latency to send audio to the websocket.",
    buckets=(1, 2, 5, 10, 20, 50, 100, 250, 500, 1000, 2500),
)
_STT_WEBSOCKET_RECV_LATENCY_MS = Histogram(
    "ai_stt_websocket_recv_latency_ms",
    "Latency to receive transcript events from the websocket.",
    buckets=(1, 2, 5, 10, 20, 50, 100, 250, 500, 1000, 2500),
)
_STT_PERSIST_DURATION_MS = Histogram(
    "ai_stt_persist_duration_ms",
    "Latency to persist transcript events and checkpoints.",
    buckets=(1, 2, 5, 10, 20, 50, 100, 250, 500, 1000, 2500),
)
_STT_SHUTDOWN_DRAIN_TIME_MS = Histogram(
    "ai_stt_shutdown_drain_time_ms",
    "Time spent draining actor shutdown.",
    buckets=(1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000),
)
_STT_TRANSITIONS = Counter(
    "ai_stt_state_transitions_total",
    "Total actor state transitions.",
    ["from_state", "to_state"],
)


@dataclass(slots=True)
class STTMetrics:
    def actor_started(self) -> None:
        _STT_ACTOR_COUNT.inc()

    def actor_stopped(self) -> None:
        if _STT_ACTOR_COUNT._value.get() > 0:  # type: ignore[attr-defined]
            _STT_ACTOR_COUNT.dec()

    def record_state(self, state: str) -> None:
        bounded_state = (
            state
            if state in STTMetricState._value2member_map_
            else STTMetricState.FAILED.value
        )
        for candidate in STTMetricState:
            _STT_ACTOR_STATE.labels(state=candidate.value).set(
                1 if candidate.value == bounded_state else 0
            )

    def record_transition(self, from_state: str, to_state: str) -> None:
        bounded_from = (
            from_state
            if from_state in STTMetricState._value2member_map_
            else STTMetricState.FAILED.value
        )
        bounded_to = (
            to_state
            if to_state in STTMetricState._value2member_map_
            else STTMetricState.FAILED.value
        )
        _STT_TRANSITIONS.labels(from_state=bounded_from, to_state=bounded_to).inc()

    def record_queue_depths(self, audio: int, recv: int, persist: int) -> None:
        _STT_AUDIO_QUEUE_DEPTH.set(max(0, int(audio)))
        _STT_RECV_QUEUE_DEPTH.set(max(0, int(recv)))
        _STT_PERSIST_QUEUE_DEPTH.set(max(0, int(persist)))

    def reconnect_attempt(self) -> None:
        _STT_RECONNECT_ATTEMPTS.inc()

    def reconnect_budget_exhausted(self) -> None:
        _STT_RECONNECT_BUDGET_EXHAUSTED.inc()

    def reconnect_cooldown_hit(self) -> None:
        _STT_RECONNECT_COOLDOWN_HITS.inc()

    def dropped_chunk(self, queue_name: str) -> None:
        _STT_DROPPED_CHUNKS.labels(queue=queue_name).inc()

    def duplicate_seq(self) -> None:
        _STT_DUPLICATE_SEQ.inc()

    def replay_seq(self) -> None:
        _STT_REPLAY_SEQ.inc()

    def observe_recv_lag_ms(self, value: float) -> None:
        _STT_RECV_LAG_MS.observe(max(0.0, float(value)))

    def observe_persist_lag_ms(self, value: float) -> None:
        _STT_PERSIST_LAG_MS.observe(max(0.0, float(value)))

    def observe_ack_lag_ms(self, value: float) -> None:
        _STT_ACK_LAG_MS.observe(max(0.0, float(value)))

    def observe_send_latency_ms(self, value: float) -> None:
        _STT_WEBSOCKET_SEND_LATENCY_MS.observe(max(0.0, float(value)))

    def observe_recv_latency_ms(self, value: float) -> None:
        _STT_WEBSOCKET_RECV_LATENCY_MS.observe(max(0.0, float(value)))

    def observe_persist_duration_ms(self, value: float) -> None:
        _STT_PERSIST_DURATION_MS.observe(max(0.0, float(value)))

    def observe_shutdown_drain_ms(self, value: float) -> None:
        _STT_SHUTDOWN_DRAIN_TIME_MS.observe(max(0.0, float(value)))


stt_metrics = STTMetrics()
