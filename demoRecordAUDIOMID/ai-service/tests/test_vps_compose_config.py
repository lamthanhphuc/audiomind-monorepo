"""Validate infra/docker-compose.vps.yml rendered environment (no secrets logged)."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
COMPOSE_FILE = REPO_ROOT / "infra" / "docker-compose.vps.yml"
EXAMPLE_ENV = REPO_ROOT / ".env.production.example"


def _docker_compose_available() -> bool:
    return shutil.which("docker") is not None


@pytest.fixture(scope="module")
def rendered_compose() -> dict:
    if not _docker_compose_available():
        pytest.skip("docker required for compose render test")
    if not COMPOSE_FILE.is_file() or not EXAMPLE_ENV.is_file():
        pytest.fail("missing VPS compose or .env.production.example")

    with tempfile.TemporaryDirectory() as tmp:
        env_path = Path(tmp) / ".env.production.test"
        text = EXAMPLE_ENV.read_text(encoding="utf-8")
        text = text.replace(
            "AI_DATABASE_URL=postgresql://audiomind:CHANGE_ME_STRONG@postgres:5432/audiomind",
            "AI_DATABASE_URL=postgresql://audiomind:change_me_strong@postgres:5432/audiomind",
        )
        env_path.write_text(text, encoding="utf-8")
        result = subprocess.run(
            [
                "docker",
                "compose",
                "--env-file",
                str(env_path),
                "-f",
                str(COMPOSE_FILE),
                "--profile",
                "migrate",
                "config",
                "--format",
                "json",
            ],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            # Older compose without --format json: fall back to YAML text + minimal checks
            result = subprocess.run(
                [
                    "docker",
                    "compose",
                    "--env-file",
                    str(env_path),
                    "-f",
                    str(COMPOSE_FILE),
                    "--profile",
                    "migrate",
                    "config",
                ],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode != 0:
                pytest.fail(result.stderr or result.stdout or "compose config failed")
            return {"_raw": result.stdout, "services": {}}
        return json.loads(result.stdout)


def test_user_api_redis_points_at_compose_service(rendered_compose: dict):
    if rendered_compose.get("_raw"):
        raw = rendered_compose["_raw"]
        assert "REDIS_HOST: redis" in raw or "REDIS_HOST: redis" in raw
        assert "user-api" in raw
        assert "REDIS_HOST: localhost" not in raw
        return
    env = rendered_compose["services"]["user-api"]["environment"]
    # compose JSON may return list of KEY=VAL or dict depending on version
    if isinstance(env, list):
        mapped = {}
        for item in env:
            if isinstance(item, str) and "=" in item:
                k, v = item.split("=", 1)
                mapped[k] = v
        env = mapped
    assert env.get("REDIS_HOST") == "redis"
    assert str(env.get("REDIS_PORT")) == "6379"


def test_ai_services_use_shared_uploads_and_vps_tls(rendered_compose: dict):
    if rendered_compose.get("_raw"):
        raw = rendered_compose["_raw"]
        assert "DEPLOYMENT_MODE: vps" in raw
        assert "DATABASE_TLS_MODE: disable" in raw
        assert "AUDIO_STORAGE_PATH: /app/uploads" in raw
        assert "uploads:/app/uploads" in raw or "/app/uploads" in raw
        assert "uploads:/app/storage/audio" not in raw
        return
    for name in ("ai-api", "celery-worker"):
        svc = rendered_compose["services"][name]
        env = svc["environment"]
        if isinstance(env, list):
            mapped = {}
            for item in env:
                if isinstance(item, str) and "=" in item:
                    k, v = item.split("=", 1)
                    mapped[k] = v
            env = mapped
        assert env.get("DEPLOYMENT_MODE") == "vps"
        assert env.get("DATABASE_TLS_MODE") == "disable"
        assert env.get("AUDIO_STORAGE_PATH") == "/app/uploads"
        assert env.get("FINAL_AUDIO_ALLOWED_ROOTS") == "/app/uploads"


def test_celery_beat_has_no_database_or_provider_secrets(rendered_compose: dict):
    if rendered_compose.get("_raw"):
        # Beat block should not set DATABASE_URL in source; check source compose
        source = COMPOSE_FILE.read_text(encoding="utf-8")
        beat_idx = source.index("celery-beat:")
        next_svc = source.find("\n  frontend:", beat_idx)
        beat_block = source[beat_idx:next_svc if next_svc > 0 else None]
        assert "DATABASE_URL" not in beat_block
        assert "GEMINI_API_KEY" not in beat_block
        assert "DEEPGRAM_API_KEY" not in beat_block
        return
    env = rendered_compose["services"]["celery-beat"]["environment"]
    if isinstance(env, list):
        keys = {item.split("=", 1)[0] for item in env if isinstance(item, str) and "=" in item}
    else:
        keys = set(env)
    assert "DATABASE_URL" not in keys
    assert "GEMINI_API_KEY" not in keys
    assert "DEEPGRAM_API_KEY" not in keys


def test_postgres_redis_not_published_publicly():
    raw = COMPOSE_FILE.read_text(encoding="utf-8")
    assert "5432:5432" not in raw
    assert "6379:6379" not in raw
    assert "REDIS_HOST: redis" in raw
