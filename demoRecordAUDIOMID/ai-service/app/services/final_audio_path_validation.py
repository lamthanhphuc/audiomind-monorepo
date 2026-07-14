"""Validate final-audio fallback paths against server-managed roots."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
from pathlib import Path

from app.config import get_settings
from app.ffmpeg_utils import ensure_ffmpeg_on_path, resolve_ffmpeg_path
from app.services.server_audio_roots import get_server_managed_audio_roots

logger = logging.getLogger(__name__)

MIN_FALLBACK_AUDIO_BYTES = 128

ALLOWED_AUDIO_SUFFIXES = frozenset(
    {
        ".webm",
        ".m4a",
        ".mp4",
        ".wav",
        ".mp3",
        ".aac",
        ".flac",
        ".ogg",
    }
)


class FinalAudioPathError(ValueError):
    """Safe path validation error — never include full filesystem paths in message."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message


def get_final_audio_allowed_roots(settings=None) -> list[Path]:
    return list(get_server_managed_audio_roots(settings))


def _is_under_root(resolved: Path, root: Path) -> bool:
    try:
        resolved.relative_to(root)
        return True
    except ValueError:
        return False


def _resolve_allowed_suffixes(cfg) -> set[str]:
    configured = {
        part.strip().lower()
        for part in str(getattr(cfg, "allowed_upload_extensions", "")).split(",")
        if part.strip()
    }
    # Config present → exact allowlist. Empty config → hardcoded defaults.
    return configured if configured else set(ALLOWED_AUDIO_SUFFIXES)


def _probe_has_audio_stream(path: Path, timeout_seconds: int = 30) -> bool:
    """Fail closed when ffprobe is unavailable or probe fails."""
    try:
        ffmpeg_path = ensure_ffmpeg_on_path()
    except FileNotFoundError:
        try:
            ffmpeg_path = resolve_ffmpeg_path()
        except Exception as exc:
            raise FinalAudioPathError(
                "FINAL_AUDIO_PROBE_UNAVAILABLE",
                "Audio probe is unavailable on this server",
            ) from exc

    ffprobe_path = Path(ffmpeg_path).with_name(
        "ffprobe.exe" if os.name == "nt" else "ffprobe"
    )
    if not ffprobe_path.is_file():
        located = shutil.which("ffprobe")
        if not located:
            raise FinalAudioPathError(
                "FINAL_AUDIO_PROBE_UNAVAILABLE",
                "Audio probe is unavailable on this server",
            )
        ffprobe_path = Path(located)

    try:
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
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=max(1, int(timeout_seconds)),
            shell=False,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise FinalAudioPathError(
            "FINAL_AUDIO_PROBE_TIMEOUT",
            "Audio probe timed out",
        ) from exc
    except OSError as exc:
        raise FinalAudioPathError(
            "FINAL_AUDIO_PROBE_FAILED",
            "Audio probe failed for the provided file",
        ) from exc

    if probe.returncode != 0 or "audio" not in (probe.stdout or "").lower():
        raise FinalAudioPathError(
            "FINAL_AUDIO_NO_AUDIO_STREAM",
            "Provided file does not contain a valid audio stream",
        )
    return True


def validate_final_audio_fallback_path(
    raw_path: str,
    *,
    allowed_roots: list[Path] | None = None,
    max_bytes: int | None = None,
    min_bytes: int = MIN_FALLBACK_AUDIO_BYTES,
    require_audio_probe: bool = True,
    settings=None,
) -> Path:
    """
    Resolve and validate a final-audio fallback path.

    Independent of AUDIO_ENHANCEMENT_ENABLED. Never logs or raises with full paths.
    """
    cfg = settings or get_settings()
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise FinalAudioPathError("FINAL_AUDIO_PATH_INVALID", "Audio path is required")

    roots = allowed_roots if allowed_roots is not None else get_final_audio_allowed_roots(cfg)
    if not roots:
        raise FinalAudioPathError(
            "FINAL_AUDIO_ALLOWED_ROOT_MISSING",
            "No allowed audio roots are configured",
        )

    candidate = Path(raw_path.strip()).expanduser()
    if candidate.is_symlink():
        logger.warning("FINAL_AUDIO_PATH_REJECTED reason=symlink name=%s", candidate.name)
        raise FinalAudioPathError(
            "FINAL_AUDIO_SYMLINK_REJECTED",
            "Symlinked audio paths are not allowed",
        )

    try:
        resolved = candidate.resolve(strict=True)
    except FileNotFoundError as exc:
        raise FinalAudioPathError(
            "FINAL_AUDIO_PATH_NOT_FOUND",
            "Audio file was not found",
        ) from exc
    except OSError as exc:
        raise FinalAudioPathError(
            "FINAL_AUDIO_PATH_INVALID",
            "Audio path could not be resolved",
        ) from exc

    if not resolved.is_file():
        raise FinalAudioPathError(
            "FINAL_AUDIO_PATH_INVALID",
            "Audio path must be a regular file",
        )

    if not any(_is_under_root(resolved, root) for root in roots):
        logger.warning(
            "FINAL_AUDIO_PATH_REJECTED reason=outside_allowed_root name=%s",
            resolved.name,
        )
        raise FinalAudioPathError(
            "FINAL_AUDIO_PATH_FORBIDDEN",
            "Audio path is outside the allowed storage roots",
        )

    suffix = resolved.suffix.lower()
    allowed_suffixes = _resolve_allowed_suffixes(cfg)
    if suffix not in allowed_suffixes:
        raise FinalAudioPathError(
            "FINAL_AUDIO_EXTENSION_REJECTED",
            "Audio file extension is not supported",
        )

    try:
        size = resolved.stat().st_size
    except OSError as exc:
        raise FinalAudioPathError(
            "FINAL_AUDIO_PATH_INVALID",
            "Audio file could not be read",
        ) from exc

    if size < max(1, int(min_bytes)):
        raise FinalAudioPathError(
            "FINAL_AUDIO_FALLBACK_UNAVAILABLE",
            "Audio file is too small for fallback transcription",
        )

    limit = int(max_bytes if max_bytes is not None else cfg.max_upload_size_bytes)
    if size > limit:
        raise FinalAudioPathError(
            "FINAL_AUDIO_TOO_LARGE",
            "Audio file exceeds the maximum allowed size",
        )

    if require_audio_probe:
        _probe_has_audio_stream(
            resolved,
            timeout_seconds=int(getattr(cfg, "audio_enhancement_timeout_seconds", 30) or 30),
        )

    return resolved
