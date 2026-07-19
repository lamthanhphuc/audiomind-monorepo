"""Deploy script build-once / SKIP_BUILD behavior."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "scripts" / "deploy-vps.sh"


def test_deploy_vps_does_not_use_up_build():
    text = DEPLOY.read_text(encoding="utf-8")
    assert "up -d --build" not in text
    assert re.search(r'up -d \\\s*\n\s*user-api', text) or 'up -d' in text
    assert 'SKIP_BUILD' in text
    assert '--profile migrate build' in text
    # Safe env loader, not source/.env
    assert 'source "${ENV_FILE}"' not in text
    assert "load-compose-env.py" in text
