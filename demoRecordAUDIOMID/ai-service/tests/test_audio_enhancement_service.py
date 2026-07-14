from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.services.audio_enhancement_provider import AudioEnhancementProfile
from app.services.audio_enhancement_service import (
    FFmpegAudioEnhancementProvider,
    prepare_audio_for_stt,
)


@pytest.fixture
def source_audio(tmp_path: Path) -> Path:
    path = tmp_path / "source.webm"
    path.write_bytes(b"original audio")
    return path


def _successful_run(partial: Path):
    def run(args, **kwargs):
        assert isinstance(args, list)
        assert kwargs["shell"] is False
        partial.write_bytes(b"enhanced audio")
        return subprocess.CompletedProcess(args, 0, "", "")

    return run


def test_prepare_disabled_does_not_call_ffmpeg(source_audio: Path, tmp_path: Path):
    with patch(
        "app.services.audio_enhancement_service.FFmpegAudioEnhancementProvider"
    ) as provider:
        path, cleanup_path = prepare_audio_for_stt(
            source_audio,
            enabled=False,
            provider_name="ffmpeg",
            keep_enhanced=False,
            timeout_seconds=1,
            temp_dir=tmp_path,
        )

    assert path == source_audio
    assert cleanup_path is None
    provider.assert_not_called()


@patch("app.services.audio_enhancement_service.ensure_ffmpeg_on_path")
def test_enhance_success_writes_partial_then_renames(
    ensure_ffmpeg: MagicMock, source_audio: Path, tmp_path: Path
):
    ensure_ffmpeg.return_value = "ffmpeg"
    output = tmp_path / "enhanced.wav"
    partial = output.with_suffix(".wav.partial")
    provider = FFmpegAudioEnhancementProvider(timeout_seconds=1)

    with patch.object(provider, "_probe_audio_stream"), patch(
        "app.services.audio_enhancement_service.subprocess.run",
        side_effect=_successful_run(partial),
    ) as run:
        result = provider.enhance(source_audio, output, AudioEnhancementProfile.STT)

    assert result == output
    assert output.read_bytes() == b"enhanced audio"
    assert not partial.exists()
    args, kwargs = run.call_args
    assert isinstance(args[0], list)
    assert kwargs["shell"] is False
    assert "-y" in args[0]
    assert "-nostdin" in args[0]
    assert "-map" in args[0]
    assert "0:a:0" in args[0]
    assert "-c:a" in args[0]
    assert "pcm_s16le" in args[0]


@patch("app.services.audio_enhancement_service.ensure_ffmpeg_on_path", return_value="ffmpeg")
def test_enhance_nonzero_exit_cleans_partial(
    _ensure_ffmpeg: MagicMock, source_audio: Path, tmp_path: Path
):
    output = tmp_path / "enhanced.wav"
    partial = output.with_suffix(".wav.partial")
    partial.write_bytes(b"partial")
    provider = FFmpegAudioEnhancementProvider(timeout_seconds=1)
    failed = subprocess.CompletedProcess([], 1, "", "Invalid data found when processing input")

    with patch.object(provider, "_probe_audio_stream"), patch(
        "app.services.audio_enhancement_service.subprocess.run", return_value=failed
    ):
        with pytest.raises(RuntimeError, match="FFmpeg enhancement failed"):
            provider.enhance(source_audio, output, AudioEnhancementProfile.STT)

    assert not partial.exists()
    assert not output.exists()


@patch("app.services.audio_enhancement_service.ensure_ffmpeg_on_path", return_value="ffmpeg")
def test_enhance_timeout_cleans_partial(
    _ensure_ffmpeg: MagicMock, source_audio: Path, tmp_path: Path
):
    output = tmp_path / "enhanced.wav"
    partial = output.with_suffix(".wav.partial")
    provider = FFmpegAudioEnhancementProvider(timeout_seconds=1)

    with patch.object(provider, "_probe_audio_stream"), patch(
        "app.services.audio_enhancement_service.subprocess.run",
        side_effect=subprocess.TimeoutExpired("ffmpeg", 1),
    ):
        with pytest.raises(subprocess.TimeoutExpired):
            provider.enhance(source_audio, output, AudioEnhancementProfile.STT)

    assert not partial.exists()


def test_enhance_rejects_missing_input(tmp_path: Path):
    provider = FFmpegAudioEnhancementProvider()
    with pytest.raises(FileNotFoundError):
        provider.enhance(
            tmp_path / "missing.wav",
            tmp_path / "output.wav",
            AudioEnhancementProfile.STT,
        )


def test_enhance_rejects_same_resolved_path(source_audio: Path):
    provider = FFmpegAudioEnhancementProvider()
    with pytest.raises(ValueError, match="must not overwrite"):
        provider.enhance(source_audio, source_audio, AudioEnhancementProfile.STT)


@patch("app.services.audio_enhancement_service.ensure_ffmpeg_on_path", return_value="ffmpeg")
def test_enhance_never_overwrites_original(
    _ensure_ffmpeg: MagicMock, source_audio: Path, tmp_path: Path
):
    output = tmp_path / "enhanced.wav"
    partial = output.with_suffix(".wav.partial")
    provider = FFmpegAudioEnhancementProvider()
    original = source_audio.read_bytes()

    with patch.object(provider, "_probe_audio_stream"), patch(
        "app.services.audio_enhancement_service.subprocess.run",
        side_effect=_successful_run(partial),
    ):
        provider.enhance(source_audio, output, AudioEnhancementProfile.STT)

    assert source_audio.read_bytes() == original
    assert output.exists()


@patch("app.services.audio_enhancement_service.ensure_ffmpeg_on_path", return_value="ffmpeg")
def test_enhance_falls_back_through_filters(
    _ensure_ffmpeg: MagicMock, source_audio: Path, tmp_path: Path
):
    output = tmp_path / "enhanced.wav"
    partial = output.with_suffix(".wav.partial")
    provider = FFmpegAudioEnhancementProvider()
    filter_failure = subprocess.CompletedProcess([], 1, "", "No such filter: afftdn")
    responses = iter([filter_failure, filter_failure])

    def run(args, **kwargs):
        try:
            return next(responses)
        except StopIteration:
            return _successful_run(partial)(args, **kwargs)

    with patch.object(provider, "_probe_audio_stream"), patch(
        "app.services.audio_enhancement_service.subprocess.run",
        side_effect=run,
    ) as run:
        provider.enhance(source_audio, output, AudioEnhancementProfile.STT)

    assert run.call_count == 3
    assert run.call_args_list[0].args[0][run.call_args_list[0].args[0].index("-af") + 1].startswith(
        "highpass=f=80,afftdn"
    )
    assert run.call_args_list[1].args[0][run.call_args_list[1].args[0].index("-af") + 1] == "highpass=f=80"
    assert "-af" not in run.call_args_list[2].args[0]


def test_enabled_unsupported_provider_is_rejected():
    with pytest.raises(ValidationError, match="elevenlabs and deepfilter"):
        Settings(
            _env_file=None,
            audio_enhancement_enabled=True,
            audio_enhancement_provider="elevenlabs",
        )
