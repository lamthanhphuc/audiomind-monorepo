"""Deploy script build-once / SKIP_BUILD / layered compose behavior."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEPLOY_VPS = ROOT / "scripts" / "deploy-vps.sh"
DEPLOY_LOCAL = ROOT / "scripts" / "deploy-local.sh"


def test_deploy_vps_layered_compose_and_build_once():
    text = DEPLOY_VPS.read_text(encoding="utf-8")
    assert "up -d --build" not in text
    assert "docker-compose.vps.yml" not in text
    assert "--profile migrate" not in text
    assert "infra/docker-compose.dev.yml" in text
    assert "infra/docker-compose.mvp.yml" in text
    assert "infra/docker-compose.prod.yml" in text
    assert "SKIP_BUILD" in text
    assert 'source "${ENV_FILE}"' not in text
    assert "load-compose-env.py" in text
    assert "DATABASE_TLS_MODE" in text
    # Exactly one compose build path (skippable), not duplicated up --build
    assert text.count('"${COMPOSE[@]}" build') == 1 or text.count("${COMPOSE[@]} build") == 1


def test_deploy_local_two_file_compose():
    text = DEPLOY_LOCAL.read_text(encoding="utf-8")
    assert "infra/docker-compose.dev.yml" in text
    assert "infra/docker-compose.mvp.yml" in text
    assert "infra/docker-compose.prod.yml" not in text
    assert "docker-compose.vps.yml" not in text
    assert "SKIP_BUILD" in text
    assert "up -d --build" not in text
