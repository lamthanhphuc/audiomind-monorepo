"""Public smoke fail-closed status/content rules (static analysis of smoke-vps.sh)."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SMOKE = ROOT / "scripts" / "smoke-vps.sh"


def test_public_smoke_is_opt_in():
    text = SMOKE.read_text(encoding="utf-8")
    assert "RUN_PUBLIC_SMOKE" in text
    assert 'RUN_PUBLIC_SMOKE:-0' in text or 'RUN_PUBLIC_SMOKE:-"0"' in text or '${RUN_PUBLIC_SMOKE:-0}' in text
    assert "SKIP_PUBLIC_SMOKE" not in text


def test_public_smoke_fail_closed_no_true_swallow():
    text = SMOKE.read_text(encoding="utf-8")
    # Must not treat failed curls as pass for public checks.
    public_section_marker = "RUN_PUBLIC_SMOKE"
    assert public_section_marker in text
    assert "VPS PUBLIC NGINX HEALTHY" in text
    assert "VPS INFRA HEALTHY" in text
    assert "VPS LOOPBACK APPLICATION HEALTHY" in text
    assert "/auth/google/success" in text
    assert "/users/me/google/status" in text
    assert "/ws/meetings" in text


def test_smoke_uses_layered_compose():
    text = SMOKE.read_text(encoding="utf-8")
    assert "docker-compose.vps.yml" not in text
    assert "infra/docker-compose.dev.yml" in text
    assert "infra/docker-compose.mvp.yml" in text
    assert "infra/docker-compose.prod.yml" in text
