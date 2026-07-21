"""Startup Settings checks against kubectl-kustomize rendered overlay manifests.

Resolves Deployment container env (literal / ConfigMap / Secret / SealedSecret)
from ``kubectl kustomize`` / ``kustomize build`` and instantiates ``Settings``
the same way each AI component would at boot.

Also asserts Java service JWT_SECRET wiring for meeting/processing/user.
"""

from __future__ import annotations

import base64
import importlib
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

from app.config import Settings, get_settings

REPO_ROOT = Path(__file__).resolve().parents[3]
OVERLAYS = ("dev", "staging", "prod")
TARGET_DEPLOYMENTS = {
    "ai-api-deployment": "api",
    "celery-worker-deployment": "worker",
    "celery-beat-deployment": "beat",
}
JAVA_DEPLOYMENTS = (
    "meeting-api-deployment",
    "processing-api-deployment",
    "user-api-deployment",
)

_SETTINGS_ENV_KEYS = (
    "APP_ENV",
    "APP_COMPONENT",
    "DATABASE_URL",
    "GEMINI_API_KEY",
    "GEMINI_API_KEYS",
    "GEMINI_MULTI_KEY_ENABLED",
    "ANALYSIS_PROVIDER",
    "AI_PROVIDER",
    "CORS_ALLOWED_ORIGINS",
    "MEETING_SERVICE_BASE_URL",
    "MEETING_API_BASE_URL",
    "AUDIOMIND_MEETING_API_BASE_URL",
    "INTERNAL_SERVICE_TOKEN",
    "GOOGLE_INTERNAL_SERVICE_TOKEN",
    "CELERY_BROKER_URL",
    "CELERY_RESULT_BACKEND",
    "CELERY_STUDY_GENERATION_QUEUE",
    "STUDY_GENERATION_QUEUE",
    "OLLAMA_BASE_URL",
    "HUGGINGFACE_TOKEN",
    "ENABLE_SPEAKER_DIARIZATION",
    "STT_PROVIDER",
    "ALLOW_LEGACY_LOCAL_STT",
    "DEEPGRAM_DIARIZE",
    "JOB_STATE_REDIS_URL",
    "CELERY_CONCURRENCY",
    "CELERY_PREFETCH_MULTIPLIER",
    "WORKER_HEALTH_PORT",
    "OLLAMA_MODEL",
    "OTEL_SERVICE_NAME",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
)

_kubectl = shutil.which("kubectl")
_kustomize_bin = shutil.which("kustomize")
_REQUIRE = os.environ.get("REQUIRE_K8S_RENDER_TESTS", "").strip().lower() in {
    "1",
    "true",
    "yes",
}

if not _kubectl and not _kustomize_bin:
    _msg = (
        "kubectl/kustomize not found on PATH; required for rendered K8s Settings tests"
    )
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
        cmd,
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"kustomize k8s/overlays/{overlay} failed "
            f"(exit {result.returncode}): {result.stderr or result.stdout}"
        )
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def _index_config_and_secrets(
    docs: list[dict[str, Any]],
) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
    config: dict[str, str] = {}
    secrets: dict[str, dict[str, str]] = {}
    for doc in docs:
        kind = doc.get("kind")
        name = (doc.get("metadata") or {}).get("name")
        if kind == "ConfigMap" and name == "audiomind-config":
            for key, value in (doc.get("data") or {}).items():
                config[str(key)] = "" if value is None else str(value)
        elif kind == "Secret" and name:
            bucket = secrets.setdefault(str(name), {})
            for key, value in (doc.get("stringData") or {}).items():
                bucket[str(key)] = "" if value is None else str(value)
            for key, value in (doc.get("data") or {}).items():
                if value is None:
                    bucket[str(key)] = ""
                    continue
                raw = str(value)
                try:
                    bucket[str(key)] = base64.b64decode(raw).decode("utf-8")
                except Exception:  # noqa: BLE001
                    bucket[str(key)] = raw
        elif kind == "SealedSecret":
            tmpl = ((doc.get("spec") or {}).get("template") or {}).get("metadata") or {}
            target = tmpl.get("name") or name
            if not target:
                continue
            bucket = secrets.setdefault(str(target), {})
            for key in (doc.get("spec") or {}).get("encryptedData") or {}:
                # Synthetic plaintext for Settings/wiring checks (not real ciphertext).
                synthetic = {
                    "MEETING_DATABASE_URL": (
                        "jdbc:postgresql://managed-db.test:5432/audiomind?sslmode=require"
                    ),
                    "USER_DATABASE_URL": (
                        "jdbc:postgresql://managed-db.test:5432/audiomind?sslmode=require"
                    ),
                    "AI_DATABASE_URL": (
                        "postgresql://audiomind:secure-pass@managed-db.test:5432/audiomind?sslmode=require"
                    ),
                    "DB_USERNAME": "audiomind",
                    "DB_PASSWORD": "secure-pass",
                    "JWT_SECRET": "sealed-placeholder-value-at-least-32-chars",
                    "INTERNAL_SERVICE_TOKEN": (
                        "sealed-placeholder-value-at-least-32-chars"
                    ),
                    "GEMINI_API_KEY": "sealed-placeholder-gemini-key-value",
                }.get(str(key), "sealed-placeholder-value-at-least-32-chars")
                bucket.setdefault(str(key), synthetic)
    return config, secrets


def _resolve_container_env(
    container: dict[str, Any],
    config: dict[str, str],
    secrets: dict[str, dict[str, str]],
) -> dict[str, str]:
    resolved: dict[str, str] = {}
    for entry in container.get("env") or []:
        name = entry.get("name")
        if not name:
            continue
        if "value" in entry and entry.get("valueFrom") is None:
            resolved[str(name)] = (
                "" if entry.get("value") is None else str(entry["value"])
            )
            continue
        value_from = entry.get("valueFrom") or {}
        cm_ref = value_from.get("configMapKeyRef") or {}
        if cm_ref:
            key = cm_ref.get("key")
            assert key in config, (
                f"env {name}: configMapKeyRef key {key!r} missing from "
                f"ConfigMap audiomind-config"
            )
            resolved[str(name)] = config[str(key)]
            continue
        secret_ref = value_from.get("secretKeyRef") or {}
        if secret_ref:
            sname = str(secret_ref.get("name") or "")
            key = str(secret_ref.get("key") or "")
            optional = secret_ref.get("optional") in (True, "true", "True")
            assert (
                sname != "jwt-secret"
            ), f"env {name}: legacy Secret jwt-secret must not be referenced"
            if sname not in secrets:
                assert (
                    optional
                ), f"env {name}: secretKeyRef Secret {sname!r} has no producer in render"
                continue
            if key not in secrets[sname]:
                assert (
                    optional
                ), f"env {name}: secretKeyRef key {key!r} missing from Secret {sname}"
                continue
            resolved[str(name)] = secrets[sname][key]
            continue
    return resolved


def _find_deployment(docs: list[dict[str, Any]], name: str) -> dict[str, Any]:
    for doc in docs:
        if (
            doc.get("kind") == "Deployment"
            and (doc.get("metadata") or {}).get("name") == name
        ):
            return doc
    raise AssertionError(f"Deployment {name} not found in rendered overlay")


def _apply_resolved_env(
    monkeypatch: pytest.MonkeyPatch, resolved: dict[str, str]
) -> None:
    for key in _SETTINGS_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    synced = dict(resolved)
    if "ANALYSIS_PROVIDER" in synced and "AI_PROVIDER" not in synced:
        synced["AI_PROVIDER"] = synced["ANALYSIS_PROVIDER"]
    elif "AI_PROVIDER" in synced and "ANALYSIS_PROVIDER" not in synced:
        synced["ANALYSIS_PROVIDER"] = synced["AI_PROVIDER"]
    for key, value in synced.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()


def _secret_producers(docs: list[dict[str, Any]]) -> dict[str, list[str]]:
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


@pytest.fixture(scope="module")
def rendered_overlays() -> dict[str, list[dict[str, Any]]]:
    return {overlay: _kustomize(overlay) for overlay in OVERLAYS}


def _ensure_synthetic_managed_secrets(
    secrets: dict[str, dict[str, str]], overlay: str
) -> None:
    """Staging/prod apply SealedSecrets out-of-band; inject synthetic values for Settings checks."""
    if overlay not in {"staging", "prod"}:
        return
    secrets.setdefault(
        "audiomind-db-secrets",
        {
            "MEETING_DATABASE_URL": (
                "jdbc:postgresql://managed-db.test:5432/audiomind?sslmode=require"
            ),
            "USER_DATABASE_URL": (
                "jdbc:postgresql://managed-db.test:5432/audiomind?sslmode=require"
            ),
            "AI_DATABASE_URL": (
                "postgresql://audiomind:secure-pass@managed-db.test:5432/audiomind"
                "?sslmode=require"
            ),
            "DB_USERNAME": "audiomind",
            "DB_PASSWORD": "secure-pass",
        },
    )
    secrets.setdefault(
        "audiomind-secrets",
        {
            "JWT_SECRET": "sealed-placeholder-value-at-least-32-chars",
            "INTERNAL_SERVICE_TOKEN": "sealed-placeholder-value-at-least-32-chars",
            "GEMINI_API_KEY": "sealed-placeholder-gemini-key-value",
            "HUGGINGFACE_TOKEN": "hf-sealed-placeholder-token-value",
            "GF_SECURITY_ADMIN_USER": "admin",
            "GF_SECURITY_ADMIN_PASSWORD": "admin-password-value",
        },
    )


@pytest.mark.parametrize("overlay", OVERLAYS)
def test_no_legacy_jwt_secret_or_user_jwt_secret(
    rendered_overlays, overlay: str
) -> None:
    docs = rendered_overlays[overlay]
    blob = yaml.safe_dump_all(docs)
    assert "name: jwt-secret" not in blob
    assert "USER_JWT_SECRET" not in blob
    # secretKeyRef name must never be the removed jwt-secret resource
    for doc in docs:
        if doc.get("kind") != "Deployment":
            continue
        for c in (doc.get("spec") or {}).get("template", {}).get("spec", {}).get(
            "containers"
        ) or []:
            for e in c.get("env") or []:
                sk = (e.get("valueFrom") or {}).get("secretKeyRef") or {}
                assert sk.get("name") != "jwt-secret"


@pytest.mark.parametrize("overlay", OVERLAYS)
def test_no_duplicate_audiomind_secrets_ownership(
    rendered_overlays, overlay: str
) -> None:
    producers = _secret_producers(rendered_overlays[overlay])
    owners = producers.get("audiomind-secrets", [])
    if overlay == "dev":
        assert owners == ["Secret"]
    else:
        # Staging/prod apply SealedSecrets out-of-band (not in kustomize resources).
        assert owners == []


@pytest.mark.parametrize("overlay", OVERLAYS)
@pytest.mark.parametrize("deployment_name", JAVA_DEPLOYMENTS)
def test_java_deployments_wire_jwt_from_audiomind_secrets(
    rendered_overlays, overlay: str, deployment_name: str
) -> None:
    docs = rendered_overlays[overlay]
    config, secrets = _index_config_and_secrets(docs)
    _ensure_synthetic_managed_secrets(secrets, overlay)
    deployment = _find_deployment(docs, deployment_name)
    container = deployment["spec"]["template"]["spec"]["containers"][0]
    resolved = _resolve_container_env(container, config, secrets)

    assert "JWT_SECRET" in resolved
    assert resolved["JWT_SECRET"].strip()
    assert "INTERNAL_SERVICE_TOKEN" in resolved
    assert resolved["INTERNAL_SERVICE_TOKEN"].strip()

    # Explicit secretKeyRef shape
    env_by_name = {e["name"]: e for e in (container.get("env") or []) if e.get("name")}
    jwt = env_by_name["JWT_SECRET"]["valueFrom"]["secretKeyRef"]
    assert jwt["name"] == "audiomind-secrets"
    assert jwt["key"] == "JWT_SECRET"

    if deployment_name == "meeting-api-deployment":
        ds = env_by_name["SPRING_DATASOURCE_URL"]["valueFrom"]["secretKeyRef"]
        assert ds == {"name": "audiomind-db-secrets", "key": "MEETING_DATABASE_URL"}
        assert resolved["SPRING_DATASOURCE_URL"].startswith("jdbc:postgresql://")
        cors = resolved.get("CORS_ALLOWED_ORIGINS", "")
        if overlay in {"staging", "prod"}:
            assert "localhost" not in cors.lower()
            assert "://db:" not in resolved["SPRING_DATASOURCE_URL"]
    if deployment_name == "processing-api-deployment":
        user_url = resolved.get("AUDIOMIND_USER_API_BASE_URL", "")
        assert user_url
        assert "SPRING_DATASOURCE_URL" not in env_by_name
        if overlay in {"staging", "prod"}:
            assert "localhost" not in user_url.lower()
            ai_url = resolved.get("AUDIOMIND_AI_API_BASE_URL", "")
            assert ai_url and "localhost" not in ai_url.lower()
    if deployment_name == "user-api-deployment":
        ds = env_by_name["SPRING_DATASOURCE_URL"]["valueFrom"]["secretKeyRef"]
        assert ds == {"name": "audiomind-db-secrets", "key": "USER_DATABASE_URL"}
        assert resolved["SPRING_DATASOURCE_URL"].startswith("jdbc:postgresql://")
        if overlay in {"staging", "prod"}:
            assert "://db:" not in resolved["SPRING_DATASOURCE_URL"]


@pytest.mark.parametrize("overlay", OVERLAYS)
@pytest.mark.parametrize(
    "deployment_name,component",
    list(TARGET_DEPLOYMENTS.items()),
    ids=list(TARGET_DEPLOYMENTS.values()),
)
def test_rendered_component_settings(
    monkeypatch: pytest.MonkeyPatch,
    rendered_overlays: dict[str, list[dict[str, Any]]],
    overlay: str,
    deployment_name: str,
    component: str,
) -> None:
    docs = rendered_overlays[overlay]
    config, secrets = _index_config_and_secrets(docs)
    _ensure_synthetic_managed_secrets(secrets, overlay)
    deployment = _find_deployment(docs, deployment_name)
    containers = deployment["spec"]["template"]["spec"]["containers"]
    assert containers, f"{deployment_name} has no containers"
    container = containers[0]
    resolved = _resolve_container_env(container, config, secrets)

    assert resolved.get("APP_COMPONENT") == component
    if overlay == "dev":
        assert resolved.get("APP_ENV") == "development"
    else:
        assert resolved.get("APP_ENV") == "production"

    if component in {"api", "worker"} and overlay in {"staging", "prod"}:
        gemini = resolved.get("GEMINI_API_KEY", "")
        assert gemini.strip(), (
            f"{overlay}/{component}: GEMINI_API_KEY from Secret must be non-empty "
            f"(placeholder REPLACE_ME is OK); got {gemini!r}"
        )
        assert resolved.get("ANALYSIS_PROVIDER") == "gemini"
        assert resolved.get("MEETING_SERVICE_BASE_URL")
        assert resolved.get("INTERNAL_SERVICE_TOKEN", "").strip()

    if component == "worker":
        assert resolved.get("CELERY_STUDY_GENERATION_QUEUE") == "study_generation"

    if component == "beat":
        for forbidden in (
            "GEMINI_API_KEY",
            "CORS_ALLOWED_ORIGINS",
            "MEETING_SERVICE_BASE_URL",
            "INTERNAL_SERVICE_TOKEN",
            "DATABASE_URL",
        ):
            assert (
                forbidden not in resolved
            ), f"beat container must not set {forbidden}; got {resolved.get(forbidden)!r}"
        assert deployment["spec"].get("replicas") == 1

    if component in {"api", "worker"}:
        assert resolved.get(
            "DATABASE_URL", ""
        ).strip(), f"{overlay}/{component}: DATABASE_URL must resolve from audiomind-db-secrets"
        db_url = resolved["DATABASE_URL"]
        assert db_url.startswith("postgresql://") or db_url.startswith(
            "postgresql+psycopg2://"
        )
        assert not db_url.startswith("jdbc:")
        assert not db_url.startswith("postgresql+psycopg://")
        assert not db_url.startswith("postgresql+asyncpg://")
        if overlay in {"staging", "prod"}:
            assert (
                "sslmode=require" in db_url.lower()
                or "sslmode=verify-full" in db_url.lower()
            )

    _apply_resolved_env(monkeypatch, resolved)

    settings = Settings(_env_file=None)
    assert settings.app_component == component
    assert (settings.app_env or "").strip().lower() == resolved[
        "APP_ENV"
    ].strip().lower()

    if overlay in {"staging", "prod"} and component == "api":
        assert (settings.analysis_provider or "").strip().lower() == "gemini"
        assert (settings.gemini_api_key or "").strip()
        assert (settings.meeting_service_base_url or "").strip()
        assert (settings.internal_service_token or "").strip()
        assert "localhost" not in (settings.cors_allowed_origins or "").lower()
        assert get_settings().app_component == "api"

    if overlay in {"staging", "prod"} and component == "worker":
        assert (settings.analysis_provider or "").strip().lower() == "gemini"
        assert (settings.gemini_api_key or "").strip()
        assert (settings.meeting_service_base_url or "").strip()
        assert (settings.internal_service_token or "").strip()
        assert (
            settings.celery_study_generation_queue or ""
        ).strip() == "study_generation"

        import app.celery_app as celery_module
        import app.tasks as tasks_module

        celery_module = importlib.reload(celery_module)
        tasks_module = importlib.reload(tasks_module)
        assert "app.tasks.generate_subject_synthesis" in celery_module.celery_app.tasks
        assert "app.tasks.generate_study_artifact" in celery_module.celery_app.tasks
        assert "app.tasks.reconcile_study_generation" in celery_module.celery_app.tasks

    if component == "beat":
        import app.celery_app as celery_module

        celery_module = importlib.reload(celery_module)
        beat_schedule = celery_module.celery_app.conf.beat_schedule or {}
        assert "study-generation-reconcile" in beat_schedule

    get_settings.cache_clear()
