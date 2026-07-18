"""Beat subprocess startup: schedules without DATABASE_URL or SQLAlchemy engine."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]

_BEAT_SCHEDULE_SCRIPT = """
import json
import os
import sys
from importlib import reload

if os.environ.get("DATABASE_URL"):
    print("unexpected DATABASE_URL", file=sys.stderr)
    sys.exit(2)

import app.config as config_mod
import app.celery_app as celery_mod

config_mod.get_settings.cache_clear()
celery_mod = reload(celery_mod)

schedule = celery_mod.celery_app.conf.beat_schedule or {}
print(json.dumps(sorted(schedule.keys())))
"""

_GET_ENGINE_SCRIPT = """
import os
import sys
from importlib import reload

import app.config as config_mod
import app.database as database_mod

config_mod.get_settings.cache_clear()
database_mod = reload(database_mod)

try:
    database_mod.get_engine()
except RuntimeError:
    print("RUNTIME_ERROR")
    sys.exit(0)

print("expected RuntimeError", file=sys.stderr)
sys.exit(1)
"""


def _beat_production_env() -> dict[str, str]:
    env = os.environ.copy()
    env.pop("DATABASE_URL", None)
    env["APP_ENV"] = "production"
    env["APP_COMPONENT"] = "beat"
    env["CELERY_BROKER_URL"] = "redis://redis.prod.internal:6379/0"
    env["CELERY_RESULT_BACKEND"] = "redis://redis.prod.internal:6379/1"
    return env


def _run_subprocess(script: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", script],
        cwd=AI_SERVICE_ROOT,
        env=_beat_production_env(),
        text=True,
        capture_output=True,
        check=False,
    )


def test_beat_subprocess_loads_schedule_without_database_url():
    result = _run_subprocess(_BEAT_SCHEDULE_SCRIPT)
    assert result.returncode == 0, result.stderr or result.stdout

    output = result.stdout.strip()
    assert output
    assert "study-generation-reconcile" in output
    assert "DATABASE" not in (result.stderr or "").upper()


def test_beat_subprocess_get_engine_raises_runtime_error():
    result = _run_subprocess(_GET_ENGINE_SCRIPT)
    assert result.returncode == 0, result.stderr or result.stdout
    assert "RUNTIME_ERROR" in result.stdout
