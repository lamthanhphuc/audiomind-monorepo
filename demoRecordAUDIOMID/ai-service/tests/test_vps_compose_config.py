"""Validate the layered VPS Docker Compose config (dev+mvp+prod overlays, no secrets logged)."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
COMPOSE_FILES = [
    REPO_ROOT / "infra" / "docker-compose.dev.yml",
    REPO_ROOT / "infra" / "docker-compose.mvp.yml",
    REPO_ROOT / "infra" / "docker-compose.prod.yml",
]
ENV_FILE = REPO_ROOT / "infra" / ".env.vps.test"


def _docker_compose_available() -> bool:
    return shutil.which("docker") is not None


def _compose_args() -> list[str]:
    args = ["docker", "compose", "--env-file", str(ENV_FILE)]
    for compose_file in COMPOSE_FILES:
        args += ["-f", str(compose_file)]
    return args


@pytest.fixture(scope="module")
def rendered_compose() -> dict:
    if not _docker_compose_available():
        pytest.skip("docker required for compose render test")
    for compose_file in COMPOSE_FILES:
        if not compose_file.is_file():
            pytest.fail(f"missing compose file {compose_file}")
    if not ENV_FILE.is_file():
        pytest.fail(f"missing {ENV_FILE}")

    result = subprocess.run(
        [*_compose_args(), "config", "--format", "json"],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        # Older compose without --format json: fall back to YAML text + minimal checks
        result = subprocess.run(
            [*_compose_args(), "config"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            pytest.fail(result.stderr or result.stdout or "compose config failed")
        return {"_raw": result.stdout, "services": {}}
    return json.loads(result.stdout)


def _env_map(env) -> dict:
    if isinstance(env, list):
        mapped: dict = {}
        for item in env:
            if isinstance(item, str) and "=" in item:
                key, value = item.split("=", 1)
                mapped[key] = value
        return mapped
    return dict(env or {})


def test_user_api_redis_points_at_compose_service(rendered_compose: dict):
    if rendered_compose.get("_raw"):
        raw = rendered_compose["_raw"]
        assert "REDIS_HOST: redis" in raw
        assert "user-api" in raw
        assert "REDIS_HOST: localhost" not in raw
        return
    env = _env_map(rendered_compose["services"]["user-api"]["environment"])
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
        env = _env_map(rendered_compose["services"][name]["environment"])
        assert env.get("DEPLOYMENT_MODE") == "vps"
        assert env.get("DATABASE_TLS_MODE") == "disable"
        assert env.get("AUDIO_STORAGE_PATH") == "/app/uploads"
        assert env.get("FINAL_AUDIO_ALLOWED_ROOTS") == "/app/uploads"


def test_celery_beat_has_no_database_or_provider_secrets(rendered_compose: dict):
    if rendered_compose.get("_raw"):
        assert "celery-beat" in rendered_compose["_raw"]
        return
    env = _env_map(rendered_compose["services"]["celery-beat"]["environment"])
    keys = set(env)
    assert "DATABASE_URL" not in keys
    assert "GEMINI_API_KEY" not in keys
    assert "DEEPGRAM_API_KEY" not in keys


def test_postgres_redis_not_published_publicly(rendered_compose: dict):
    if rendered_compose.get("_raw"):
        raw = rendered_compose["_raw"]
        assert "5432:5432" not in raw
        assert "6379:6379" not in raw
        assert "REDIS_HOST: redis" in raw
        return
    db = rendered_compose["services"]["db"]
    assert not db.get("ports")
    redis = rendered_compose["services"]["redis"]
    assert not redis.get("ports")
