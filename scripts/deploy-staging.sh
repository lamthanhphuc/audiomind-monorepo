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

APP_SECRET_KEYS=(JWT_SECRET INTERNAL_SERVICE_TOKEN GEMINI_API_KEY)
DB_SECRET_KEYS=(MEETING_DATABASE_URL USER_DATABASE_URL AI_DATABASE_URL DB_USERNAME DB_PASSWORD)
CORE_DEPLOYMENTS=(
  user-api-deployment
  meeting-api-deployment
  processing-api-deployment
  ai-api-deployment
  celery-worker-deployment
  celery-beat-deployment
)

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  VERDICT="NOT READY"
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

verify_git_clean() {
  note "Step 1/17: verify git tree clean"
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
  if ! kubectl get namespace "${NS}" >/dev/null 2>&1; then
    note "  namespace ${NS} will be created during apply"
  else
    note "  namespace ${NS} exists"
  fi
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
  kubectl apply -f "${ROOT}/k8s/base/namespace.yaml" || true
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
selected.setdefault("metadata", {})["namespace"] = namespace
out = root / f".deploy-migrate-{job_name}.yaml"
out.write_text(yaml.safe_dump(selected, sort_keys=False), encoding="utf-8")
print(out)
PY
)"
  kubectl apply -f "${manifest}" -n "${NS}" >/dev/null
  rm -f "${manifest}"
  if ! kubectl wait --for=condition=complete "job/${job}" -n "${NS}" --timeout="${MIGRATION_TIMEOUT}"; then
    note "  ${job} failed — inspect: kubectl logs job/${job} -n ${NS}"
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

apply_workloads() {
  note "Step 13/17: apply deployments/services (full overlay)"
  kubectl apply -k "${OVERLAY}" -n "${NS}"
  kubectl apply -f "${APP_SEALED}" -f "${DB_SEALED}" -n "${NS}" >/dev/null
}

wait_rollouts() {
  note "Step 14/17: wait for rollout status"
  local dep
  for dep in "${CORE_DEPLOYMENTS[@]}"; do
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
  local ran=0
  if [[ "${RUN_MANAGED_DB_SMOKE:-false}" == "true" ]]; then
    python "${ROOT}/scripts/smoke-managed-db.py"
    ran=1
  fi
  if [[ "${RUN_PHASE2_SMOKE:-false}" == "true" ]]; then
    python "${ROOT}/scripts/smoke-phase2-staging.py"
    ran=1
  fi
  if [[ "${RUN_REAL_GEMINI_SMOKE:-false}" == "true" ]]; then
    python "${ROOT}/scripts/smoke-real-gemini.py"
    ran=1
  fi
  if [[ ${ran} -eq 0 ]]; then
    note "  skipped (set RUN_MANAGED_DB_SMOKE/RUN_PHASE2_SMOKE/RUN_REAL_GEMINI_SMOKE=true to enable)"
  fi
}

print_verdict() {
  note "Step 17/17: verdict"
  note "READY TO DEPLOY STAGING"
}

VERDICT="NOT READY"
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
