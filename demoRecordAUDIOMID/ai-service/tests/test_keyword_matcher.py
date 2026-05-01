from app.services.keyword_matcher import (
    KeywordHit,
    KeywordMatcher,
    RedisKeywordEventPublisher,
)


class _FakeRedisClient:
    def __init__(self):
        self.calls = []

    def xadd(self, stream_name, payload, maxlen=None, approximate=None):
        self.calls.append(
            {
                "stream_name": stream_name,
                "payload": payload,
                "maxlen": maxlen,
                "approximate": approximate,
            }
        )
        return b"174"


def test_keyword_matcher_finds_exact_and_fuzzy_hits():
    def provider(version: str):
        assert version == "v42"
        return [
            {"keyword_id": "kw-1", "term": "công nghệ thông tin"},
            {"keyword_id": "kw-2", "term": "API"},
        ]

    matcher = KeywordMatcher(provider, min_confidence=0.75)

    hits = matcher.match(
        "Nhom ban ve cong nghe thong tin va kiem thu API cho he thong.",
        glossary_version="v42",
        lang="vi",
    )

    keyword_ids = {hit["keyword_id"] for hit in hits}
    assert "kw-1" in keyword_ids
    assert "kw-2" in keyword_ids
    assert all(hit["confidence"] >= 0.75 for hit in hits)
    assert all(len(hit["ranges"]) == 2 for hit in hits)


def test_keyword_event_publisher_serializes_hit_to_redis_stream():
    redis_client = _FakeRedisClient()
    publisher = RedisKeywordEventPublisher(redis_client)
    hit = KeywordHit(
        keyword_id="kw-9",
        term="Deepgram",
        confidence=0.93,
        ranges=[12, 21],
    )

    message_id = publisher.publish(101, hit, trace_id="trace-1")

    assert message_id == "b'174'"
    assert redis_client.calls[0]["stream_name"] == "realtime.keyword_hits"
    assert redis_client.calls[0]["payload"]["meeting_id"] == 101
    assert redis_client.calls[0]["payload"]["keyword_id"] == "kw-9"
    assert redis_client.calls[0]["payload"]["trace_id"] == "trace-1"
