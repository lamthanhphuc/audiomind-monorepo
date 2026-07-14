"""Safe, best-effort FFmpeg audio enhancement for STT and playback."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import uuid
from pathlib import Path

from app.config import get_settings
from app.ffmpeg_utils import ensure_ffmpeg_on_path, resolve_ffmpeg_path
from app.services.audio_enhancement_provider import (
    AudioEnhancementProfile,
    AudioEnhancementProviderName,
)

logger = logging.getLogger(__name__)

_FILTERS = {
    AudioEnhancementProfile.STT: (
        "highpass=f=80,afftdn=nr=10:nf=-45:tn=1",
        "highpass=f=80",
        None,
    ),
    AudioEnhancementProfile.PLAYBACK: (
        "highpass=f=80,afftdn=nr=10:nf=-45:tn=1,loudnorm",
        "highpass=f=80",
        None,
    ),
}
_FILTER_ERROR_MARKERS = (
    "filter",
    "afftdn",
    "loudnorm",
    "invalid argument",
    "not supported",
    "option not found",
)


class FFmpegAudioEnhancementProvider:
    """Enhance audio into a portable 16 kHz mono PCM WAV file."""

    def __init__(self, timeout_seconds: int = 120) -> None:
        self.timeout_seconds = max(1, int(timeout_seconds))

    def enhance(
        self,
        input_path: Path,
        output_path: Path,
        profile: AudioEnhancementProfile,
    ) -> Path:
        input_path = Path(input_path)
        output_path = Path(output_path)
        self._validate_paths(input_path, output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        partial_path = output_path.with_suffix(f"{output_path.suffix}.partial")
        self._remove_partial(partial_path)

        try:
            ffmpeg_path = ensure_ffmpeg_on_path()
        except FileNotFoundError:
            ffmpeg_path = resolve_ffmpeg_path()

        try:
            self._probe_audio_stream(ffmpeg_path, input_path)
            filters = _FILTERS[profile]
            for index, audio_filter in enumerate(filters):
                result = self._run_ffmpeg(
                    ffmpeg_path, input_path, partial_path, audio_filter
                )
                if result.returncode == 0:
                    if not partial_path.is_file() or partial_path.stat().st_size <= 0:
                        raise RuntimeError("FFmpeg produced no enhanced audio output")
                    os.replace(partial_path, output_path)
                    logger.info(
                        "AUDIO_ENHANCEMENT_COMPLETED input=%s output=%s filter=%s",
                        input_path.name,
                        output_path.name,
                        audio_filter or "none",
                    )
                    return output_path

                error = self._command_error(result)
                if index < len(filters) - 1 and self._is_filter_error(error):
                    logger.warning(
                        "AUDIO_ENHANCEMENT_FILTER_FALLBACK input=%s filter=%s",
                        input_path.name,
                        audio_filter,
                    )
                    self._remove_partial(partial_path)
                    continue
                raise RuntimeError(f"FFmpeg enhancement failed: {error}")
        except Exception:
            self._remove_partial(partial_path)
            raise

    def _validate_paths(self, input_path: Path, output_path: Path) -> None:
        if not input_path.exists() or not input_path.is_file():
            raise FileNotFoundError(f"Audio input is not a file: {input_path.name}")
        allowed_extensions = {
            suffix.strip().lower()
            for suffix in get_settings().allowed_upload_extensions.split(",")
            if suffix.strip()
        }
        if input_path.suffix.lower() not in allowed_extensions:
            raise ValueError(f"Unsupported audio extension: {input_path.suffix}")

        input_resolved = input_path.resolve(strict=False)
        output_resolved = output_path.resolve(strict=False)
        if input_resolved == output_resolved:
            raise ValueError("Enhanced audio output must not overwrite the original")

    def _probe_audio_stream(self, ffmpeg_path: str, input_path: Path) -> None:
        ffprobe_path = Path(ffmpeg_path).with_name(
            "ffprobe.exe" if os.name == "nt" else "ffprobe"
        )
        if not ffprobe_path.is_file():
            located = shutil.which("ffprobe")
            if not located:
                return
            ffprobe_path = Path(located)

        probe = subprocess.run(
            [
                str(ffprobe_path),
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(input_path),
            ],
            capture_output=True,
            text=True,
            timeout=self.timeout_seconds,
            shell=False,
            check=False,
        )
        if probe.returncode != 0 or "audio" not in (probe.stdout or "").lower():
            raise RuntimeError(f"Audio probe failed: {self._command_error(probe)}")

    def _run_ffmpeg(
        self,
        ffmpeg_path: str,
        input_path: Path,
        partial_path: Path,
        audio_filter: str | None,
    ) -> subprocess.CompletedProcess[str]:
        args = [
            ffmpeg_path,
            "-y",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-vn",
            "-i",
            str(input_path),
            "-map",
            "0:a:0",
        ]
        if audio_filter:
            args.extend(["-af", audio_filter])
        args.extend(
            [
                "-c:a",
                "pcm_s16le",
                "-ar",
                "16000",
                "-ac",
                "1",
                "-f",
                "wav",
                str(partial_path),
            ]
        )
        return subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=self.timeout_seconds,
            shell=False,
            check=False,
        )

    @staticmethod
    def _command_error(result: subprocess.CompletedProcess[str]) -> str:
        return ((result.stderr or result.stdout or "unknown FFmpeg error").strip())[:500]

    @staticmethod
    def _is_filter_error(error: str) -> bool:
        lowered = error.lower()
        return any(marker in lowered for marker in _FILTER_ERROR_MARKERS)

    @staticmethod
    def _remove_partial(partial_path: Path) -> None:
        try:
            partial_path.unlink(missing_ok=True)
        except OSError:
            logger.warning("AUDIO_ENHANCEMENT_PARTIAL_CLEANUP_FAILED file=%s", partial_path.name)


def prepare_audio_for_stt(
    original_path: str | Path,
    *,
    enabled: bool,
    provider_name: str,
    keep_enhanced: bool,
    timeout_seconds: int,
    temp_dir: Path,
) -> tuple[Path, Path | None]:
    """Returns (path_for_consumers, enhanced_path_or_None_to_cleanup). Never overwrites original. On any failure return (original, None)."""
    original = Path(original_path)
    provider = (provider_name or "").strip().lower()
    if not enabled or provider in {"", AudioEnhancementProviderName.NONE.value}:
        logger.info("AUDIO_ENHANCEMENT_SKIPPED input=%s reason=disabled", original.name)
        return original, None
    if provider != AudioEnhancementProviderName.FFMPEG.value:
        logger.warning(
            "AUDIO_ENHANCEMENT_FAILED_FALLBACK input=%s provider=%s error=unsupported_provider",
            original.name,
            provider,
        )
        return original, None

    try:
        temp_dir.mkdir(parents=True, exist_ok=True)
        output = temp_dir / f"{original.stem}.enhanced-{uuid.uuid4().hex}.wav"
        logger.info("AUDIO_ENHANCEMENT_STARTED input=%s provider=ffmpeg", original.name)
        enhanced = FFmpegAudioEnhancementProvider(timeout_seconds).enhance(
            original, output, AudioEnhancementProfile.STT
        )
        return enhanced, enhanced
    except Exception as exc:
        logger.warning(
            "AUDIO_ENHANCEMENT_FAILED_FALLBACK input=%s provider=%s error=%s",
            original.name,
            provider,
            type(exc).__name__,
        )
        return original, None
