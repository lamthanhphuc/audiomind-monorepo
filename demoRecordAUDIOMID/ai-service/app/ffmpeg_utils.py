import os
import shutil
from functools import lru_cache
from pathlib import Path

from loguru import logger


def _candidate_paths() -> list[Path]:
    candidates: list[Path] = []

    # Already on PATH.
    which_path = shutil.which("ffmpeg")
    if which_path:
        candidates.append(Path(which_path))

    if os.name == "nt":
        local_app_data = Path(os.environ.get("LOCALAPPDATA", ""))
        program_data = Path(os.environ.get("ProgramData", r"C:\ProgramData"))

        candidates.extend(
            [
                Path(r"C:\ffmpeg\bin\ffmpeg.exe"),
                program_data / "chocolatey" / "bin" / "ffmpeg.exe",
                Path.home() / "scoop" / "shims" / "ffmpeg.exe",
                Path.home() / "scoop" / "apps" / "ffmpeg" / "current" / "bin" / "ffmpeg.exe",
            ]
        )

        winget_packages = local_app_data / "Microsoft" / "WinGet" / "Packages"
        if winget_packages.exists():
            for ffmpeg_dir in winget_packages.glob("Gyan.FFmpeg*"):
                candidates.extend(ffmpeg_dir.glob("**/bin/ffmpeg.exe"))
    else:
        candidates.extend(
            [
                Path("/usr/bin/ffmpeg"),
                Path("/usr/local/bin/ffmpeg"),
                Path("/opt/homebrew/bin/ffmpeg"),
            ]
        )

    return candidates


@lru_cache(maxsize=1)
def resolve_ffmpeg_path() -> str:
    for candidate in _candidate_paths():
        if candidate.exists() and candidate.is_file():
            return str(candidate.resolve())

    raise FileNotFoundError(
        "ffmpeg binary not found. Install ffmpeg and/or add it to PATH."
    )


def ensure_ffmpeg_on_path(log: bool = False) -> str:
    ffmpeg_path = resolve_ffmpeg_path()
    ffmpeg_dir = str(Path(ffmpeg_path).parent)

    path_parts = os.environ.get("PATH", "").split(os.pathsep)
    if ffmpeg_dir not in path_parts:
        os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")

    # Some tools inspect this variable if provided.
    os.environ.setdefault("FFMPEG_BINARY", ffmpeg_path)

    if log:
        logger.info(f"Using ffmpeg binary: {ffmpeg_path}")

    return ffmpeg_path
