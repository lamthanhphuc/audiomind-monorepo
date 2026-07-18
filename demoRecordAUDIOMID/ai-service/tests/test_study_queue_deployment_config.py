"""Guardrails ensuring celery workers stay subscribed to the study_generation queue.

These tests inspect the raw deployment/compose manifests as text rather than
fully parsing them as YAML, because several of the compose files rely on
docker-compose-specific YAML extensions (anchors, `!reset` tags, etc.) that a
plain `yaml.safe_load` cannot handle. Regex extraction of the celery worker
invocation is sufficient to catch the regression this suite guards against:
someone removing `-Q audio_processing,study_generation` (or the whole flag)
from a worker command, which would silently stop study artifact generation
from being processed.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]

REQUIRED_QUEUES = ("audio_processing", "study_generation")

# Matches the celery worker invocation (as opposed to `celery ... beat`),
# regardless of surrounding shell quoting/array syntax.
WORKER_COMMAND_RE = re.compile(
    r"celery -A app\.celery_app\.celery_app worker[^\"'\n]*"
)

# Deployment/compose files whose celery-worker `command` must include both
# required queues.
FILES_WITH_WORKER_COMMANDS = (
    REPO_ROOT / "k8s" / "deployments" / "core-deployments.yaml",
    REPO_ROOT / "demoRecordAUDIOMID" / "ai-service" / "docker-compose.yml",
    REPO_ROOT / "infra" / "docker-compose.dev.yml",
    REPO_ROOT / "infra" / "docker-compose.mvp.yml",
)

# Overlay/env-only compose files that patch the celery-worker service but
# must NOT override its `command` (which would drop the queue flags baked
# into the base compose file).
COMPOSE_OVERLAYS_WITHOUT_COMMAND_OVERRIDE = (
    REPO_ROOT / "infra" / "docker-compose.ci.yml",
    REPO_ROOT / "infra" / "docker-compose.staging.yml",
    REPO_ROOT / "infra" / "docker-compose.ci-staging.yml",
    REPO_ROOT / "infra" / "docker-compose.prod.yml",
)

# k8s kustomize overlay patches that touch the celery-worker deployment but
# must not strip the `-Q` flag by re-specifying `command` without it.
K8S_OVERLAY_PATCHES_TOUCHING_CELERY_WORKER = (
    REPO_ROOT / "k8s" / "overlays" / "staging" / "resource-patch.yaml",
    REPO_ROOT / "k8s" / "overlays" / "prod" / "resource-patch.yaml",
    REPO_ROOT / "k8s" / "overlays" / "staging" / "pdb.yaml",
    REPO_ROOT / "k8s" / "overlays" / "prod" / "pdb.yaml",
)


def _extract_worker_commands(text: str) -> list[str]:
    return WORKER_COMMAND_RE.findall(text)


@pytest.mark.parametrize("manifest_path", FILES_WITH_WORKER_COMMANDS, ids=lambda p: str(p.relative_to(REPO_ROOT)))
def test_celery_worker_command_consumes_required_queues(manifest_path: Path) -> None:
    assert manifest_path.is_file(), f"expected deployment manifest at {manifest_path}"
    text = manifest_path.read_text(encoding="utf-8")

    commands = _extract_worker_commands(text)
    assert commands, f"no celery worker command found in {manifest_path}"

    for command in commands:
        for queue in REQUIRED_QUEUES:
            assert queue in command, (
                f"celery worker command in {manifest_path} is missing queue "
                f"'{queue}': {command!r}"
            )
        assert "-Q" in command, (
            f"celery worker command in {manifest_path} does not pass an explicit "
            f"-Q flag: {command!r}"
        )


def test_k8s_core_deployment_sets_study_generation_queue_env() -> None:
    manifest_path = REPO_ROOT / "k8s" / "deployments" / "core-deployments.yaml"
    text = manifest_path.read_text(encoding="utf-8")

    celery_worker_block_match = re.search(
        r"name: celery-worker-deployment[\s\S]*?(?=\n---\n|\Z)", text
    )
    assert celery_worker_block_match, "celery-worker-deployment not found"
    block = celery_worker_block_match.group(0)

    env_var_match = re.search(
        r"- name: CELERY_STUDY_GENERATION_QUEUE\s*\n\s*value:\s*\"?study_generation\"?",
        block,
    )
    assert env_var_match, (
        "celery-worker-deployment must set CELERY_STUDY_GENERATION_QUEUE=study_generation"
    )


@pytest.mark.parametrize(
    "overlay_path",
    COMPOSE_OVERLAYS_WITHOUT_COMMAND_OVERRIDE,
    ids=lambda p: str(p.relative_to(REPO_ROOT)),
)
def test_compose_overlays_do_not_override_worker_command(overlay_path: Path) -> None:
    assert overlay_path.is_file(), f"expected compose overlay at {overlay_path}"
    text = overlay_path.read_text(encoding="utf-8")

    celery_worker_block_match = re.search(
        r"^  celery-worker:\n((?:^ {4}.*\n|^\n)*)", text, re.MULTILINE
    )
    if not celery_worker_block_match:
        return

    block = celery_worker_block_match.group(1)
    assert "command:" not in block, (
        f"{overlay_path} overrides celery-worker `command`; this would drop "
        f"the '-Q audio_processing,study_generation' queue flags unless the "
        f"override itself includes them"
    )


@pytest.mark.parametrize(
    "patch_path",
    K8S_OVERLAY_PATCHES_TOUCHING_CELERY_WORKER,
    ids=lambda p: str(p.relative_to(REPO_ROOT)),
)
def test_k8s_overlay_patches_do_not_override_worker_command(patch_path: Path) -> None:
    assert patch_path.is_file(), f"expected k8s overlay patch at {patch_path}"
    text = patch_path.read_text(encoding="utf-8")

    celery_worker_block_match = re.search(
        r"name: celery-worker-deployment[\s\S]*?(?=\n---\n|\Z)", text
    )
    if not celery_worker_block_match:
        return

    block = celery_worker_block_match.group(0)
    assert "command:" not in block, (
        f"{patch_path} patches celery-worker-deployment with a `command` "
        f"override; this would drop the '-Q audio_processing,study_generation' "
        f"queue flags unless the override itself includes them"
    )
