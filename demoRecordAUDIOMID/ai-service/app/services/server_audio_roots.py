"""Shared server-managed audio storage roots for upload + final-audio validation."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

# Exact directories the API/worker can write uploaded/final audio into.
# Intentionally does NOT include broad parents like /app/storage.
DEFAULT_SERVER_MANAGED_AUDIO_ROOTS: tuple[str, ...] = (
    "/app/uploads",
    "/app/storage/uploads",
    "./storage/uploads",
)


def _dedupe_roots(roots: Iterable[Path]) -> tuple[Path, ...]:
    unique: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        key = str(root)
        if key in seen:
            continue
        seen.add(key)
        unique.append(root)
    return tuple(unique)


def parse_configured_roots(raw: str | None) -> tuple[Path, ...]:
    if not raw or not str(raw).strip():
        return ()
    roots: list[Path] = []
    for part in str(raw).split(","):
        candidate = part.strip()
        if not candidate:
            continue
        roots.append(Path(candidate).expanduser().resolve(strict=False))
    return _dedupe_roots(roots)


def get_default_server_managed_audio_roots(
    *,
    audio_storage_path: str | None = None,
    temp_storage_path: str | None = None,
) -> tuple[Path, ...]:
    roots: list[Path] = [
        Path(candidate).expanduser().resolve(strict=False)
        for candidate in DEFAULT_SERVER_MANAGED_AUDIO_ROOTS
    ]
    if audio_storage_path and str(audio_storage_path).strip():
        roots.append(Path(audio_storage_path).expanduser().resolve(strict=False))
    if temp_storage_path and str(temp_storage_path).strip():
        roots.append(Path(temp_storage_path).expanduser().resolve(strict=False))
    return _dedupe_roots(roots)


def get_server_managed_audio_roots(settings=None) -> tuple[Path, ...]:
    """
    Source of truth for uploaded/final audio containment.

    If FINAL_AUDIO_ALLOWED_ROOTS is set, it is the exact allowlist (no silent merge).
    Otherwise defaults cover Docker + local upload chooser paths plus configured
    audio/temp storage directories.
    """
    from app.config import get_settings

    cfg = settings or get_settings()
    configured = parse_configured_roots(getattr(cfg, "final_audio_allowed_roots", None))
    if configured:
        return configured
    return get_default_server_managed_audio_roots(
        audio_storage_path=getattr(cfg, "audio_storage_path", None),
        temp_storage_path=getattr(cfg, "temp_storage_path", None),
    )


def get_upload_dir_candidates(settings=None) -> tuple[Path, ...]:
    """Writable upload directory candidates (same family as managed roots)."""
    from app.config import get_settings

    cfg = settings or get_settings()
    configured = parse_configured_roots(getattr(cfg, "final_audio_allowed_roots", None))
    if configured:
        return configured
    return tuple(
        Path(candidate).expanduser()
        for candidate in DEFAULT_SERVER_MANAGED_AUDIO_ROOTS
    )
