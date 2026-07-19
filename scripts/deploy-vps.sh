#!/usr/bin/env bash
# Single-domain VPS Docker Compose deploy orchestrator. Never logs secret values.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/docker-compose.vps.yml}"
COMPOSE=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")
LOAD_ENV_PY="${ROOT}/scripts/load-compose-env.py"
PYTHON_BIN=""

resolve_python() {
  local candidate
  for candidate in python3 python; do
    if command -v "${candidate}" >/dev/null 2>&1 \
      && "${candidate}" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" >/dev/null 2>&1; then
      PYTHON_BIN="$(command -v "${candidate}")"
      return 0
    fi
  done
  return 1
}

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

env_get() {
  local key="$1"
  "${PYTHON_BIN}" "${LOAD_ENV_PY}" --file "${ENV_FILE}" --get "${key}" 2>/dev/null || true
}

validate_required_vars() {
  local missing=()
  local value

  value="$(env_get POSTGRES_PASSWORD)"
  [[ -n "${value}" && "${value}" != CHANGE_ME* ]] || missing+=('POSTGRES_PASSWORD')

  value="$(env_get JWT_SECRET)"
  [[ -n "${value}" && "${#value}" -ge 32 && "${value}" != CHANGE_ME* ]] || missing+=('JWT_SECRET (>=32 chars)')

  value="$(env_get INTERNAL_SERVICE_TOKEN)"
  if [[ -z "${value}" || "${value}" == CHANGE_ME* ]]; then
    value="$(env_get GOOGLE_INTERNAL_SERVICE_TOKEN)"
  fi
  [[ -n "${value}" && "${#value}" -ge 16 && "${value}" != CHANGE_ME* ]] || missing+=('INTERNAL_SERVICE_TOKEN')

  value="$(env_get GEMINI_API_KEY)"
  [[ -n "${value}" && "${value}" != CHANGE_ME* ]] || missing+=('GEMINI_API_KEY')

  value="$(env_get DEEPGRAM_API_KEY)"
  [[ -n "${value}" && "${value}" != CHANGE_ME* ]] || missing+=('DEEPGRAM_API_KEY')

  value="$(env_get AI_DATABASE_URL)"
  if [[ -z "${value}" || "${value}" == CHANGE_ME* ]]; then
    missing+=('AI_DATABASE_URL (postgresql://… URL-encoded password)')
  elif [[ "${value}" != postgresql://* && "${value}" != postgresql+psycopg2://* ]]; then
    missing+=('AI_DATABASE_URL (must start with postgresql://)')
  elif [[ "${value}" != *@*/* ]]; then
    missing+=('AI_DATABASE_URL (malformed host/db)')
  fi

  value="$(env_get PUBLIC_ORIGIN)"
  if [[ -z "${value}" || "${value}" == https://your-domain.com ]]; then
    value="$(env_get PUBLIC_FRONTEND_ORIGIN)"
  fi
  [[ -n "${value}" && "${value}" != https://your-domain.com ]] || missing+=('PUBLIC_ORIGIN')

  value="$(env_get CORS_ALLOWED_ORIGINS)"
  [[ -n "${value}" && "${value}" != https://your-domain.com ]] || missing+=('CORS_ALLOWED_ORIGINS')

  value="$(env_get DEPLOYMENT_MODE)"
  [[ -z "${value}" || "${value}" == "vps" ]] || missing+=('DEPLOYMENT_MODE must be vps for this stack')

  value="$(env_get DATABASE_TLS_MODE)"
  [[ -z "${value}" || "${value}" == "disable" ]] || true

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

wait_for_loopback_health() {
  local frontend_port user_port meeting_port processing_port ai_port
  frontend_port="$(env_get FRONTEND_HOST_PORT)"
  frontend_port="${frontend_port:-$(env_get WEB_HOST_PORT)}"
  frontend_port="${frontend_port:-8080}"
  user_port="$(env_get USER_API_HOST_PORT)"
  user_port="${user_port:-8083}"
  meeting_port="$(env_get MEETING_API_HOST_PORT)"
  meeting_port="${meeting_port:-8081}"
  processing_port="$(env_get PROCESSING_API_HOST_PORT)"
  processing_port="${processing_port:-8082}"
  ai_port="$(env_get AI_API_HOST_PORT)"
  ai_port="${ai_port:-8000}"

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

main() {
  note 'Step 1/10: verify docker and compose'
  require_command docker
  resolve_python || fail 'python3/python >= 3.9 not found'
  docker compose version >/dev/null 2>&1 || fail 'docker compose plugin not found'

  note 'Step 2/10: verify env and compose files'
  require_env_file
  require_compose_file
  [[ -f "${LOAD_ENV_PY}" ]] || fail "missing ${LOAD_ENV_PY}"
  validate_required_vars

  local postgres_service frontend_service
  postgres_service="$(resolve_postgres_service)"
  frontend_service="$(resolve_frontend_service)"

  if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    note 'Step 3/10: compose build once (apps + migrate profile)'
    "${COMPOSE[@]}" --profile migrate build
  else
    note 'Step 3/10: SKIP_BUILD=1 (skipping compose build)'
  fi

  note "Step 4/10: start ${postgres_service} and redis"
  "${COMPOSE[@]}" up -d "${postgres_service}" redis
  wait_for_service_health "${postgres_service}"
  wait_for_service_health redis

  note 'Step 5/10: run migrations'
  ENV_FILE="${ENV_FILE}" COMPOSE_FILE="${COMPOSE_FILE}" ./scripts/vps-migrate.sh

  note 'Step 6/10: start application stack (no --build; images already built or SKIP_BUILD)'
  "${COMPOSE[@]}" up -d \
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
Compose build: $([[ "${SKIP_BUILD:-0}" == "1" ]] && echo skipped || echo once-before-up).
Loopback health: passed.
Local smoke: $([[ "${SKIP_SMOKE:-0}" == "1" ]] && echo skipped || echo passed via smoke-vps.sh).
Real VPS / HTTPS: not verified here — confirm DNS/TLS/Nginx on the public domain separately.

EOF
}

main "$@"
