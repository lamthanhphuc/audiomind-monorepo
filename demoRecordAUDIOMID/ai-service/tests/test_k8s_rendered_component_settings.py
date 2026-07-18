"""Startup Settings checks against kubectl-kustomize rendered overlay manifests.

Resolves Deployment container env (literal / ConfigMap / Secret) from
``kubectl kustomize k8s/overlays/{dev,staging,prod}`` and instantiates
``Settings(_env_file=None)`` the same way each component would at boot.
"""

from __future__ import annotations

import base64
import importlib
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

# Env keys Settings may read; cleared before applying a rendered component env
# so ambient / prior-test values cannot leak into production validators.
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
if not _kubectl:
    pytest.skip(
        "kubectl not found on PATH; skipping K8s rendered component Settings tests",
        allow_module_level=True,
    )


def _kustomize(overlay: str) -> list[dict[str, Any]]:
    result = subprocess.run(
        [
            _kubectl,
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
        raise AssertionError(
            f"kubectl kustomize k8s/overlays/{overlay} failed "
            f"(exit {result.returncode}): {result.stderr or result.stdout}"
        )
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def _index_config_and_secrets(
    docs: list[dict[str, Any]],
) -> tuple[dict[str, str], dict[str, str]]:
    config: dict[str, str] = {}
    secrets: dict[str, str] = {}
    for doc in docs:
        kind = doc.get("kind")
        name = (doc.get("metadata") or {}).get("name")
        if kind == "ConfigMap" and name == "audiomind-config":
            for key, value in (doc.get("data") or {}).items():
                config[str(key)] = "" if value is None else str(value)
        elif kind == "Secret" and name == "audiomind-secrets":
            for key, value in (doc.get("stringData") or {}).items():
                secrets[str(key)] = "" if value is None else str(value)
            for key, value in (doc.get("data") or {}).items():
                if value is None:
                    secrets[str(key)] = ""
                    continue
                raw = str(value)
                try:
                    secrets[str(key)] = base64.b64decode(raw).decode("utf-8")
                except Exception:  # noqa: BLE001 — keep raw if not valid b64
                    secrets[str(key)] = raw
    return config, secrets


def _resolve_container_env(
    container: dict[str, Any],
    config: dict[str, str],
    secrets: dict[str, str],
) -> dict[str, str]:
    resolved: dict[str, str] = {}
    for entry in container.get("env") or []:
        name = entry.get("name")
        if not name:
            continue
        if "value" in entry and entry.get("valueFrom") is None:
            resolved[str(name)] = "" if entry.get("value") is None else str(entry["value"])
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
            key = secret_ref.get("key")
            assert key in secrets, (
                f"env {name}: secretKeyRef key {key!r} missing from "
                f"Secret audiomind-secrets"
            )
            resolved[str(name)] = secrets[str(key)]
            continue
    return resolved


def _find_deployment(docs: list[dict[str, Any]], name: str) -> dict[str, Any]:
    for doc in docs:
        if (
            doc.get("kind") == "Deployment"
            and (doc.get("metadata") or {}).get("name") == name
        ):
            return doc
    raise AssertionError(f"Deployment {name} not found in rendered docs")


def _apply_resolved_env(
    monkeypatch: pytest.MonkeyPatch, resolved: dict[str, str]
) -> None:
    for key in _SETTINGS_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    # Keep ANALYSIS_PROVIDER / AI_PROVIDER in lockstep (Settings fail-fasts on conflict).
    synced = dict(resolved)
    if "ANALYSIS_PROVIDER" in synced and "AI_PROVIDER" not in synced:
        synced["AI_PROVIDER"] = synced["ANALYSIS_PROVIDER"]
    elif "AI_PROVIDER" in synced and "ANALYSIS_PROVIDER" not in synced:
        synced["ANALYSIS_PROVIDER"] = synced["AI_PROVIDER"]
    for key, value in synced.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()


@pytest.fixture(scope="module")
def rendered_overlays() -> dict[str, list[dict[str, Any]]]:
    return {overlay: _kustomize(overlay) for overlay in OVERLAYS}


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
        ):
            assert forbidden not in resolved, (
                f"beat container must not set {forbidden}; got {resolved.get(forbidden)!r}"
            )
        assert deployment["spec"].get("replicas") == 1

    _apply_resolved_env(monkeypatch, resolved)

    settings = Settings(_env_file=None)
    assert settings.app_component == component
    assert (settings.app_env or "").strip().lower() == resolved["APP_ENV"].strip().lower()

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
        assert (settings.celery_study_generation_queue or "").strip() == "study_generation"

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
