"""Managed PostgreSQL wiring guards against rendered K8s overlays."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
OVERLAYS = ("dev", "staging", "prod")

_kubectl = shutil.which("kubectl")
_kustomize_bin = shutil.which("kustomize")
_REQUIRE = os.environ.get("REQUIRE_K8S_RENDER_TESTS", "").strip().lower() in {
    "1",
    "true",
    "yes",
}

if not _kubectl and not _kustomize_bin:
    _msg = "kubectl/kustomize required for managed database wiring tests"
    if _REQUIRE:
        pytest.fail(_msg)
    pytest.skip(_msg, allow_module_level=True)


def _kustomize(overlay: str) -> list[dict[str, Any]]:
    if _kubectl:
        cmd = [
            _kubectl,
            "kustomize",
            f"k8s/overlays/{overlay}",
            "--load-restrictor=LoadRestrictionsNone",
        ]
    else:
        cmd = [
            _kustomize_bin,
            "build",
            f"k8s/overlays/{overlay}",
            "--load-restrictor=LoadRestrictionsNone",
        ]
    result = subprocess.run(
        cmd, cwd=REPO_ROOT, check=False, capture_output=True, text=True
    )
    if result.returncode != 0:
        raise AssertionError(
            f"kustomize {overlay} failed: {result.stderr or result.stdout}"
        )
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def _find_deployment(docs: list[dict[str, Any]], name: str) -> dict[str, Any]:
    for doc in docs:
        if (
            doc.get("kind") == "Deployment"
            and (doc.get("metadata") or {}).get("name") == name
        ):
            return doc
    raise AssertionError(f"missing deployment {name}")


def _env_secret_ref(container: dict[str, Any], env_name: str) -> dict[str, str]:
    for e in container.get("env") or []:
        if e.get("name") != env_name:
            continue
        sk = ((e.get("valueFrom") or {}).get("secretKeyRef") or {})
        assert sk, f"{env_name} must use secretKeyRef"
        return {"name": str(sk.get("name")), "key": str(sk.get("key"))}
    raise AssertionError(f"env {env_name} not found")


def _producers(docs: list[dict[str, Any]]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for doc in docs:
        kind = doc.get("kind")
        meta = doc.get("metadata") or {}
        if kind == "Secret":
            name = meta.get("name")
            if name:
                out.setdefault(str(name), []).append("Secret")
        elif kind == "SealedSecret":
            tmpl = ((doc.get("spec") or {}).get("template") or {}).get("metadata") or {}
            name = tmpl.get("name") or meta.get("name")
            if name:
                out.setdefault(str(name), []).append("SealedSecret")
    return out


def _db_replicas(docs: list[dict[str, Any]]) -> int | None:
    for doc in docs:
        if (
            doc.get("kind") == "Deployment"
            and (doc.get("metadata") or {}).get("name") == "db-deployment"
        ):
            return int((doc.get("spec") or {}).get("replicas") or 0)
    return None


def _secret_keys(docs: list[dict[str, Any]], secret_name: str) -> set[str]:
    keys: set[str] = set()
    for doc in docs:
        kind = doc.get("kind")
        meta = doc.get("metadata") or {}
        if kind == "Secret" and meta.get("name") == secret_name:
            keys |= set(doc.get("stringData") or {}) | set(doc.get("data") or {})
        elif kind == "SealedSecret":
            tmpl = ((doc.get("spec") or {}).get("template") or {}).get("metadata") or {}
            target = tmpl.get("name") or meta.get("name")
            if target == secret_name:
                keys |= set((doc.get("spec") or {}).get("encryptedData") or {})
    return keys


@pytest.fixture(scope="module")
def rendered() -> dict[str, list[dict[str, Any]]]:
    return {overlay: _kustomize(overlay) for overlay in OVERLAYS}


@pytest.mark.parametrize("overlay", OVERLAYS)
def test_audiomind_db_secrets_single_owner(rendered, overlay: str) -> None:
    owners = _producers(rendered[overlay]).get("audiomind-db-secrets", [])
    assert len(owners) == 1, owners
    if overlay == "dev":
        assert owners == ["Secret"]
    else:
        assert owners == ["SealedSecret"]


@pytest.mark.parametrize("overlay", OVERLAYS)
def test_db_secret_keys_present(rendered, overlay: str) -> None:
    keys = _secret_keys(rendered[overlay], "audiomind-db-secrets")
    for required in (
        "MEETING_DATABASE_URL",
        "USER_DATABASE_URL",
        "AI_DATABASE_URL",
        "DB_USERNAME",
        "DB_PASSWORD",
    ):
        assert required in keys


@pytest.mark.parametrize("overlay", ("staging", "prod"))
def test_staging_prod_internal_db_absent_and_no_db_host(
    rendered, overlay: str
) -> None:
    docs = rendered[overlay]
    # Direction B: internal DB lives only in the dev overlay.
    assert _db_replicas(docs) is None
    assert not any(
        d.get("kind") == "Service" and (d.get("metadata") or {}).get("name") == "db"
        for d in docs
    )
    blob = yaml.safe_dump_all(docs)
    assert "your-managed-db-host" not in blob
    assert "your_username" not in blob
    assert "your_password" not in blob
    assert "name: db-creds" not in blob
    for doc in docs:
        if doc.get("kind") != "Deployment":
            continue
        dn = (doc.get("metadata") or {}).get("name")
        for c in (doc.get("spec") or {}).get("template", {}).get("spec", {}).get(
            "containers"
        ) or []:
            for e in c.get("env") or []:
                value = e.get("value")
                if not value:
                    continue
                text = str(value)
                assert "://db:" not in text and "@db:" not in text, (
                    f"{overlay}/{dn} env {e.get('name')} still points at db: {text}"
                )
                assert "localhost" not in text.lower()
                assert "127.0.0.1" not in text


def test_dev_internal_db_enabled(rendered) -> None:
    assert _db_replicas(rendered["dev"]) >= 1
    assert any(
        d.get("kind") == "Service" and (d.get("metadata") or {}).get("name") == "db"
        for d in rendered["dev"]
    )


@pytest.mark.parametrize("overlay", OVERLAYS)
@pytest.mark.parametrize(
    "deployment,url_env,url_key",
    (
        ("meeting-api-deployment", "SPRING_DATASOURCE_URL", "MEETING_DATABASE_URL"),
        ("user-api-deployment", "SPRING_DATASOURCE_URL", "USER_DATABASE_URL"),
        ("ai-api-deployment", "DATABASE_URL", "AI_DATABASE_URL"),
        ("celery-worker-deployment", "DATABASE_URL", "AI_DATABASE_URL"),
    ),
)
def test_services_wire_db_from_audiomind_db_secrets(
    rendered, overlay: str, deployment: str, url_env: str, url_key: str
) -> None:
    docs = rendered[overlay]
    container = _find_deployment(docs, deployment)["spec"]["template"]["spec"][
        "containers"
    ][0]
    url_ref = _env_secret_ref(container, url_env)
    assert url_ref == {"name": "audiomind-db-secrets", "key": url_key}
    user_ref = _env_secret_ref(container, "SPRING_DATASOURCE_USERNAME") if url_env.startswith(
        "SPRING"
    ) else None
    if user_ref is not None:
        assert user_ref == {"name": "audiomind-db-secrets", "key": "DB_USERNAME"}
        pass_ref = _env_secret_ref(container, "SPRING_DATASOURCE_PASSWORD")
        assert pass_ref == {"name": "audiomind-db-secrets", "key": "DB_PASSWORD"}


@pytest.mark.parametrize("overlay", OVERLAYS)
def test_processing_has_no_datasource(rendered, overlay: str) -> None:
    container = _find_deployment(rendered[overlay], "processing-api-deployment")[
        "spec"
    ]["template"]["spec"]["containers"][0]
    names = {e.get("name") for e in container.get("env") or []}
    assert "SPRING_DATASOURCE_URL" not in names
    assert "DATABASE_URL" not in names


@pytest.mark.parametrize("overlay", OVERLAYS)
def test_beat_has_no_database_url(rendered, overlay: str) -> None:
    container = _find_deployment(rendered[overlay], "celery-beat-deployment")["spec"][
        "template"
    ]["spec"]["containers"][0]
    names = {e.get("name") for e in container.get("env") or []}
    assert "DATABASE_URL" not in names


def test_dev_url_schemes(rendered) -> None:
    docs = rendered["dev"]
    for doc in docs:
        if doc.get("kind") != "Secret":
            continue
        if (doc.get("metadata") or {}).get("name") != "audiomind-db-secrets":
            continue
        sd = doc.get("stringData") or {}
        assert str(sd["MEETING_DATABASE_URL"]).startswith("jdbc:postgresql://")
        assert str(sd["USER_DATABASE_URL"]).startswith("jdbc:postgresql://")
        assert str(sd["AI_DATABASE_URL"]).startswith("postgresql://")
        assert not str(sd["AI_DATABASE_URL"]).startswith("jdbc:")
        return
    raise AssertionError("dev audiomind-db-secrets Secret missing")
