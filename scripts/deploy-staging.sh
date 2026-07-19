#!/usr/bin/env bash
# Fail-closed staging deploy orchestrator. Never logs secret values.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OVERLAY="${K8S_OVERLAY:-${ROOT}/k8s/overlays/staging}"
NS="${K8S_NAMESPACE:-audiomind-staging}"
EXPECTED_CONTEXT="${K8S_CONTEXT:-}"
RENDERED="${ROOT}/rendered-staging.yaml"
MIGRATION_TIMEOUT="${MIGRATION_TIMEOUT:-900s}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-600s}"

APP_SECRET_KEYS=(JWT_SECRET INTERNAL_SERVICE_TOKEN GEMINI_API_KEY HUGGINGFACE_TOKEN)
DB_SECRET_KEYS=(MEETING_DATABASE_URL USER_DATABASE_URL AI_DATABASE_URL DB_USERNAME DB_PASSWORD)
CORE_DEPLOYMENTS=(
  user-api-deployment
  meeting-api-deployment
  processing-api-deployment
  ai-api-deployment
  frontend-deployment
  celery-worker-deployment
  celery-beat-deployment
)

MANAGED_DB_STATUS="SKIPPED"
PHASE2_STATUS="SKIPPED"
GEMINI_STATUS="SKIPPED"

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

note() {
  printf '%s\n' "$1"
}

resolve_sealed_file() {
  local base="$1"
  local candidates=(
    "${OVERLAY}/${base}.generated.yaml"
    "${OVERLAY}/${base}.yaml"
  )
  local path
  for path in "${candidates[@]}"; do
    if [[ -f "${path}" ]]; then
      printf '%s' "${path}"
      return 0
    fi
  done
  return 1
}

ensure_namespace() {
  note "  ensuring namespace ${NS}"
  if kubectl get namespace "${NS}" >/dev/null 2>&1; then
    note "  namespace ${NS} exists"
    return 0
  fi
  kubectl create namespace "${NS}"
  note "  created namespace ${NS}"
}

verify_git_clean() {
  note "Step 1/17: verify git tree clean"
  if [[ "${SKIP_GIT_CLEAN_CHECK:-false}" == "true" || "${ALLOW_DIRTY_GIT:-false}" == "true" ]]; then
    note "  skipping git clean check (CI)"
    return
  fi
  cd "${ROOT}"
  local status
  status="$(git status --porcelain)"
  if [[ -z "${status}" ]]; then
    note "  git tree clean"
    return
  fi
  local filtered
  filtered="$(printf '%s\n' "${status}" | grep -Ev '^\?\? rendered-.*\.yaml$' || true)"
  if [[ -n "${filtered}" ]]; then
    printf '%s\n' "${filtered}" >&2
    fail "git tree not clean (untracked rendered-*.yaml ignored)"
  fi
  note "  clean aside from ignored rendered-*.yaml"
}

verify_kubectl_context() {
  note "Step 2/17: verify kubectl context/namespace"
  command -v kubectl >/dev/null 2>&1 || fail "kubectl not found"
  local ctx
  ctx="$(kubectl config current-context 2>/dev/null || true)"
  [[ -n "${ctx}" ]] || fail "no kubectl current-context"
  if [[ -n "${EXPECTED_CONTEXT}" && "${ctx}" != "${EXPECTED_CONTEXT}" ]]; then
    fail "kubectl context '${ctx}' != expected '${EXPECTED_CONTEXT}'"
  fi
  note "  context=${ctx}"
}

verify_sealed_secrets() {
  note "Step 3/17: verify SealedSecret ciphertext files"
  APP_SEALED="$(resolve_sealed_file sealed-secret)" || fail "missing sealed-secret.generated.yaml or sealed-secret.yaml"
  DB_SEALED="$(resolve_sealed_file sealed-db-secret)" || fail "missing sealed-db-secret.generated.yaml or sealed-db-secret.yaml"
  for file in "${APP_SEALED}" "${DB_SEALED}"; do
    if grep -q 'REPLACE_WITH_SEALED' "${file}"; then
      fail "${file} contains REPLACE_WITH_SEALED placeholder"
    fi
  done
  note "  app=${APP_SEALED}"
  note "  db=${DB_SEALED}"
}

render_overlay() {
  note "Step 4/17: render staging overlay"
  command -v kubectl >/dev/null 2>&1 || fail "kubectl not found"
  kubectl kustomize "${OVERLAY}" >"${RENDERED}.base"
  cat "${RENDERED}.base" "${APP_SEALED}" "${DB_SEALED}" >"${RENDERED}"
  rm -f "${RENDERED}.base"
  note "  wrote ${RENDERED}"
}

validate_rendered() {
  note "Step 5/17: validate rendered manifest (deploy-ready)"
  python "${ROOT}/scripts/validate-rendered-k8s.py" \
    "${RENDERED}" --environment staging --deploy-ready
}

kubeconform_validate() {
  note "Step 6/17: kubeconform (optional)"
  if ! command -v kubeconform >/dev/null 2>&1; then
    note "  kubeconform not installed; skipping"
    return 0
  fi
  kubeconform -strict -summary -ignore-missing-schemas "${RENDERED}"
}

apply_namespace_and_secrets() {
  note "Step 7/17: apply namespace/config/secrets"
  ensure_namespace
  kubectl apply -f "${APP_SEALED}" -n "${NS}"
  kubectl apply -f "${DB_SEALED}" -n "${NS}"
  if [[ -f "${OVERLAY}/configmap-patch.yaml" ]]; then
    kubectl apply -f "${OVERLAY}/configmap-patch.yaml" -n "${NS}" || true
  fi
}

wait_for_secrets() {
  note "Step 8/17: wait for Secrets from SealedSecrets"
  local deadline=$(( $(date +%s) + 120 ))
  while true; do
    local app_ok=1 db_ok=1
    kubectl get secret audiomind-secrets -n "${NS}" >/dev/null 2>&1 && app_ok=0
    kubectl get secret audiomind-db-secrets -n "${NS}" >/dev/null 2>&1 && db_ok=0
    if [[ ${app_ok} -eq 0 && ${db_ok} -eq 0 ]]; then
      note "  audiomind-secrets + audiomind-db-secrets present"
      return 0
    fi
    if [[ $(date +%s) -ge ${deadline} ]]; then
      fail "timed out waiting for Secrets in ${NS}"
    fi
    sleep 3
  done
}

validate_secret_keys() {
  note "Step 9/17: validate Secret keys (values not printed)"
  local key
  for key in "${APP_SECRET_KEYS[@]}"; do
    kubectl get secret audiomind-secrets -n "${NS}" -o "jsonpath={.data.${key}}" | grep -q . \
      || fail "audiomind-secrets missing key ${key}"
  done
  for key in "${DB_SECRET_KEYS[@]}"; do
    kubectl get secret audiomind-db-secrets -n "${NS}" -o "jsonpath={.data.${key}}" | grep -q . \
      || fail "audiomind-db-secrets missing key ${key}"
  done
  note "  required keys present"
}

run_migration_job() {
  local job="$1"
  note "  migration job ${job}"
  kubectl delete job "${job}" -n "${NS}" --ignore-not-found=true >/dev/null 2>&1 || true
  local manifest
  manifest="$(python - "${job}" "${NS}" "${ROOT}" <<'PY'
import os
import sys
from pathlib import Path
import yaml

job_name, namespace, root = sys.argv[1], sys.argv[2], Path(sys.argv[3])
jobs_file = root / "k8s/jobs/db-migrate-jobs.yaml"
docs = list(yaml.safe_load_all(jobs_file.read_text(encoding="utf-8")))
selected = None
for doc in docs:
    if doc and doc.get("kind") == "Job" and doc.get("metadata", {}).get("name") == job_name:
        selected = doc
        break
if not selected:
    raise SystemExit(f"job {job_name} not found in {jobs_file}")

image_overrides = {
    "user-db-migrate": os.environ.get("IMAGE_USER_MIGRATE") or os.environ.get("IMAGE_USER_API"),
    "meeting-db-migrate": os.environ.get("IMAGE_MEETING_MIGRATE") or os.environ.get("IMAGE_MEETING_API"),
    "ai-db-migrate": os.environ.get("IMAGE_AI_MIGRATE") or os.environ.get("IMAGE_AI_API"),
}
override = image_overrides.get(job_name)
if override:
    for container in selected.get("spec", {}).get("template", {}).get("spec", {}).get("containers", []):
        container["image"] = override

selected.setdefault("metadata", {})["namespace"] = namespace
out = root / f".deploy-migrate-{job_name}.yaml"
out.write_text(yaml.safe_dump(selected, sort_keys=False), encoding="utf-8")
print(out)
PY
)"
  kubectl apply -f "${manifest}" -n "${NS}" >/dev/null
  rm -f "${manifest}"
  if ! kubectl wait --for=condition=complete "job/${job}" -n "${NS}" --timeout="${MIGRATION_TIMEOUT}"; then
    note "  ${job} failed — collecting logs"
    kubectl logs "job/${job}" -n "${NS}" --all-containers 2>&1 | sed 's/\(password=\)[^ ]*/\1***/Ig' || true
    note "  DB migrations are NOT auto-rolled back. Fix schema/DSN and re-run this job."
    fail "${job} did not complete"
  fi
  note "  ${job} complete"
}

run_migrations() {
  note "Step 10/17: user-db-migrate"
  run_migration_job user-db-migrate
  note "Step 11/17: meeting-db-migrate"
  run_migration_job meeting-db-migrate
  note "Step 12/17: ai-db-migrate"
  run_migration_job ai-db-migrate
}

patch_deployment_image() {
  local deployment="$1"
  local container="$2"
  local env_name="$3"
  local image="${!env_name:-}"
  if [[ -z "${image}" ]]; then
    return 0
  fi
  if ! kubectl get deployment "${deployment}" -n "${NS}" >/dev/null 2>&1; then
    note "  skip image override: deployment/${deployment} not found"
    return 0
  fi
  kubectl set image "deployment/${deployment}" "${container}=${image}" -n "${NS}" >/dev/null
  note "  patched ${deployment}/${container} from ${env_name}"
}

apply_workloads() {
  note "Step 13/17: apply deployments/services (post-migration, excluding Jobs)"
  kubectl delete job user-db-migrate meeting-db-migrate ai-db-migrate -n "${NS}" --ignore-not-found=true >/dev/null 2>&1 || true
  local workloads
  workloads="$(python - "${RENDERED}" "${NS}" <<'PY'
import sys
from pathlib import Path
import yaml

rendered = Path(sys.argv[1])
namespace = sys.argv[2]
skip_kinds = {"Job", "SealedSecret"}
docs = []
for doc in yaml.safe_load_all(rendered.read_text(encoding="utf-8")):
    if not doc:
        continue
    if doc.get("kind") in skip_kinds:
        continue
    meta = doc.setdefault("metadata", {})
    if meta.get("namespace") in (None, "audiomind", "audiomind-staging"):
        meta["namespace"] = namespace
    docs.append(doc)
out = rendered.parent / ".deploy-workloads.yaml"
with out.open("w", encoding="utf-8") as handle:
    yaml.safe_dump_all(docs, handle, sort_keys=False)
print(out)
PY
)"
  kubectl apply -f "${workloads}" -n "${NS}"
  rm -f "${workloads}"
  kubectl apply -f "${APP_SEALED}" -f "${DB_SEALED}" -n "${NS}" >/dev/null

  patch_deployment_image user-api-deployment user-api IMAGE_USER_API
  patch_deployment_image meeting-api-deployment meeting-api IMAGE_MEETING_API
  patch_deployment_image processing-api-deployment processing-api IMAGE_PROCESSING_API
  patch_deployment_image ai-api-deployment ai-api IMAGE_AI_API
  patch_deployment_image frontend-deployment frontend IMAGE_FRONTEND
  patch_deployment_image celery-worker-deployment celery-worker IMAGE_CELERY_WORKER
  patch_deployment_image celery-beat-deployment celery-beat IMAGE_CELERY_BEAT
}

wait_rollouts() {
  note "Step 14/17: wait for rollout status"
  local dep
  for dep in "${CORE_DEPLOYMENTS[@]}"; do
    if ! kubectl get deployment "${dep}" -n "${NS}" >/dev/null 2>&1; then
      note "  skip rollout: deployment/${dep} not present"
      continue
    fi
    if ! kubectl rollout status "deployment/${dep}" -n "${NS}" --timeout="${ROLLOUT_TIMEOUT}"; then
      note "  rollout failed for ${dep}"
      note "  App rollback guidance: kubectl rollout undo deployment/${dep} -n ${NS}"
      note "  Or pin previous image: kubectl set image deployment/${dep} <container>=<image:tag> -n ${NS}"
      fail "rollout failed for ${dep}"
    fi
  done
}

health_checks() {
  note "Step 15/17: health checks (/ready)"
  K8S_NAMESPACE="${NS}" bash "${ROOT}/scripts/ci/verify-ready-staging.sh"
}

run_optional_smokes() {
  note "Step 16/17: optional smoke tests"
  if [[ "${RUN_MANAGED_DB_SMOKE:-false}" == "true" ]]; then
    if python "${ROOT}/scripts/smoke-managed-db.py"; then
      MANAGED_DB_STATUS="PASS"
    else
      MANAGED_DB_STATUS="FAIL"
      fail "smoke-managed-db.py failed"
    fi
  fi
  if [[ "${RUN_PHASE2_SMOKE:-false}" == "true" ]]; then
    if python "${ROOT}/scripts/smoke-phase2-staging.py"; then
      PHASE2_STATUS="PASS"
    else
      PHASE2_STATUS="FAIL"
      fail "smoke-phase2-staging.py failed"
    fi
  fi
  if [[ "${RUN_REAL_GEMINI_SMOKE:-false}" == "true" ]]; then
    if python "${ROOT}/scripts/smoke-real-gemini.py"; then
      GEMINI_STATUS="PASS"
    else
      GEMINI_STATUS="FAIL"
      fail "smoke-real-gemini.py failed"
    fi
  fi
  if [[ "${MANAGED_DB_STATUS}" == "SKIPPED" && "${PHASE2_STATUS}" == "SKIPPED" && "${GEMINI_STATUS}" == "SKIPPED" ]]; then
    note "  skipped (set RUN_MANAGED_DB_SMOKE/RUN_PHASE2_SMOKE/RUN_REAL_GEMINI_SMOKE=true to enable)"
  fi
}

print_verdict() {
  note "Step 17/17: verdict"
  note "STAGING MANIFESTS APPLIED: YES"
  note "STAGING WORKLOADS HEALTHY: YES"
  case "${MANAGED_DB_STATUS}" in
    PASS) note "STAGING MANAGED DATABASE VERIFIED: YES" ;;
    FAIL) note "STAGING MANAGED DATABASE VERIFIED: NO" ;;
    *) note "STAGING MANAGED DATABASE VERIFIED: SKIPPED" ;;
  esac
  case "${PHASE2_STATUS}" in
    PASS) note "STAGING PHASE2 VERIFIED: YES" ;;
    FAIL) note "STAGING PHASE2 VERIFIED: NO" ;;
    *) note "STAGING PHASE2 VERIFIED: SKIPPED" ;;
  esac
  case "${GEMINI_STATUS}" in
    PASS) note "STAGING GEMINI VERIFIED: YES" ;;
    FAIL) note "STAGING GEMINI VERIFIED: NO" ;;
    *) note "STAGING GEMINI VERIFIED: SKIPPED" ;;
  esac
  if [[ "${RUN_MANAGED_DB_SMOKE:-false}" == "true" && "${RUN_PHASE2_SMOKE:-false}" == "true" \
        && "${MANAGED_DB_STATUS}" == "PASS" && "${PHASE2_STATUS}" == "PASS" ]]; then
    note "Ready to deploy staging: YES"
  else
    note "STAGING INFRA HEALTHY"
    note "Ready to deploy staging: NO"
  fi
}

verify_git_clean
verify_kubectl_context
verify_sealed_secrets
render_overlay
validate_rendered
kubeconform_validate
apply_namespace_and_secrets
wait_for_secrets
validate_secret_keys
run_migrations
apply_workloads
wait_rollouts
health_checks
run_optional_smokes
print_verdict
