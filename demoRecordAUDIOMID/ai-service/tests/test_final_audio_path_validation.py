from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.services.final_audio_path_validation import (
    FinalAudioPathError,
    get_final_audio_allowed_roots,
    validate_final_audio_fallback_path,
)
from app.services.server_audio_roots import (
    get_default_server_managed_audio_roots,
    get_server_managed_audio_roots,
    get_upload_dir_candidates,
)


def test_configured_roots_override_defaults(tmp_path: Path):
    configured = tmp_path / "only-safe"
    configured.mkdir()
    settings = MagicMock()
    settings.final_audio_allowed_roots = str(configured)
    settings.audio_storage_path = str(tmp_path / "audio")
    settings.temp_storage_path = str(tmp_path / "temp")

    roots = get_server_managed_audio_roots(settings)
    assert roots == (configured.resolve(),)
    assert get_final_audio_allowed_roots(settings) == [configured.resolve()]


def test_empty_config_uses_defaults_including_local_uploads():
    settings = MagicMock()
    settings.final_audio_allowed_roots = ""
    settings.audio_storage_path = "./storage/audio"
    settings.temp_storage_path = "./storage/temp"
    roots = {str(path) for path in get_default_server_managed_audio_roots(
        audio_storage_path=settings.audio_storage_path,
        temp_storage_path=settings.temp_storage_path,
    )}
    assert any(path.endswith("uploads") or "storage" in path for path in roots)
    candidates = get_upload_dir_candidates(settings)
    assert any(str(path).replace("\\", "/").endswith("storage/uploads") for path in candidates)


def test_local_storage_uploads_accepted_sibling_rejected(tmp_path: Path, monkeypatch):
    uploads = tmp_path / "storage" / "uploads"
    secrets = tmp_path / "storage" / "secrets"
    uploads.mkdir(parents=True)
    secrets.mkdir(parents=True)
    good = uploads / "meeting.webm"
    bad = secrets / "secret.webm"
    good.write_bytes(b"x" * 256)
    bad.write_bytes(b"x" * 256)

    monkeypatch.chdir(tmp_path)
    settings = MagicMock()
    settings.final_audio_allowed_roots = ""
    settings.audio_storage_path = str(tmp_path / "storage" / "audio")
    settings.temp_storage_path = str(tmp_path / "storage" / "temp")
    settings.allowed_upload_extensions = ".webm,.m4a,.mp4,.wav,.mp3"
    settings.max_upload_size_bytes = 10_000_000
    settings.audio_enhancement_timeout_seconds = 5

    with patch(
        "app.services.final_audio_path_validation._probe_has_audio_stream",
        return_value=True,
    ):
        accepted = validate_final_audio_fallback_path(
            str(good),
            allowed_roots=[uploads.resolve()],
            settings=settings,
        )
    assert accepted.name == "meeting.webm"

    with pytest.raises(FinalAudioPathError) as exc:
        validate_final_audio_fallback_path(
            str(bad),
            allowed_roots=[uploads.resolve()],
            settings=settings,
            require_audio_probe=False,
        )
    assert exc.value.code == "FINAL_AUDIO_PATH_FORBIDDEN"
    assert str(bad) not in exc.value.safe_message


def test_ffprobe_unavailable_fail_closed(tmp_path: Path):
    root = tmp_path / "uploads"
    root.mkdir()
    audio = root / "file.webm"
    audio.write_bytes(b"x" * 256)
    settings = MagicMock()
    settings.allowed_upload_extensions = ".webm"
    settings.max_upload_size_bytes = 10_000_000
    settings.audio_enhancement_timeout_seconds = 5

    with patch(
        "app.services.final_audio_path_validation.ensure_ffmpeg_on_path",
        side_effect=FileNotFoundError("missing"),
    ), patch(
        "app.services.final_audio_path_validation.resolve_ffmpeg_path",
        side_effect=FileNotFoundError("missing"),
    ):
        with pytest.raises(FinalAudioPathError) as exc:
            validate_final_audio_fallback_path(
                str(audio),
                allowed_roots=[root.resolve()],
                settings=settings,
                require_audio_probe=True,
            )
    assert exc.value.code == "FINAL_AUDIO_PROBE_UNAVAILABLE"


def test_ffprobe_timeout_fail_closed(tmp_path: Path):
    import subprocess

    root = tmp_path / "uploads"
    root.mkdir()
    audio = root / "file.webm"
    audio.write_bytes(b"x" * 256)
    settings = MagicMock()
    settings.allowed_upload_extensions = ".webm"
    settings.max_upload_size_bytes = 10_000_000
    settings.audio_enhancement_timeout_seconds = 1

    fake_ffmpeg = tmp_path / ("ffmpeg.exe" if False else "ffmpeg")
    fake_ffmpeg.write_text("x")
    fake_probe = tmp_path / "ffprobe"
    fake_probe.write_text("x")

    with patch(
        "app.services.final_audio_path_validation.ensure_ffmpeg_on_path",
        return_value=str(fake_ffmpeg),
    ), patch(
        "app.services.final_audio_path_validation.shutil.which",
        return_value=str(fake_probe),
    ), patch(
        "app.services.final_audio_path_validation.subprocess.run",
        side_effect=subprocess.TimeoutExpired(cmd="ffprobe", timeout=1),
    ):
        with pytest.raises(FinalAudioPathError) as exc:
            validate_final_audio_fallback_path(
                str(audio),
                allowed_roots=[root.resolve()],
                settings=settings,
                require_audio_probe=True,
            )
    assert exc.value.code == "FINAL_AUDIO_PROBE_TIMEOUT"


def test_configured_extension_allowlist_is_exact(tmp_path: Path):
    root = tmp_path / "uploads"
    root.mkdir()
    audio = root / "file.ogg"
    audio.write_bytes(b"x" * 256)
    settings = MagicMock()
    settings.allowed_upload_extensions = ".webm,.wav"
    settings.max_upload_size_bytes = 10_000_000
    settings.audio_enhancement_timeout_seconds = 5

    with pytest.raises(FinalAudioPathError) as exc:
        validate_final_audio_fallback_path(
            str(audio),
            allowed_roots=[root.resolve()],
            settings=settings,
            require_audio_probe=False,
        )
    assert exc.value.code == "FINAL_AUDIO_EXTENSION_REJECTED"
