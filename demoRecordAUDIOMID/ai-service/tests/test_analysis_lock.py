import json
import time

from app.services.analysis_lock import (
    ANALYSIS_LOCK_TTL_SECONDS,
    acquire_analysis_lock,
    build_lock_payload,
    is_ai_owned_lock,
    lock_token_from_raw,
    parse_lock_payload,
    release_analysis_lock,
)


class FakeRedis:
    def __init__(self):
        self.values: dict[str, str] = {}
        self.ttl: dict[str, int] = {}

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.values:
            return False
        self.values[key] = value
        if ex is not None:
            self.ttl[key] = int(ex)
        return True

    def get(self, key):
        return self.values.get(key)

    def delete(self, key):
        self.values.pop(key, None)
        self.ttl.pop(key, None)

    def ttl(self, key):
        return self.ttl.get(key, -1)


def test_lock_payload_contains_spec_fields():
    payload = json.loads(
        build_lock_payload(
            meeting_id=99,
            analysis_input_hash="abc123",
            trigger_source="background",
            analysis_attempt=2,
            trace_id="trace-xyz",
            lock_token="aiapi:token",
            started_at=1000.0,
        )
    )
    assert payload["meetingId"] == 99
    assert payload["analysisInputHash"] == "abc123"
    assert payload["triggerSource"] == "background"
    assert payload["analysisAttempt"] == 2
    assert payload["traceId"] == "trace-xyz"
    assert payload["lockToken"] == "aiapi:token"
    assert payload["startedAt"] == 1000.0


def test_acquire_and_release_roundtrip():
    redis = FakeRedis()
    acquired, token, holder = acquire_analysis_lock(
        redis,
        lock_key="analysis:lock:42",
        meeting_id=42,
        analysis_input_hash="hash",
        trigger_source="manual",
        analysis_attempt=1,
        trace_id="trace-1",
        ttl_seconds=ANALYSIS_LOCK_TTL_SECONDS,
    )
    assert acquired is True
    assert token is not None
    assert is_ai_owned_lock(redis.get("analysis:lock:42"))
    assert holder["meetingId"] == 42

    release_analysis_lock(redis, "analysis:lock:42", token)
    assert redis.get("analysis:lock:42") is None


def test_background_lock_blocks_manual_acquire():
    redis = FakeRedis()
    acquired_bg, bg_token, _ = acquire_analysis_lock(
        redis,
        lock_key="analysis:lock:7",
        meeting_id=7,
        analysis_input_hash="hash-7",
        trigger_source="background",
        analysis_attempt=1,
        trace_id="bg-trace",
        ttl_seconds=600,
    )
    assert acquired_bg is True

    acquired_manual, manual_token, holder = acquire_analysis_lock(
        redis,
        lock_key="analysis:lock:7",
        meeting_id=7,
        analysis_input_hash="hash-7",
        trigger_source="manual",
        analysis_attempt=1,
        trace_id="manual-trace",
        ttl_seconds=600,
    )
    assert acquired_manual is False
    assert manual_token is None
    assert holder["triggerSource"] == "background"
    assert lock_token_from_raw(redis.get("analysis:lock:7")) == bg_token


def test_legacy_lock_token_still_parsable():
    assert parse_lock_payload("aiapi:legacy") == {"lockToken": "aiapi:legacy"}
    assert is_ai_owned_lock("aiapi:legacy") is True
