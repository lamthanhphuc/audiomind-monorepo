"""Ensure SealedSecret generators cover every secretKeyRef used by workloads."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
GENERATOR_SH = REPO_ROOT / "scripts" / "generate-sealed-secrets.sh"
GENERATOR_PS1 = REPO_ROOT / "scripts" / "generate-sealed-secrets.ps1"

_kubectl = shutil.which("kubectl")
_REQUIRE = os.environ.get("REQUIRE_K8S_RENDER_TESTS", "").strip().lower() in {
    "1",
    "true",
    "yes",
}

if not _kubectl:
    _msg = "kubectl required for sealed secret key coverage tests"
    if _REQUIRE:
        pytest.fail(_msg)
    pytest.skip(_msg, allow_module_level=True)


def _kustomize(overlay: str) -> list[dict[str, Any]]:
    result = subprocess.run(
        [
            "kubectl",
            "kustomize",
            f"k8s/overlays/{overlay}",
            "--load-restrictor=LoadRestrictionsNone",
        ],
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr or result.stdout)
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def _secret_refs(docs: list[dict[str, Any]]) -> dict[str, set[str]]:
    """Map secret name → required keys (optional refs excluded)."""
    out: dict[str, set[str]] = {}
    for doc in docs:
        if doc.get("kind") not in {"Deployment", "Job", "StatefulSet", "CronJob"}:
            continue
        pods = []
        if doc.get("kind") == "Job":
            pods = [(doc.get("spec") or {}).get("template") or {}]
        else:
            pods = [(doc.get("spec") or {}).get("template") or {}]
        for pod in pods:
            spec = pod.get("spec") or {}
            containers = list(spec.get("containers") or []) + list(
                spec.get("initContainers") or []
            )
            for c in containers:
                for e in c.get("env") or []:
                    sk = (e.get("valueFrom") or {}).get("secretKeyRef") or {}
                    if not sk:
                        continue
                    if sk.get("optional") in (True, "true", "True"):
                        continue
                    name = str(sk.get("name") or "")
                    key = str(sk.get("key") or "")
                    if name and key:
                        out.setdefault(name, set()).add(key)
    return out


def _generator_app_keys() -> set[str]:
    text = GENERATOR_SH.read_text(encoding="utf-8")
    match = re.search(r"REQUIRED_APP_KEYS=\((.*?)\)", text, flags=re.DOTALL)
    assert match, "REQUIRED_APP_KEYS not found in generate-sealed-secrets.sh"
    keys = set(re.findall(r"[A-Z][A-Z0-9_]+", match.group(1)))
    # Deepgram is conditional but supported by generator
    keys.add("DEEPGRAM_API_KEY")
    return keys


def _generator_db_keys() -> set[str]:
    text = GENERATOR_SH.read_text(encoding="utf-8")
    match = re.search(r"REQUIRED_DB_KEYS=\((.*?)\)", text, flags=re.DOTALL)
    assert match, "REQUIRED_DB_KEYS not found in generate-sealed-secrets.sh"
    return set(re.findall(r"[A-Z][A-Z0-9_]+", match.group(1)))


@pytest.mark.parametrize("overlay", ("staging", "prod"))
def test_generator_covers_required_secret_key_refs(overlay: str) -> None:
    refs = _secret_refs(_kustomize(overlay))
    app_keys = _generator_app_keys()
    db_keys = _generator_db_keys()
    assert GENERATOR_PS1.exists()

    for key in refs.get("audiomind-secrets", set()):
        assert key in app_keys, (
            f"{overlay}: secretKeyRef audiomind-secrets/{key} not generatable "
            f"(generator keys={sorted(app_keys)})"
        )
    for key in refs.get("audiomind-db-secrets", set()):
        assert key in db_keys, (
            f"{overlay}: secretKeyRef audiomind-db-secrets/{key} not generatable "
            f"(generator keys={sorted(db_keys)})"
        )
