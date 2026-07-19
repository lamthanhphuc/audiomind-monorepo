"""generate-vps-db-url.py --env-file + encoding behavior."""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "generate-vps-db-url.py"


def _run(*args: str, env_body: str | None = None) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as tmp:
        env_path = None
        cmd = [sys.executable, str(SCRIPT), *args]
        if env_body is not None:
            env_path = Path(tmp) / ".env"
            env_path.write_text(env_body, encoding="utf-8")
            cmd.extend(["--env-file", str(env_path)])
        return subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True, check=False)


def test_env_file_reads_and_encodes_special_password():
    body = "\n".join(
        [
            "POSTGRES_USER=audiomind",
            "POSTGRES_PASSWORD=p@ss:word#1",
            "POSTGRES_DB=audiomind",
        ]
    )
    result = _run(env_body=body)
    assert result.returncode == 0, result.stderr
    url = result.stdout.strip()
    assert "p@ss:word#1" not in url
    assert "%40" in url  # @
    assert "%3A" in url or ":" not in url.split("@")[0].split("://", 1)[-1]  # encoded :
    assert "@db:5432/audiomind" in url or "@db:" in url
    assert "p@ss" not in result.stderr


def test_missing_password_fails_clearly():
    body = "POSTGRES_USER=audiomind\nPOSTGRES_DB=audiomind\n"
    result = _run(env_body=body)
    assert result.returncode != 0
    assert "POSTGRES_PASSWORD_MISSING" in (result.stderr + result.stdout)


def test_cli_password_still_works():
    result = _run(
        "--user",
        "u",
        "--password",
        "a/b",
        "--host",
        "db",
        "--database",
        "audiomind",
    )
    assert result.returncode == 0
    assert "%2F" in result.stdout
