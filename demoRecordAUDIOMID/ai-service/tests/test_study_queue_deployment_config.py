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


def test_k8s_core_deployment_has_celery_beat_deployment() -> None:
    manifest_path = REPO_ROOT / "k8s" / "deployments" / "core-deployments.yaml"
    text = manifest_path.read_text(encoding="utf-8")

    assert "name: celery-beat-deployment" in text, (
        "k8s/deployments/core-deployments.yaml must define a "
        "celery-beat-deployment so the periodic study-generation-reconcile "
        "schedule (and other beat_schedule entries) actually gets dispatched"
    )

    beat_block_match = re.search(
        r"name: celery-beat-deployment[\s\S]*?(?=\n---\n|\Z)", text
    )
    assert beat_block_match, "celery-beat-deployment block not found"
    block = beat_block_match.group(0)

    beat_command_match = re.search(
        r"celery -A app\.celery_app\.celery_app beat[^\"'\n]*", block
    )
    assert beat_command_match, (
        "celery-beat-deployment command must invoke "
        "'celery -A app.celery_app.celery_app beat'"
    )

    assert "replicas: 1" in block, (
        "celery-beat-deployment must run exactly one replica; running more "
        "than one beat instance causes duplicate periodic task dispatch"
    )

    # Beat must not be given the worker's `-Q` queue subscription flags.
    assert "-Q" not in beat_command_match.group(0), (
        "celery-beat-deployment command should not pass worker `-Q` queue "
        "flags; beat only schedules tasks, it does not consume queues"
    )


def test_compose_files_define_celery_beat_service() -> None:
    """Beat must exist in every environment that runs study reconciliation."""
    compose_paths = (
        REPO_ROOT / "infra" / "docker-compose.dev.yml",
        REPO_ROOT / "infra" / "docker-compose.mvp.yml",
        REPO_ROOT / "demoRecordAUDIOMID" / "ai-service" / "docker-compose.yml",
    )
    for path in compose_paths:
        assert path.is_file(), f"missing compose file {path}"
        text = path.read_text(encoding="utf-8")
        assert re.search(r"(celery-beat|^\s+beat:)", text, re.MULTILINE), (
            f"{path} must define a celery beat service so "
            "study-generation-reconcile is scheduled"
        )
        assert "celery -A app.celery_app.celery_app beat" in text, (
            f"{path} beat service must invoke celery beat"
        )


def test_celery_app_registers_reconcile_task() -> None:
    from app.celery_app import celery_app
    from app.tasks import reconcile_study_generation

    assert reconcile_study_generation.name == "app.tasks.reconcile_study_generation"
    # Task is bound into the app registry used by workers/beat.
    assert "app.tasks.reconcile_study_generation" in celery_app.tasks
    assert "study-generation-reconcile" in celery_app.conf.beat_schedule


PHASE2_CORE_DEPLOYMENTS = (
    "meeting-api",
    "processing-api",
    "user-api",
    "ai-api",
    "celery-worker",
    "celery-beat",
)

PHASE2_SERVICE_URL_ENV_NAMES = (
    "AUDIOMIND_USER_API_BASE_URL",
    "AUDIOMIND_AI_API_BASE_URL",
    "AUDIOMIND_MEETING_API_BASE_URL",
    "MEETING_SERVICE_BASE_URL",
)


def _core_deployments_text() -> str:
    manifest_path = REPO_ROOT / "k8s" / "deployments" / "core-deployments.yaml"
    assert manifest_path.is_file(), f"expected {manifest_path}"
    return manifest_path.read_text(encoding="utf-8")


def _deployment_block(text: str, short_name: str) -> str:
    """Extract one Deployment document by metadata.name `<short>-deployment`."""
    deployment_name = f"{short_name}-deployment"
    match = re.search(
        rf"name: {re.escape(deployment_name)}[\s\S]*?(?=\n---\n|\Z)",
        text,
    )
    assert match, f"{deployment_name} block not found in core-deployments.yaml"
    return match.group(0)


def _env_value(block: str, name: str) -> str | None:
    """Return literal `value:` for an env var, or None if only valueFrom / missing."""
    match = re.search(
        rf"- name: {re.escape(name)}\s*\n\s*value:\s*(.+?)(?:\n|$)",
        block,
    )
    if not match:
        return None
    return match.group(1).strip().strip('"').strip("'")


def _has_secret_key_ref(block: str, env_name: str, secret_name: str, key: str) -> bool:
    pattern = re.compile(
        rf"- name: {re.escape(env_name)}\s*\n"
        rf"\s*valueFrom:\s*\n"
        rf"\s*secretKeyRef:\s*\n"
        rf"\s*name:\s*{re.escape(secret_name)}\s*\n"
        rf"\s*key:\s*{re.escape(key)}",
        re.MULTILINE,
    )
    return bool(pattern.search(block))


def _has_configmap_key_ref(block: str, env_name: str) -> bool:
    pattern = re.compile(
        rf"- name: {re.escape(env_name)}\s*\n"
        rf"\s*valueFrom:\s*\n"
        rf"\s*configMapKeyRef:",
        re.MULTILINE,
    )
    return bool(pattern.search(block))


def _compose_service_block(text: str, service_name: str) -> str:
    match = re.search(
        rf"^  {re.escape(service_name)}:\n((?:^ {{4}}.*\n|^\n)*)",
        text,
        re.MULTILINE,
    )
    assert match, f"service '{service_name}' not found in compose file"
    return match.group(0)


@pytest.mark.parametrize("short_name", PHASE2_CORE_DEPLOYMENTS)
def test_k8s_core_deployments_wire_internal_service_token(short_name: str) -> None:
    text = _core_deployments_text()
    block = _deployment_block(text, short_name)
    assert _has_secret_key_ref(
        block, "INTERNAL_SERVICE_TOKEN", "audiomind-secrets", "INTERNAL_SERVICE_TOKEN"
    ), (
        f"{short_name}-deployment must set INTERNAL_SERVICE_TOKEN via "
        "secretKeyRef to audiomind-secrets"
    )


def test_k8s_processing_api_service_urls() -> None:
    block = _deployment_block(_core_deployments_text(), "processing-api")
    user_url = _env_value(block, "AUDIOMIND_USER_API_BASE_URL")
    assert user_url == "http://user-api:8083", (
        f"processing-api AUDIOMIND_USER_API_BASE_URL must be "
        f"http://user-api:8083, got {user_url!r}"
    )
    assert "localhost" not in (user_url or "").lower()
    assert (
        _has_configmap_key_ref(block, "AUDIOMIND_AI_API_BASE_URL")
        or _env_value(block, "AUDIOMIND_AI_API_BASE_URL")
    ), "processing-api must define AUDIOMIND_AI_API_BASE_URL (configMap or value)"


@pytest.mark.parametrize("short_name", ("ai-api", "celery-worker", "celery-beat"))
def test_k8s_ai_celery_deployments_production_meeting_env(short_name: str) -> None:
    block = _deployment_block(_core_deployments_text(), short_name)
    assert _env_value(block, "APP_ENV") == "production", (
        f"{short_name} must set APP_ENV=production"
    )
    meeting_url = _env_value(block, "MEETING_SERVICE_BASE_URL")
    assert meeting_url == "http://meeting-api:8081", (
        f"{short_name} MEETING_SERVICE_BASE_URL must be "
        f"http://meeting-api:8081, got {meeting_url!r}"
    )
    assert "localhost" not in (meeting_url or "").lower()
    assert _has_secret_key_ref(
        block, "INTERNAL_SERVICE_TOKEN", "audiomind-secrets", "INTERNAL_SERVICE_TOKEN"
    )


def test_k8s_phase2_service_urls_have_no_localhost() -> None:
    text = _core_deployments_text()
    for short_name in PHASE2_CORE_DEPLOYMENTS:
        block = _deployment_block(text, short_name)
        for env_name in PHASE2_SERVICE_URL_ENV_NAMES:
            value = _env_value(block, env_name)
            if value is None:
                continue
            assert "localhost" not in value.lower(), (
                f"{short_name} {env_name}={value!r} must not use localhost"
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


COMPOSE_PHASE2_SERVICES = ("ai-api", "celery-worker", "celery-beat")
COMPOSE_FILES_WITH_MEETING_TOKEN = (
    REPO_ROOT / "infra" / "docker-compose.dev.yml",
    REPO_ROOT / "infra" / "docker-compose.mvp.yml",
)


@pytest.mark.parametrize(
    "compose_path",
    COMPOSE_FILES_WITH_MEETING_TOKEN,
    ids=lambda p: str(p.relative_to(REPO_ROOT)),
)
@pytest.mark.parametrize("service_name", COMPOSE_PHASE2_SERVICES)
def test_compose_ai_celery_include_meeting_url_and_internal_token(
    compose_path: Path, service_name: str
) -> None:
    assert compose_path.is_file(), f"expected compose file at {compose_path}"
    text = compose_path.read_text(encoding="utf-8")
    block = _compose_service_block(text, service_name)
    assert "MEETING_SERVICE_BASE_URL" in block, (
        f"{compose_path.name} service '{service_name}' must set MEETING_SERVICE_BASE_URL"
    )
    assert "INTERNAL_SERVICE_TOKEN" in block, (
        f"{compose_path.name} service '{service_name}' must set INTERNAL_SERVICE_TOKEN"
    )
