"""Unit tests for scripts/load-compose-env.py and generate-vps-db-url.py."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOAD = ROOT / "scripts" / "load-compose-env.py"
GEN = ROOT / "scripts" / "generate-vps-db-url.py"


def test_load_compose_env_preserves_special_characters(tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "\n".join(
            [
                "PLAIN=hello",
                'PASS=p@ss:word/#$x',
                'QUOTED="value with spaces"',
                "# comment",
                "export LEGACY=1",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    got = subprocess.run(
        [sys.executable, str(LOAD), "--file", str(env_file), "--get", "PASS"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert got.stdout == "p@ss:word/#$x"
    quoted = subprocess.run(
        [sys.executable, str(LOAD), "--file", str(env_file), "--get", "QUOTED"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert quoted.stdout == "value with spaces"


def test_generate_vps_db_url_encodes_password():
    result = subprocess.run(
        [
            sys.executable,
            str(GEN),
            "--user",
            "audiomind",
            "--password",
            "p@ss:word/#",
            "--host",
            "postgres",
            "--database",
            "audiomind",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    url = result.stdout.strip()
    assert url.startswith("postgresql://audiomind:")
    assert "@postgres:5432/audiomind" in url
    assert "p@ss" not in url
    assert "%40" in url  # @
    assert "%3A" in url  # :
