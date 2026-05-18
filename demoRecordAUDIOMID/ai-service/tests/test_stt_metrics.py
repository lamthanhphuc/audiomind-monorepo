from prometheus_client import REGISTRY

from app.metrics import stt_metrics


def test_stt_metrics_publish_bounded_labels():
    stt_metrics.actor_started()
    stt_metrics.record_state("ACTIVE")
    stt_metrics.record_transition("CREATED", "ACTIVE")
    stt_metrics.record_queue_depths(1, 2, 3)
    stt_metrics.reconnect_attempt()
    stt_metrics.reconnect_budget_exhausted()
    stt_metrics.reconnect_cooldown_hit()
    stt_metrics.dropped_chunk("audio")
    stt_metrics.duplicate_seq()
    stt_metrics.replay_seq()
    stt_metrics.observe_recv_lag_ms(12.5)
    stt_metrics.observe_persist_lag_ms(13.5)
    stt_metrics.observe_ack_lag_ms(14.5)
    stt_metrics.observe_send_latency_ms(3.5)
    stt_metrics.observe_recv_latency_ms(4.5)
    stt_metrics.observe_shutdown_drain_ms(5.5)
    stt_metrics.ownership_event("acquired")
    stt_metrics.actor_stopped()

    families = {family.name: family for family in REGISTRY.collect()}
    assert "ai_stt_actor_count" in families
    assert "ai_stt_actor_state" in families
    assert "ai_stt_audio_queue_depth" in families
    assert "ai_stt_reconnect_attempts" in families
    assert "ai_stt_shutdown_drain_time_ms" in families
    assert "ai_stt_ownership_events" in families
