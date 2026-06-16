import json

from app.services.analysis_retry_scheduler import (
    BACKOFF_SCHEDULE_SECONDS,
    RetryQueueEntry,
    compute_retry_delay_seconds,
    enqueue_background_retry,
    is_retryable_error_code,
    pop_due_retries,
    serialize_queue_member,
)


class FakeRedis:
    def __init__(self):
        self.zset: dict[str, float] = {}

    def zadd(self, key, mapping):
        self.zset.update(mapping)

    def zrangebyscore(self, key, _min, _max):
        return [member for member, score in self.zset.items() if score <= float(_max)]

    def zrem(self, key, member):
        self.zset.pop(member, None)


def test_backoff_schedule_indexes():
    assert compute_retry_delay_seconds(2) >= 1
    assert compute_retry_delay_seconds(5) >= BACKOFF_SCHEDULE_SECONDS[-1] * 0.8


def test_enqueue_and_pop_due_retry():
    redis = FakeRedis()
    entry = enqueue_background_retry(
        redis,
        meeting_id=42,
        analysis_attempt=1,
        analysis_input_hash="abc123",
        trace_id="trace-1",
        source="background_retry",
        max_attempts=4,
        enabled=True,
    )
    assert entry is not None
    assert entry.analysis_attempt == 2
    due = pop_due_retries(redis, now=entry.next_retry_at + 1)
    assert len(due) == 1
    assert due[0].meeting_id == 42


def test_max_attempts_exhausted_returns_none():
    redis = FakeRedis()
    entry = enqueue_background_retry(
        redis,
        meeting_id=7,
        analysis_attempt=5,
        analysis_input_hash="hash",
        trace_id="trace",
        source="background_retry",
        max_attempts=4,
        enabled=True,
    )
    assert entry is None


def test_retryable_error_codes():
    assert is_retryable_error_code("GEMINI_UNAVAILABLE")
    assert is_retryable_error_code("GEMINI_RATE_LIMITED")
    assert not is_retryable_error_code("GEMINI_ANALYSIS_FAILED")


def test_serialize_queue_member_roundtrip():
    payload = json.loads(
        serialize_queue_member(
            RetryQueueEntry(
                meeting_id=1,
                analysis_attempt=2,
                analysis_input_hash="hash",
                trace_id="t",
                source="background_retry",
                next_retry_at=0.0,
            )
        )
    )
    assert payload["meetingId"] == 1
    assert payload["analysisAttempt"] == 2


def test_celery_beat_registers_analysis_retry_scheduled():
    from app.celery_app import celery_app

    schedule = celery_app.conf.beat_schedule
    assert "analysis-retry-scheduled" in schedule
    assert (
        schedule["analysis-retry-scheduled"]["task"]
        == "app.tasks.analysis_retry_scheduled"
    )
    assert schedule["analysis-retry-scheduled"]["schedule"] == 60.0
    assert celery_app.tasks.get("app.tasks.analysis_retry_scheduled") is not None
