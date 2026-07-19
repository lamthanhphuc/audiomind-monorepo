"""Shared /app/uploads path visibility between meeting-compatible and AI mounts."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]


def _docker_available() -> bool:
    if not shutil.which("docker"):
        return False
    result = subprocess.run(
        ["docker", "info"],
        capture_output=True,
        text=True,
        check=False,
        timeout=20,
    )
    return result.returncode == 0


@pytest.mark.skipif(not _docker_available(), reason="Docker daemon required")
def test_shared_uploads_volume_visible_at_canonical_path():
    volume = f"audiomind-test-uploads-{uuid.uuid4().hex[:8]}"
    marker = f"probe-{uuid.uuid4().hex}.wav"
    try:
        subprocess.run(
            ["docker", "volume", "create", volume],
            check=True,
            capture_output=True,
            text=True,
        )
        # Meeting-compatible writer
        write = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "-v",
                f"{volume}:/app/uploads",
                "alpine:3.20",
                "sh",
                "-c",
                f"echo meeting-audio > /app/uploads/{marker}",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert write.returncode == 0, write.stderr

        # AI-compatible reader at the SAME path (must NOT rely on /app/storage/audio)
        read = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "-v",
                f"{volume}:/app/uploads",
                "alpine:3.20",
                "sh",
                "-c",
                f"test -f /app/uploads/{marker} && cat /app/uploads/{marker} && "
                f"test ! -f /app/storage/audio/{marker}",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert read.returncode == 0, read.stderr or read.stdout
        assert "meeting-audio" in read.stdout
    finally:
        subprocess.run(
            ["docker", "volume", "rm", "-f", volume],
            capture_output=True,
            text=True,
            check=False,
        )


def test_compose_source_mounts_uploads_at_app_uploads():
    compose = (REPO_ROOT / "infra" / "docker-compose.vps.yml").read_text(encoding="utf-8")
    assert "uploads:/app/uploads" in compose
    assert "uploads:/app/storage/audio" not in compose
    assert "AUDIO_STORAGE_PATH: /app/uploads" in compose
    assert "FINAL_AUDIO_ALLOWED_ROOTS: /app/uploads" in compose
