from types import SimpleNamespace

import app.main as main_module
from app.logging_utils import transcript_hash_prefix
from app.services.stt_adapter import DeepgramSTTAdapter


def test_resolve_realtime_session_diagnostics_uses_fallback_when_actor_missing():
    diagnostics = main_module._resolve_realtime_session_diagnostics(
        None, fallback_transcript="xin chao"
    )

    assert diagnostics["final_segment_count"] == 0
    assert diagnostics["speech_final_count"] == 0
    assert diagnostics["is_final_count"] == 0
    assert diagnostics["transcript_length"] == len("xin chao")
    assert diagnostics["transcript_hash_prefix"] == transcript_hash_prefix("xin chao")


def test_resolve_realtime_session_diagnostics_reads_adapter_counts():
    fake_adapter = SimpleNamespace(
        get_session_diagnostics=lambda session_id: {
            "final_segment_count": 3,
            "speech_final_count": 2,
            "is_final_count": 4,
            "transcript_length": 21,
            "transcript_hash_prefix": "abc123def456",
        }
    )
    fake_actor = SimpleNamespace(adapter=fake_adapter, session_id="session-42")

    diagnostics = main_module._resolve_realtime_session_diagnostics(
        fake_actor, fallback_transcript="ignored"
    )

    assert diagnostics["final_segment_count"] == 3
    assert diagnostics["speech_final_count"] == 2
    assert diagnostics["is_final_count"] == 4
    assert diagnostics["transcript_length"] == 21
    assert diagnostics["transcript_hash_prefix"] == "abc123def456"


def test_deepgram_adapter_tracks_realtime_final_diagnostic_counters():
    adapter = DeepgramSTTAdapter(api_key="dg-test-key")
    session = SimpleNamespace(
        session_id="session-1",
        meeting_id=101,
        language="multi",
        metadata_events=0,
        results_events=0,
        speech_started_events=0,
        utterance_end_events=0,
        other_events=0,
        consecutive_empty_results=0,
        last_text_result_at=0.0,
        fallback_segment_counter=0,
        fallback_segment_ids={},
        is_final_count=0,
        speech_final_count=0,
        final_segment_count=0,
        transcript="",
    )

    event = adapter._parse_transcript_message(
        {
            "type": "Results",
            "channel": {"alternatives": [{"transcript": "xin chao"}]},
            "is_final": True,
            "speech_final": True,
        },
        ts_ms=10,
        session=session,
    )

    assert event is not None
    session.transcript = str(event["text"] or "")
    adapter._sessions["session-1"] = session

    diagnostics = adapter.get_session_diagnostics("session-1")
    assert diagnostics["final_segment_count"] == 1
    assert diagnostics["speech_final_count"] == 1
    assert diagnostics["is_final_count"] == 1
    assert diagnostics["transcript_length"] == len("xin chao")
    assert diagnostics["transcript_hash_prefix"] == transcript_hash_prefix("xin chao")
