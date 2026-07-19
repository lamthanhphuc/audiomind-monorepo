#!/usr/bin/env python3
"""Unit tests for scripts/validate-rendered-k8s.py structural gates."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "validate-rendered-k8s.py"


def _load_validator():
    spec = importlib.util.spec_from_file_location("validate_rendered_k8s", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _deployment(name: str, *, image: str = "ghcr.io/org/svc:sha-abc", env=None) -> dict:
    return {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {"name": name, "namespace": "audiomind-staging"},
        "spec": {
            "replicas": 1,
            "selector": {"matchLabels": {"app": name}},
            "template": {
                "metadata": {"labels": {"app": name}},
                "spec": {
                    "containers": [
                        {
                            "name": name.replace("-deployment", ""),
                            "image": image,
                            "ports": [{"containerPort": 8080}],
                            "env": env or [],
                        }
                    ]
                },
            },
        },
    }


def _configmap(data: dict[str, str]) -> dict:
    return {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": "audiomind-config", "namespace": "audiomind-staging"},
        "data": data,
    }


def _stt_env() -> list[dict]:
    return [
        {
            "name": "STT_PROVIDER",
            "valueFrom": {
                "configMapKeyRef": {"name": "audiomind-config", "key": "STT_PROVIDER"}
            },
        }
    ]


def _base_staging_docs(*extra) -> list[dict]:
    return [
        _configmap(
            {
                "STT_PROVIDER": "local_whisper",
                "ENABLE_SPEAKER_DIARIZATION": "false",
            }
        ),
        _deployment("ai-api-deployment", env=_stt_env()),
        _deployment("celery-worker-deployment", env=_stt_env()),
        *extra,
    ]


def test_staging_requires_frontend_deployment():
    validator = _load_validator()
    assert (
        validator.validate_docs(_base_staging_docs(), "staging-test", "staging", code_only=True)
        is False
    )


def test_deploy_ready_rejects_placeholder_image_tags():
    validator = _load_validator()
    docs = _base_staging_docs(
        _deployment("frontend-deployment", image="audiomind/web:0.1.0"),
        _deployment("ai-api-deployment", image="audiomind/ai-api:0.1.0", env=_stt_env()),
    )
    assert (
        validator.validate_docs(
            docs,
            "staging-test",
            "staging",
            deploy_ready=True,
            code_only=True,
        )
        is False
    )


def test_staging_namespace_must_be_consistent():
    validator = _load_validator()
    docs = _base_staging_docs(
        _deployment("frontend-deployment"),
        {
            "apiVersion": "v1",
            "kind": "Service",
            "metadata": {"name": "bad-ns", "namespace": "audiomind"},
        },
    )
    assert validator.validate_docs(docs, "staging-test", "staging", code_only=True) is False


def test_missing_stt_provider_env_fails():
    validator = _load_validator()
    docs = _base_staging_docs(
        _deployment("frontend-deployment"),
        _deployment("ai-api-deployment"),
    )
    assert validator.validate_docs(docs, "staging-test", "staging", code_only=True) is False
