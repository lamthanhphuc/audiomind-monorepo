import importlib.util
from pathlib import Path
from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import UUID

MODULE_PATH = Path(__file__).resolve().parents[1] / "app" / "job_status_store.py"
SPEC = importlib.util.spec_from_file_location("job_status_store", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakePipeline:
    def __init__(self, client):
        self.client = client

    def watch(self, key):
        return None

    def multi(self):
        return None

    def hset(self, key, mapping):
        self.client.hset(key, mapping=mapping)

    def expire(self, key, ttl):
        self.client.expire(key, ttl)

    def execute(self):
        return None

    def reset(self):
        return None


class FakeRedis:
    def __init__(self):
        self.hashes = {}
        self.expirations = {}

    def pipeline(self):
        return FakePipeline(self)

    def type(self, key):
        return "hash" if key in self.hashes else "none"

    def hgetall(self, key):
        return dict(self.hashes.get(key, {}))

    def hset(self, key, mapping):
        self.hashes.setdefault(key, {}).update(mapping)

    def expire(self, key, ttl):
        self.expirations[key] = ttl


ALLOWED_CASES = [
    ("UNKNOWN", "QUEUED"),
    ("QUEUED", "RUNNING"),
    ("RUNNING", "COMPLETED"),
    ("RUNNING", "FAILED"),
    ("RETRYING", "RUNNING"),
]

DISALLOWED_CASES = [
    ("COMPLETED", "FAILED"),
    ("FAILED", "COMPLETED"),
    ("FAILED", "RUNNING"),
    ("QUEUED", "QUEUED_INVALID"),
]


def test_allowed_transition_matrix_examples():
    for current, nxt in ALLOWED_CASES:
        assert MODULE._is_allowed_transition(current, nxt)


def test_rejects_terminal_state_overwrite_race_paths():
    for current, nxt in DISALLOWED_CASES:
        assert not MODULE._is_allowed_transition(current, nxt)


def test_make_json_safe_normalizes_nested_non_json_values():
    analyzed_at = datetime(2026, 6, 4, 12, 30, tzinfo=timezone.utc)
    payload = {
        "lastAnalyzedAt": analyzed_at,
        "completedOn": date(2026, 6, 4),
        "cost": Decimal("12.34"),
        "id": UUID("12345678-1234-5678-1234-567812345678"),
        "items": ("a", {"b"}),
        date(2026, 6, 5): "date-key",
    }

    normalized = MODULE.make_json_safe(payload)

    assert normalized["lastAnalyzedAt"] == analyzed_at.isoformat()
    assert normalized["completedOn"] == "2026-06-04"
    assert normalized["cost"] == "12.34"
    assert normalized["id"] == "12345678-1234-5678-1234-567812345678"
    assert normalized["items"][0] == "a"
    assert set(normalized["items"][1]) == {"b"}
    assert normalized["2026-06-05"] == "date-key"


def test_set_job_status_accepts_nested_datetime_result(monkeypatch):
    fake_redis = FakeRedis()
    analyzed_at = datetime(2026, 6, 4, 12, 30, tzinfo=timezone.utc)
    monkeypatch.setattr(MODULE, "_get_client", lambda: fake_redis)

    MODULE.set_job_status(6, "QUEUED")
    MODULE.set_job_status(6, "RUNNING")
    MODULE.set_job_status(
        6,
        "COMPLETED",
        result={
            "analysis": {
                "summary": "done",
                "analysisStatus": "COMPLETED",
                "cacheHit": False,
                "lastAnalyzedAt": analyzed_at,
                "metadata": {"completedAt": analyzed_at},
            }
        },
    )

    status = MODULE.get_job_status(6)

    assert status["status"] == "COMPLETED"
    assert status["progress"] == 100
    assert status["stage"] == "completed"
    assert status["result"]["analysis"]["lastAnalyzedAt"] == analyzed_at.isoformat()
    assert (
        status["result"]["analysis"]["metadata"]["completedAt"]
        == analyzed_at.isoformat()
    )


def test_cache_hit_metadata_datetime_can_be_written_to_redis(monkeypatch):
    fake_redis = FakeRedis()
    analyzed_at = datetime(2026, 6, 4, 13, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(MODULE, "_get_client", lambda: fake_redis)

    MODULE.set_job_status(7, "QUEUED")
    MODULE.set_job_status(7, "RUNNING")
    MODULE.set_job_status(
        7,
        "COMPLETED",
        result={
            "analysis": {
                "summary": "cached",
                "analysisStatus": "COMPLETED",
                "cacheHit": True,
                "lastAnalyzedAt": analyzed_at,
            },
            "source": "realtime",
        },
    )

    status = MODULE.get_job_status(7)

    assert status["status"] == "COMPLETED"
    assert status["result"]["analysis"]["cacheHit"] is True
    assert status["result"]["analysis"]["lastAnalyzedAt"] == analyzed_at.isoformat()


def test_set_job_status_writes_minimal_state_after_unexpected_serialization_failure(
    monkeypatch,
):
    fake_redis = FakeRedis()
    monkeypatch.setattr(MODULE, "_get_client", lambda: fake_redis)

    def fail_json_dump(value, *, meeting_id, field_name):
        raise TypeError("forced serialization failure")

    monkeypatch.setattr(MODULE, "_json_dump_job_field", fail_json_dump)

    MODULE.set_job_status(8, "QUEUED")
    MODULE.set_job_status(8, "RUNNING")
    MODULE.set_job_status(8, "COMPLETED", result={"analysis": {"summary": "done"}})

    status = MODULE.get_job_status(8)
    raw_hash = fake_redis.hashes["job:8"]

    assert status["status"] == "COMPLETED"
    assert status["progress"] == 100
    assert status["stage"] == "completed"
    assert status["result"] is None
    assert raw_hash["message"].startswith(
        "job status metadata omitted after serialization failure"
    )
