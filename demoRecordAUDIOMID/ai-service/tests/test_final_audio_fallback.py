from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.services.final_audio_fallback import run_final_audio_fallback


@pytest.fixture
def temp_audio_path(tmp_path: Path) -> str:
    audio_path = tmp_path / "sample.webm"
    audio_path.write_bytes(b"x" * 256)
    return str(audio_path)


def test_run_final_audio_fallback_rejects_tiny_audio(temp_audio_path: str):
    tiny_path = Path(temp_audio_path).parent / "tiny.webm"
    tiny_path.write_bytes(b"x" * 32)

    result = run_final_audio_fallback(
        meeting_id=42,
        audio_path=str(tiny_path),
        language="vi",
        trace_id="trace-42",
        request_id="req-42",
    )

    assert result["status"] == "failed"
    assert result["error_code"] == "FINAL_AUDIO_FALLBACK_UNAVAILABLE"
    assert result["transcript_count"] == 0


@patch("app.services.final_audio_fallback.SessionLocal")
@patch("app.services.final_audio_fallback._build_adapter")
def test_run_final_audio_fallback_persists_segments(
    build_adapter_mock: MagicMock,
    session_local_mock: MagicMock,
    temp_audio_path: str,
):
    session = MagicMock()
    session_local_mock.return_value = session
    repository = MagicMock()
    repository.list_fragments.return_value = []
    adapter = MagicMock()
    adapter.batch_transcribe_file.return_value = {
        "segments": [
            {
                "speaker": "SPEAKER_1",
                "text": "xin chao",
                "start": 0.0,
                "end": 1.2,
                "confidence": 0.9,
            }
        ]
    }
    build_adapter_mock.return_value = adapter

    with patch(
        "app.services.final_audio_fallback.TranscriptPersistenceRepository",
        return_value=repository,
    ):
        result = run_final_audio_fallback(
            meeting_id=99,
            audio_path=temp_audio_path,
            language="vi",
            trace_id="trace-99",
            request_id="req-99",
        )

    assert result["status"] == "completed"
    assert result["transcript_count"] == 1
    repository.append_fragment.assert_called_once()
    session.commit.assert_called_once()


@patch("app.services.final_audio_fallback.SessionLocal")
def test_run_final_audio_fallback_idempotent_replay(
    session_local_mock: MagicMock,
    temp_audio_path: str,
):
    session = MagicMock()
    session_local_mock.return_value = session
    repository = MagicMock()
    repository.list_fragments.return_value = [
        MagicMock(event_id="final-audio-fallback-99-1"),
    ]

    with patch(
        "app.services.final_audio_fallback.TranscriptPersistenceRepository",
        return_value=repository,
    ):
        result = run_final_audio_fallback(
            meeting_id=99,
            audio_path=temp_audio_path,
            language="vi",
            trace_id="trace-99",
            request_id="req-99",
        )

    assert result["status"] == "completed"
    assert result["idempotent_replay"] is True
    assert result["transcript_count"] == 1
    repository.append_fragment.assert_not_called()
