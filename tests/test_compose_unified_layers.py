"""Effective layered Compose validation (local = dev+mvp, VPS = dev+mvp+prod)."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEV = ROOT / "infra" / "docker-compose.dev.yml"
MVP = ROOT / "infra" / "docker-compose.mvp.yml"
PROD = ROOT / "infra" / "docker-compose.prod.yml"
LOCAL_ENV = ROOT / "infra" / ".env.local.example"
VPS_ENV = ROOT / "infra" / ".env.vps.example"


def _docker_available() -> bool:
    return shutil.which("docker") is not None


def _compose_config(env_file: Path, *compose_files: Path) -> dict:
    cmd = [
        "docker",
        "compose",
        "--env-file",
        str(env_file),
        *[arg for f in compose_files for arg in ("-f", str(f))],
        "config",
        "--format",
        "json",
    ]
    result = subprocess.run(
        cmd,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
        timeout=90,
    )
    if result.returncode != 0:
        pytest.fail(result.stderr or result.stdout or "compose config failed")
    return json.loads(result.stdout)


def _ports(service: dict) -> list:
    return service.get("ports") or []


def _published_hosts(service: dict) -> list[str]:
    hosts: list[str] = []
    for port in _ports(service):
        if isinstance(port, dict):
            hosts.append(str(port.get("host_ip") or port.get("published") or ""))
        else:
            hosts.append(str(port))
    return hosts


def _env(service: dict) -> dict:
    env = service.get("environment") or {}
    if isinstance(env, list):
        out = {}
        for item in env:
            if isinstance(item, str) and "=" in item:
                k, v = item.split("=", 1)
                out[k] = v
        return out
    return dict(env)


@pytest.fixture(scope="module")
def local_config() -> dict:
    if not _docker_available():
        pytest.skip("docker required")
    return _compose_config(LOCAL_ENV, DEV, MVP)


@pytest.fixture(scope="module")
def vps_config() -> dict:
    if not _docker_available():
        pytest.skip("docker required")
    return _compose_config(VPS_ENV, DEV, MVP, PROD)


def test_local_has_no_migrate_profile(local_config: dict):
    for name, svc in local_config["services"].items():
        assert not (svc.get("profiles") or []), f"{name} has profiles"


def test_vps_has_no_migrate_profile(vps_config: dict):
    for name, svc in vps_config["services"].items():
        assert not (svc.get("profiles") or []), f"{name} has profiles"


def test_vps_db_redis_private(vps_config: dict):
    assert _ports(vps_config["services"]["db"]) == []
    assert _ports(vps_config["services"]["redis"]) == []


def test_vps_apis_loopback(vps_config: dict):
    for name in ("user-api", "meeting-api", "processing-api", "ai-api", "web"):
        hosts = _published_hosts(vps_config["services"][name])
        assert any("127.0.0.1" in h for h in hosts), f"{name} ports={hosts}"


def test_vps_user_redis(vps_config: dict):
    env = _env(vps_config["services"]["user-api"])
    assert env.get("REDIS_HOST") == "redis"
    assert str(env.get("REDIS_PORT", "6379")) == "6379"
    assert str(env.get("REDIS_DB", env.get("REDIS_DB"))) in {"3", 3} or env.get("REDIS_DB") in (3, "3")


def test_vps_ai_tls_and_uploads(vps_config: dict):
    env = _env(vps_config["services"]["ai-api"])
    assert env.get("APP_ENV") == "production"
    assert env.get("DEPLOYMENT_MODE") == "vps"
    assert env.get("DATABASE_TLS_MODE") == "disable"
    assert env.get("AUDIO_STORAGE_PATH") == "/app/uploads"
    assert env.get("FINAL_AUDIO_ALLOWED_ROOTS") == "/app/uploads"
    vols = json.dumps(vps_config["services"]["ai-api"].get("volumes") or [])
    assert "uploads" in vols


def test_vps_beat_broker_only(vps_config: dict):
    env = _env(vps_config["services"]["celery-beat"])
    assert env.get("APP_COMPONENT") == "beat"
    assert not env.get("DATABASE_URL")
    assert not env.get("GEMINI_API_KEY")
    assert not env.get("DEEPGRAM_API_KEY")
    assert not env.get("MEETING_SERVICE_BASE_URL")


def test_vps_spring_flyway_disabled(vps_config: dict):
    for name in ("user-api", "meeting-api"):
        env = _env(vps_config["services"][name])
        assert str(env.get("SPRING_FLYWAY_ENABLED")).lower() == "false"


def test_migration_depends_chain(vps_config: dict):
    services = vps_config["services"]

    def deps(name: str) -> dict:
        raw = services[name].get("depends_on") or {}
        if isinstance(raw, list):
            return {d: {} for d in raw}
        return raw

    assert "db" in deps("db-flyway-bootstrap")
    assert "db-flyway-bootstrap" in deps("user-db-migrate")
    assert "user-db-migrate" in deps("meeting-db-migrate")
    assert "meeting-db-migrate" in deps("ai-db-migrate")
    assert "user-db-migrate" in deps("user-api")
    assert "meeting-db-migrate" in deps("meeting-api")
    assert "ai-db-migrate" in deps("ai-api")
    assert "ai-db-migrate" in deps("celery-worker")


def test_local_app_env_development(local_config: dict):
    env = _env(local_config["services"]["ai-api"])
    assert (env.get("APP_ENV") or "development").lower() in {"development", "dev"}


def test_vps_yml_retired():
    assert not (ROOT / "infra" / "docker-compose.vps.yml").exists()


def test_local_project_name(local_config: dict):
    assert local_config.get("name") == "audiomind-local"


def test_vps_project_name(vps_config: dict):
    assert vps_config.get("name") == "audiomind-prod"


def test_no_fixed_container_names(local_config: dict, vps_config: dict):
    for cfg in (local_config, vps_config):
        for name, svc in cfg["services"].items():
            assert "container_name" not in svc, f"{name} still has container_name"


def test_local_required_services(local_config: dict):
    required = {
        "db", "redis", "db-flyway-bootstrap", "user-db-migrate",
        "meeting-db-migrate", "ai-db-migrate", "user-api", "meeting-api",
        "processing-api", "ai-api", "celery-worker", "celery-beat", "web",
    }
    assert required.issubset(set(local_config["services"]))


def test_beat_depends_only_redis(local_config: dict):
    deps = local_config["services"]["celery-beat"].get("depends_on") or {}
    if isinstance(deps, list):
        keys = set(deps)
    else:
        keys = set(deps)
    assert keys == {"redis"}


def test_user_api_does_not_depend_ai_migrate(local_config: dict):
    deps = local_config["services"]["user-api"].get("depends_on") or {}
    keys = set(deps if isinstance(deps, list) else deps)
    assert "ai-db-migrate" not in keys
