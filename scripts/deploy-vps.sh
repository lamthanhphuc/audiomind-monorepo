#!/usr/bin/env bash
# Single-domain VPS deploy orchestrator for the layered Docker Compose stack.
# Source of truth: infra/.env + dev.yml + mvp.yml + prod.yml. Never logs secret values.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

ENV_FILE="${ENV_FILE:-infra/.env}"
COMPOSE_FILES=(infra/docker-compose.dev.yml infra/docker-compose.mvp.yml infra/docker-compose.prod.yml)
COMPOSE=(docker compose --env-file "${ENV_FILE}" -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml)
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
    fail "missing ${ENV_FILE}; copy infra/.env.vps.example to infra/.env and fill secrets"
  fi
}

require_compose_files() {
  local f
  for f in "${COMPOSE_FILES[@]}"; do
    [[ -f "${f}" ]] || fail "missing ${f}"
  done
}

env_get() {
  local key="$1"
  "${PYTHON_BIN}" "${LOAD_ENV_PY}" --file "${ENV_FILE}" --get "${key}" 2>/dev/null || true
}

# Primary *_HOST_PORT names with fallback to legacy *_API_HOST_PORT / WEB_HOST_PORT.
resolve_port() {
  local primary="$1" fallback="$2" default="$3"
  local value
  value="$(env_get "${primary}")"
  if [[ -z "${value}" ]]; then
    value="$(env_get "${fallback}")"
  fi
  printf '%s' "${value:-${default}}"
}

validate_database_tls_mode() {
  local deployment_mode tls_mode ai_db_url host
  deployment_mode="$(env_get DEPLOYMENT_MODE)"
  if [[ "${deployment_mode}" != "vps" ]]; then
    fail "DEPLOYMENT_MODE must be exactly 'vps' for scripts/deploy-vps.sh (got '${deployment_mode:-<empty>}')"
  fi

  tls_mode="$(env_get DATABASE_TLS_MODE)"
  if [[ "${tls_mode}" != "disable" ]]; then
    fail "DATABASE_TLS_MODE must be exactly 'disable' for VPS private Docker Postgres (got '${tls_mode:-<empty>}')"
  fi

  ai_db_url="$(env_get AI_DATABASE_URL)"
  [[ -n "${ai_db_url}" && "${ai_db_url}" != CHANGE_ME* ]] || fail 'AI_DATABASE_URL is required (postgresql://user:pass@host:port/db, URL-encoded password)'

  if [[ "${ai_db_url}" =~ ^postgresql(\+psycopg2)?://[^@/]*@([^:/]+) ]]; then
    host="${BASH_REMATCH[2]}"
  else
    fail 'AI_DATABASE_URL is malformed; expected postgresql://user:pass@host:port/db'
  fi
  host="$(printf '%s' "${host}" | tr '[:upper:]' '[:lower:]')"

  case "${host}" in
    postgres|db) ;;
    *)
      fail "AI_DATABASE_URL host must be a private Docker service name (postgres or db) when DATABASE_TLS_MODE=disable; got '${host}' (localhost/127.0.0.1/public IP hosts are never allowed here)"
      ;;
  esac
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

  value="$(env_get GOOGLE_TOKEN_ENCRYPTION_KEY)"
  [[ -n "${value}" && "${value}" != CHANGE_ME* ]] || missing+=('GOOGLE_TOKEN_ENCRYPTION_KEY')

  value="$(env_get GEMINI_API_KEY)"
  [[ -n "${value}" && "${value}" != CHANGE_ME* ]] || missing+=('GEMINI_API_KEY')

  value="$(env_get DEEPGRAM_API_KEY)"
  [[ -n "${value}" && "${value}" != CHANGE_ME* ]] || missing+=('DEEPGRAM_API_KEY')

  value="$(env_get PUBLIC_ORIGIN)"
  if [[ -z "${value}" || "${value}" == https://your-domain.com ]]; then
    value="$(env_get PUBLIC_FRONTEND_ORIGIN)"
  fi
  [[ -n "${value}" && "${value}" != https://your-domain.com ]] || missing+=('PUBLIC_ORIGIN')

  value="$(env_get CORS_ALLOWED_ORIGINS)"
  [[ -n "${value}" && "${value}" != https://your-domain.com ]] || missing+=('CORS_ALLOWED_ORIGINS')

  if ((${#missing[@]} > 0)); then
    fail "invalid or placeholder env vars: ${missing[*]}"
  fi
}

service_exists() {
  local name="$1"
  "${COMPOSE[@]}" config --services 2>/dev/null | grep -Fxq "${name}"
}

resolve_db_service() {
  if service_exists db; then printf '%s' db; return; fi
  if service_exists postgres; then printf '%s' postgres; return; fi
  fail 'compose files have no db or postgres service'
}

resolve_web_service() {
  if service_exists web; then printf '%s' web; return; fi
  if service_exists frontend; then printf '%s' frontend; return; fi
  fail 'compose files have no web or frontend service'
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
  frontend_port="$(resolve_port FRONTEND_HOST_PORT WEB_HOST_PORT 8080)"
  user_port="$(resolve_port USER_HOST_PORT USER_API_HOST_PORT 8083)"
  meeting_port="$(resolve_port MEETING_HOST_PORT MEETING_API_HOST_PORT 8081)"
  processing_port="$(resolve_port PROCESSING_HOST_PORT PROCESSING_API_HOST_PORT 8082)"
  ai_port="$(resolve_port AI_HOST_PORT AI_API_HOST_PORT 8000)"

  curl_loopback "http://127.0.0.1:${frontend_port}/" "web"
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
  note 'Step 1/8: verify docker and compose'
  require_command docker
  resolve_python || fail 'python3/python >= 3.9 not found'
  docker compose version >/dev/null 2>&1 || fail 'docker compose plugin not found'

  note 'Step 2/8: verify env and compose files'
  require_env_file
  require_compose_files
  [[ -f "${LOAD_ENV_PY}" ]] || fail "missing ${LOAD_ENV_PY}"

  note 'Step 3/8: validate required env vars and DATABASE_TLS_MODE preflight'
  validate_required_vars
  validate_database_tls_mode

  local db_service web_service
  db_service="$(resolve_db_service)"
  web_service="$(resolve_web_service)"

  if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    note 'Step 4/8: compose build once'
    "${COMPOSE[@]}" build
  else
    note 'Step 4/8: SKIP_BUILD=1 (skipping compose build entirely; zero builds)'
  fi

  note 'Step 5/8: compose up -d (Flyway/Alembic migrations run automatically via depends_on)'
  "${COMPOSE[@]}" up -d

  note 'Step 6/8: wait for container health'
  local svc
  for svc in "${db_service}" redis "${web_service}" user-api meeting-api processing-api ai-api celery-worker celery-beat; do
    if service_exists "${svc}"; then
      wait_for_service_health "${svc}"
    fi
  done

  note 'Step 7/8: loopback HTTP checks'
  wait_for_loopback_health

  if [[ "${SKIP_SMOKE:-0}" != "1" ]]; then
    note 'Step 8/8: smoke-vps.sh (loopback + infra checks; public smoke opt-in via RUN_PUBLIC_SMOKE=1)'
    ENV_FILE="${ENV_FILE}" "${ROOT}/scripts/smoke-vps.sh"
  else
    note 'Step 8/8: SKIP_SMOKE=1 (skipping smoke-vps.sh)'
  fi

  cat <<EOF

VPS DEPLOY VERDICT
------------------
Compose build: $([[ "${SKIP_BUILD:-0}" == "1" ]] && echo skipped || echo once-before-up).
Migrations: ran via depends_on (db-flyway-bootstrap, user-db-migrate, meeting-db-migrate, ai-db-migrate).
Container + loopback health: passed.
Local smoke: $([[ "${SKIP_SMOKE:-0}" == "1" ]] && echo skipped || echo passed via smoke-vps.sh).
Real VPS / HTTPS: not verified here — confirm DNS/TLS/Nginx on the public domain separately
(RUN_PUBLIC_SMOKE=1 ./scripts/smoke-vps.sh).

EOF
}

main "$@"
