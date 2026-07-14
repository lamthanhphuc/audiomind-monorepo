from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.services.final_audio_fallback import run_final_audio_fallback
from app.services.final_audio_path_validation import (
    FinalAudioPathError,
    validate_final_audio_fallback_path,
)


@pytest.fixture
def allowed_root(tmp_path: Path) -> Path:
    root = tmp_path / "uploads"
    root.mkdir()
    return root


@pytest.fixture
def temp_audio_path(allowed_root: Path) -> str:
    audio_path = allowed_root / "sample.webm"
    audio_path.write_bytes(b"x" * 256)
    return str(audio_path)


def test_validate_accepts_file_in_allowed_root(allowed_root: Path):
    audio = allowed_root / "ok.webm"
    audio.write_bytes(b"x" * 256)
    with patch(
        "app.services.final_audio_path_validation._probe_has_audio_stream",
        return_value=True,
    ):
        resolved = validate_final_audio_fallback_path(
            str(audio),
            allowed_roots=[allowed_root.resolve()],
            require_audio_probe=True,
        )
    assert resolved == audio.resolve()


def test_validate_rejects_outside_allowed_root(tmp_path: Path, allowed_root: Path):
    outsider = tmp_path / "outside.webm"
    outsider.write_bytes(b"x" * 256)
    with pytest.raises(FinalAudioPathError) as exc:
        validate_final_audio_fallback_path(
            str(outsider),
            allowed_roots=[allowed_root.resolve()],
            require_audio_probe=False,
        )
    assert exc.value.code == "FINAL_AUDIO_PATH_FORBIDDEN"
    assert str(outsider) not in exc.value.safe_message


def test_validate_rejects_absolute_system_path(allowed_root: Path, tmp_path: Path):
    system_file = tmp_path / "etc-passwd.webm"
    system_file.write_bytes(b"x" * 256)
    with pytest.raises(FinalAudioPathError) as exc:
        validate_final_audio_fallback_path(
            str(system_file.resolve()),
            allowed_roots=[allowed_root.resolve()],
            require_audio_probe=False,
        )
    assert exc.value.code == "FINAL_AUDIO_PATH_FORBIDDEN"


def test_validate_rejects_traversal(allowed_root: Path, tmp_path: Path):
    outsider = tmp_path / "secret.webm"
    outsider.write_bytes(b"x" * 256)
    traversal = allowed_root / ".." / outsider.name
    with pytest.raises(FinalAudioPathError) as exc:
        validate_final_audio_fallback_path(
            str(traversal),
            allowed_roots=[allowed_root.resolve()],
            require_audio_probe=False,
        )
    assert exc.value.code in {"FINAL_AUDIO_PATH_FORBIDDEN", "FINAL_AUDIO_PATH_NOT_FOUND"}
    assert "secret" not in exc.value.safe_message or "not found" in exc.value.safe_message.lower()


def test_validate_rejects_symlink_escape(allowed_root: Path, tmp_path: Path):
    target = tmp_path / "escaped.webm"
    target.write_bytes(b"x" * 256)
    link = allowed_root / "link.webm"
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("symlinks unavailable in this environment")

    with pytest.raises(FinalAudioPathError) as exc:
        validate_final_audio_fallback_path(
            str(link),
            allowed_roots=[allowed_root.resolve()],
            require_audio_probe=False,
        )
    assert exc.value.code == "FINAL_AUDIO_SYMLINK_REJECTED"


def test_validate_rejects_unsupported_extension(allowed_root: Path):
    audio = allowed_root / "notes.txt"
    audio.write_bytes(b"x" * 256)
    with pytest.raises(FinalAudioPathError) as exc:
        validate_final_audio_fallback_path(
            str(audio),
            allowed_roots=[allowed_root.resolve()],
            require_audio_probe=False,
        )
    assert exc.value.code == "FINAL_AUDIO_EXTENSION_REJECTED"


def test_validate_rejects_missing_audio_stream(allowed_root: Path):
    audio = allowed_root / "empty-stream.webm"
    audio.write_bytes(b"x" * 256)
    with patch(
        "app.services.final_audio_path_validation._probe_has_audio_stream",
        side_effect=FinalAudioPathError(
            "FINAL_AUDIO_NO_AUDIO_STREAM",
            "Provided file does not contain a valid audio stream",
        ),
    ):
        with pytest.raises(FinalAudioPathError) as exc:
            validate_final_audio_fallback_path(
                str(audio),
                allowed_roots=[allowed_root.resolve()],
                require_audio_probe=True,
            )
    assert exc.value.code == "FINAL_AUDIO_NO_AUDIO_STREAM"


def test_validate_runs_when_enhancement_disabled(allowed_root: Path):
    audio = allowed_root / "ok.webm"
    audio.write_bytes(b"x" * 256)
    settings = MagicMock()
    settings.audio_enhancement_enabled = False
    settings.allowed_upload_extensions = ".webm,.m4a,.mp4,.wav,.mp3"
    settings.max_upload_size_bytes = 1000000
    settings.audio_enhancement_timeout_seconds = 5
    with patch(
        "app.services.final_audio_path_validation._probe_has_audio_stream",
        return_value=True,
    ) as probe:
        validate_final_audio_fallback_path(
            str(audio),
            allowed_roots=[allowed_root.resolve()],
            settings=settings,
            require_audio_probe=True,
        )
    probe.assert_called_once()


def test_run_final_audio_fallback_rejects_tiny_audio(allowed_root: Path):
    tiny_path = allowed_root / "tiny.webm"
    tiny_path.write_bytes(b"x" * 32)

    with patch(
        "app.services.final_audio_fallback.validate_final_audio_fallback_path",
        side_effect=FinalAudioPathError(
            "FINAL_AUDIO_FALLBACK_UNAVAILABLE",
            "Audio file is too small for fallback transcription",
        ),
    ):
        with pytest.raises(FinalAudioPathError) as exc:
            run_final_audio_fallback(
                meeting_id=42,
                audio_path=str(tiny_path),
                language="vi",
                trace_id="trace-42",
                request_id="req-42",
            )

    assert exc.value.code == "FINAL_AUDIO_FALLBACK_UNAVAILABLE"
    assert str(tiny_path) not in exc.value.safe_message


@patch("app.services.final_audio_fallback.prepare_audio_for_stt")
@patch("app.services.final_audio_fallback.SessionLocal")
@patch("app.services.final_audio_fallback._build_adapter")
def test_run_final_audio_fallback_persists_segments(
    build_adapter_mock: MagicMock,
    session_local_mock: MagicMock,
    prepare_mock: MagicMock,
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
    prepare_mock.return_value = (Path(temp_audio_path), None)

    with patch(
        "app.services.final_audio_fallback.validate_final_audio_fallback_path",
        return_value=Path(temp_audio_path),
    ), patch(
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
    prepare_mock.assert_called_once()


@patch("app.services.final_audio_fallback.prepare_audio_for_stt")
@patch("app.services.final_audio_fallback.SessionLocal")
@patch("app.services.final_audio_fallback._build_adapter")
def test_run_final_audio_fallback_idempotent_skips_enhancer_and_stt(
    build_adapter_mock: MagicMock,
    session_local_mock: MagicMock,
    prepare_mock: MagicMock,
    temp_audio_path: str,
):
    session = MagicMock()
    session_local_mock.return_value = session
    repository = MagicMock()
    repository.list_fragments.return_value = [
        MagicMock(event_id="final-audio-fallback-99-1"),
    ]

    with patch(
        "app.services.final_audio_fallback.validate_final_audio_fallback_path",
        return_value=Path(temp_audio_path),
    ), patch(
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
    prepare_mock.assert_not_called()
    build_adapter_mock.assert_not_called()
