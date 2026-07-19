#!/usr/bin/env bash
# Single-domain VPS Docker Compose deploy orchestrator. Never logs secret values.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/docker-compose.vps.yml}"
COMPOSE=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

note() {
  printf '[deploy-vps] %s\n' "$1"
}

fail() {
  printf '[deploy-vps] ERROR: %s\n' "$1" >&2
  dump_failure_diagnostics
  exit 1
}

dump_failure_diagnostics() {
  note '--- docker compose ps ---'
  "${COMPOSE[@]}" ps 2>&1 || true
  note '--- recent logs (tail=200, secrets redacted by services) ---'
  "${COMPOSE[@]}" logs --tail=200 2>&1 \
    | sed -E 's/(password|secret|token|api[_-]?key)[[:space:]]*[:=][[:space:]]*[^[:space:]"'\''`]+/\1=[REDACTED]/Ig' \
    || true
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 not found"
}

require_env_file() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    fail "missing ${ENV_FILE}; copy .env.production.example and fill secrets"
  fi
}

require_compose_file() {
  if [[ ! -f "${COMPOSE_FILE}" ]]; then
    fail "missing ${COMPOSE_FILE}"
  fi
}

load_env() {
  # shellcheck disable=SC1090
  set -a
  source "${ENV_FILE}"
  set +a
}

validate_required_vars() {
  local missing=()

  [[ -n "${POSTGRES_PASSWORD:-}" && "${POSTGRES_PASSWORD}" != CHANGE_ME* ]] || missing+=('POSTGRES_PASSWORD')
  [[ -n "${JWT_SECRET:-}" && "${#JWT_SECRET}" -ge 32 && "${JWT_SECRET}" != CHANGE_ME* ]] || missing+=('JWT_SECRET (>=32 chars)')

  local internal_token="${INTERNAL_SERVICE_TOKEN:-${GOOGLE_INTERNAL_SERVICE_TOKEN:-}}"
  [[ -n "${internal_token}" && "${internal_token}" != CHANGE_ME* ]] || missing+=('INTERNAL_SERVICE_TOKEN or GOOGLE_INTERNAL_SERVICE_TOKEN')

  [[ -n "${GEMINI_API_KEY:-}" && "${GEMINI_API_KEY}" != CHANGE_ME* ]] || missing+=('GEMINI_API_KEY')
  [[ -n "${DEEPGRAM_API_KEY:-}" && "${DEEPGRAM_API_KEY}" != CHANGE_ME* ]] || missing+=('DEEPGRAM_API_KEY')

  local public_origin="${PUBLIC_ORIGIN:-${PUBLIC_FRONTEND_ORIGIN:-}}"
  [[ -n "${public_origin}" && "${public_origin}" != https://your-domain.com ]] || missing+=('PUBLIC_ORIGIN or PUBLIC_FRONTEND_ORIGIN')

  [[ -n "${CORS_ALLOWED_ORIGINS:-}" && "${CORS_ALLOWED_ORIGINS}" != https://your-domain.com ]] || missing+=('CORS_ALLOWED_ORIGINS')

  if ((${#missing[@]} > 0)); then
    fail "invalid or placeholder env vars: ${missing[*]}"
  fi
}

service_exists() {
  local name="$1"
  "${COMPOSE[@]}" config --services 2>/dev/null | grep -Fxq "${name}"
}

resolve_postgres_service() {
  if service_exists postgres; then printf '%s' postgres; return; fi
  if service_exists db; then printf '%s' db; return; fi
  fail 'compose file has no postgres or db service'
}

resolve_frontend_service() {
  if service_exists frontend; then printf '%s' frontend; return; fi
  if service_exists web; then printf '%s' web; return; fi
  fail 'compose file has no frontend or web service'
}

wait_for_service_health() {
  local service="$1"
  local deadline=$(( $(date +%s) + ${SERVICE_WAIT_SECONDS:-300} ))
  note "waiting for ${service} health"

  while true; do
    local cid status
    cid="$("${COMPOSE[@]}" ps -q "${service}" 2>/dev/null || true)"
    if [[ -n "${cid}" ]]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${cid}" 2>/dev/null || true)"
      if [[ "${status}" == "healthy" || "${status}" == "running" ]]; then
        note "${service} is ${status}"
        return 0
      fi
    fi
    if (( $(date +%s) >= deadline )); then
      fail "timed out waiting for ${service}"
    fi
    sleep 3
  done
}

curl_loopback() {
  local url="$1"
  local label="$2"
  local deadline=$(( $(date +%s) + ${LOOPBACK_WAIT_SECONDS:-180} ))

  while true; do
    if curl -fsS --max-time 5 "${url}" >/dev/null 2>&1; then
      note "${label} OK (${url})"
      return 0
    fi
    if (( $(date +%s) >= deadline )); then
      fail "${label} not reachable at ${url}"
    fi
    sleep 3
  done
}

wait_for_loopback_health() {
  local frontend_port="${FRONTEND_HOST_PORT:-${WEB_HOST_PORT:-8080}}"
  local user_port="${USER_API_HOST_PORT:-8083}"
  local meeting_port="${MEETING_API_HOST_PORT:-8081}"
  local processing_port="${PROCESSING_API_HOST_PORT:-8082}"
  local ai_port="${AI_API_HOST_PORT:-8000}"

  curl_loopback "http://127.0.0.1:${frontend_port}/" "frontend"
  curl_any_of "user-api" \
    "http://127.0.0.1:${user_port}/actuator/health/readiness" \
    "http://127.0.0.1:${user_port}/ready"
  curl_any_of "meeting-api" \
    "http://127.0.0.1:${meeting_port}/actuator/health/readiness" \
    "http://127.0.0.1:${meeting_port}/ready"
  curl_loopback "http://127.0.0.1:${processing_port}/ready" "processing-api"
  curl_loopback "http://127.0.0.1:${ai_port}/ready" "ai-api"
}

curl_any_of() {
  local label="$1"
  shift
  local deadline=$(( $(date +%s) + ${LOOPBACK_WAIT_SECONDS:-180} ))
  while true; do
    local url
    for url in "$@"; do
      if curl -fsS --max-time 5 "${url}" >/dev/null 2>&1; then
        note "${label} OK (${url})"
        return 0
      fi
    done
    if (( $(date +%s) >= deadline )); then
      fail "${label} not reachable (tried: $*)"
    fi
    sleep 3
  done
}

main() {
  note 'Step 1/10: verify docker and compose'
  require_command docker
  docker compose version >/dev/null 2>&1 || fail 'docker compose plugin not found'

  note 'Step 2/10: verify env and compose files'
  require_env_file
  require_compose_file
  load_env
  validate_required_vars

  local postgres_service frontend_service
  postgres_service="$(resolve_postgres_service)"
  frontend_service="$(resolve_frontend_service)"

  if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    note 'Step 3/10: compose build (apps + migrate profile)'
    "${COMPOSE[@]}" --profile migrate build
  else
    note 'Step 3/10: SKIP_BUILD=1 (skipping build)'
  fi

  note "Step 4/10: start ${postgres_service} and redis"
  "${COMPOSE[@]}" up -d "${postgres_service}" redis
  wait_for_service_health "${postgres_service}"
  wait_for_service_health redis

  note 'Step 5/10: run migrations'
  ENV_FILE="${ENV_FILE}" COMPOSE_FILE="${COMPOSE_FILE}" ./scripts/vps-migrate.sh

  note 'Step 6/10: start application stack'
  "${COMPOSE[@]}" up -d --build \
    user-api meeting-api processing-api ai-api celery-worker celery-beat "${frontend_service}"

  note 'Step 7/10: wait for container health'
  for svc in user-api meeting-api processing-api ai-api celery-worker celery-beat "${frontend_service}"; do
    if service_exists "${svc}"; then
      wait_for_service_health "${svc}"
    fi
  done

  note 'Step 8/10: loopback HTTP checks'
  wait_for_loopback_health

  if [[ "${SKIP_SMOKE:-0}" != "1" ]]; then
    note 'Step 9/10: smoke-vps'
    ENV_FILE="${ENV_FILE}" COMPOSE_FILE="${COMPOSE_FILE}" ./scripts/smoke-vps.sh
  else
    note 'Step 9/10: SKIP_SMOKE=1 (skipping smoke-vps.sh)'
  fi

  note 'Step 10/10: deploy verdict'
  cat <<EOF

VPS DEPLOY VERDICT
------------------
Code/compose: local deploy script completed on this host.
Compose validated: yes (services started; loopback health checks passed).
Local smoke: $([[ "${SKIP_SMOKE:-0}" == "1" ]] && echo skipped || echo passed via smoke-vps.sh).
Real VPS: not verified here — confirm DNS/TLS/Nginx on the public domain separately.

EOF
}

main "$@"
