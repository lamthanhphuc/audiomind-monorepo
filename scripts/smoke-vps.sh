#!/usr/bin/env bash
# Infrastructure and application health smoke for VPS Docker Compose.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/docker-compose.vps.yml}"
COMPOSE=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

note() {
  printf '[smoke-vps] %s\n' "$1"
}

fail() {
  printf '[smoke-vps] ERROR: %s\n' "$1" >&2
  exit 1
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

assert_service_running() {
  local service="$1"
  local cid status
  cid="$("${COMPOSE[@]}" ps -q "${service}" 2>/dev/null || true)"
  [[ -n "${cid}" ]] || fail "${service} container not running"
  status="$(docker inspect --format '{{.State.Status}}' "${cid}")"
  [[ "${status}" == "running" ]] || fail "${service} status=${status}"
  note "${service} running"
}

curl_ok() {
  local url="$1"
  local label="$2"
  if curl -fsS --max-time 8 "${url}" >/dev/null; then
    note "${label} OK"
    return 0
  fi
  fail "${label} failed (${url})"
}

curl_ready_or_actuator() {
  local base="$1"
  local label="$2"
  if curl -fsS --max-time 8 "${base}/ready" >/dev/null 2>&1; then
    note "${label} OK (/ready)"
    return 0
  fi
  if curl -fsS --max-time 8 "${base}/actuator/health/readiness" >/dev/null 2>&1; then
    note "${label} OK (/actuator/health/readiness)"
    return 0
  fi
  fail "${label} readiness check failed (${base})"
}

optional_login_smoke() {
  if [[ -z "${SMOKE_JWT:-}" ]]; then
    return 0
  fi
  local user_port="${USER_API_HOST_PORT:-8083}"
  note 'SMOKE_JWT set; checking authenticated /api/users/me'
  if curl -fsS --max-time 8 -H "Authorization: Bearer ${SMOKE_JWT}" "http://127.0.0.1:${user_port}/api/users/me" >/dev/null; then
    note 'authenticated user profile OK'
    return 0
  fi
  fail 'SMOKE_JWT login check failed'
}

main() {
  command -v docker >/dev/null 2>&1 || fail 'docker not found'
  docker compose version >/dev/null 2>&1 || fail 'docker compose plugin not found'
  command -v curl >/dev/null 2>&1 || fail 'curl not found'
  [[ -f "${ENV_FILE}" ]] || fail "missing ${ENV_FILE}"
  [[ -f "${COMPOSE_FILE}" ]] || fail "missing ${COMPOSE_FILE}"

  # shellcheck disable=SC1090
  set -a
  source "${ENV_FILE}"
  set +a

  local postgres_service frontend_service
  postgres_service="$(resolve_postgres_service)"
  frontend_service="$(resolve_frontend_service)"

  local frontend_port="${FRONTEND_HOST_PORT:-${WEB_HOST_PORT:-8080}}"
  local user_port="${USER_API_HOST_PORT:-8083}"
  local meeting_port="${MEETING_API_HOST_PORT:-8081}"
  local processing_port="${PROCESSING_API_HOST_PORT:-8082}"
  local ai_port="${AI_API_HOST_PORT:-8000}"

  note 'checking compose service state'
  for svc in "${postgres_service}" redis user-api meeting-api processing-api ai-api celery-worker celery-beat "${frontend_service}"; do
    if service_exists "${svc}"; then
      assert_service_running "${svc}"
    fi
  done

  note 'checking loopback HTTP endpoints'
  curl_ok "http://127.0.0.1:${frontend_port}/" 'frontend'
  curl_ready_or_actuator "http://127.0.0.1:${user_port}" 'user-api'
  curl_ready_or_actuator "http://127.0.0.1:${meeting_port}" 'meeting-api'
  curl_ok "http://127.0.0.1:${processing_port}/ready" 'processing-api'
  curl_ok "http://127.0.0.1:${ai_port}/ready" 'ai-api'

  optional_login_smoke

  cat <<EOF

VPS INFRA HEALTHY
VPS APPLICATION HEALTHY
PHASE 2 FUNCTIONAL SMOKE NOT RUN

EOF
}

main "$@"
