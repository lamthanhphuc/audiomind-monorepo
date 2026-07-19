#!/usr/bin/env bash
# Infrastructure and application health smoke for VPS Docker Compose.
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

INFRA_OK=0
LOOPBACK_OK=0
PUBLIC_OK=0
FUNCTIONAL_STATUS="NOT RUN"

note() {
  printf '[smoke-vps] %s\n' "$1"
}

fail() {
  printf '[smoke-vps] ERROR: %s\n' "$1" >&2
  exit 1
}

env_get() {
  local key="$1"
  "${PYTHON_BIN}" "${LOAD_ENV_PY}" --file "${ENV_FILE}" --get "${key}" 2>/dev/null || true
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
  local cid status restarts
  cid="$("${COMPOSE[@]}" ps -q "${service}" 2>/dev/null || true)"
  [[ -n "${cid}" ]] || fail "${service} container not running"
  status="$(docker inspect --format '{{.State.Status}}' "${cid}")"
  [[ "${status}" == "running" ]] || fail "${service} status=${status}"
  restarts="$(docker inspect --format '{{.RestartCount}}' "${cid}")"
  if [[ "${restarts}" =~ ^[0-9]+$ ]] && (( restarts > 5 )); then
    fail "${service} restart loop (RestartCount=${restarts})"
  fi
  note "${service} running"
}

assert_service_healthy() {
  local service="$1"
  local cid status
  cid="$("${COMPOSE[@]}" ps -q "${service}" 2>/dev/null || true)"
  [[ -n "${cid}" ]] || fail "${service} not running"
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${cid}")"
  [[ "${status}" == "healthy" || "${status}" == "running" ]] || fail "${service} health=${status}"
  note "${service} healthy (${status})"
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

assert_not_html() {
  local url="$1"
  local label="$2"
  local body
  body="$(curl -fsS --max-time 8 "${url}" 2>/dev/null || true)"
  if printf '%s' "${body}" | grep -qiE '<!DOCTYPE html|<html'; then
    fail "${label} returned HTML (routing likely hit SPA): ${url}"
  fi
  note "${label} not HTML"
}

assert_html() {
  local url="$1"
  local label="$2"
  local body
  body="$(curl -fsS --max-time 8 -H 'Accept: text/html' "${url}" 2>/dev/null || true)"
  if ! printf '%s' "${body}" | grep -qiE '<!DOCTYPE html|<html|index\.html|<div id="root"'; then
    # Frontend nginx may return index.html without doctype in some edge cases; require non-JSON
    if printf '%s' "${body}" | grep -qiE '^\s*\{|"status"\s*:'; then
      fail "${label} looks like API JSON, expected frontend HTML: ${url}"
    fi
  fi
  note "${label} frontend OK"
}

optional_public_nginx_smoke() {
  local origin
  origin="$(env_get PUBLIC_ORIGIN)"
  if [[ -z "${origin}" || "${origin}" == https://your-domain.com || "${origin}" == http://localhost* ]]; then
    note 'public Nginx smoke skipped (PUBLIC_ORIGIN placeholder or empty)'
    PUBLIC_OK=0
    return 0
  fi
  if [[ "${SKIP_PUBLIC_SMOKE:-0}" == "1" ]]; then
    note 'SKIP_PUBLIC_SMOKE=1'
    PUBLIC_OK=0
    return 0
  fi

  note "public Nginx smoke against ${origin}"
  curl_ok "${origin}/" 'public frontend /'
  assert_html "${origin}/auth/google/success" 'public /auth/google/success'
  # Unauthenticated /users should not be SPA HTML (401/403/json).
  local code
  code="$(curl -sS -o /tmp/smoke-users.body -w '%{http_code}' --max-time 8 "${origin}/users/me/google/status" || true)"
  if [[ -f /tmp/smoke-users.body ]] && grep -qiE '<!DOCTYPE html|<html' /tmp/smoke-users.body; then
    fail "/users/me/google/status returned HTML via public origin"
  fi
  note "public /users route HTTP ${code} (not HTML)"

  # WebSocket upgrade headers (handshake may fail without JWT; check 101/400/401/403 not 404 HTML)
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "${origin}/ws/meetings/1" || true)"
  if [[ "${code}" == "404" ]]; then
    fail "public /ws/meetings returned 404"
  fi
  note "public /ws/meetings handshake HTTP ${code}"

  PUBLIC_OK=1
}

optional_functional_smoke() {
  if [[ -z "${SMOKE_JWT:-}" ]]; then
    FUNCTIONAL_STATUS="NOT RUN"
    return 0
  fi
  local processing_port subject_id
  processing_port="$(env_get PROCESSING_API_HOST_PORT)"
  processing_port="${processing_port:-8082}"
  subject_id="${SMOKE_SUBJECT_ID:-}"

  note 'SMOKE_JWT set; checking authenticated /api/users/me'
  local user_port
  user_port="$(env_get USER_API_HOST_PORT)"
  user_port="${user_port:-8083}"
  if ! curl -fsS --max-time 8 -H "Authorization: Bearer ${SMOKE_JWT}" \
    "http://127.0.0.1:${user_port}/api/users/me" >/dev/null; then
    fail 'SMOKE_JWT user profile failed'
  fi

  if [[ -z "${subject_id}" ]]; then
    FUNCTIONAL_STATUS="NOT RUN"
    note 'SMOKE_SUBJECT_ID unset; Phase 2 synthesis smoke not run'
    return 0
  fi

  if curl -fsS --max-time 15 -H "Authorization: Bearer ${SMOKE_JWT}" \
    "http://127.0.0.1:${processing_port}/processing/subjects/${subject_id}/synthesis" >/dev/null \
    && curl -fsS --max-time 15 -H "Authorization: Bearer ${SMOKE_JWT}" \
    "http://127.0.0.1:${processing_port}/processing/subjects/${subject_id}/study-artifacts" >/dev/null; then
    FUNCTIONAL_STATUS="PASS"
    note 'Phase 2 synthesis + artifacts OK'
    return 0
  fi
  fail 'Phase 2 functional smoke failed'
}

main() {
  command -v docker >/dev/null 2>&1 || fail 'docker not found'
  docker compose version >/dev/null 2>&1 || fail 'docker compose plugin not found'
  command -v curl >/dev/null 2>&1 || fail 'curl not found'
  resolve_python || fail 'python3/python >= 3.9 not found'
  [[ -f "${ENV_FILE}" ]] || fail "missing ${ENV_FILE}"
  [[ -f "${COMPOSE_FILE}" ]] || fail "missing ${COMPOSE_FILE}"
  [[ -f "${LOAD_ENV_PY}" ]] || fail "missing ${LOAD_ENV_PY}"

  local postgres_service frontend_service
  postgres_service="$(resolve_postgres_service)"
  frontend_service="$(resolve_frontend_service)"

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

  note 'checking compose service state'
  for svc in "${postgres_service}" redis user-api meeting-api processing-api ai-api celery-worker celery-beat "${frontend_service}"; do
    if service_exists "${svc}"; then
      assert_service_running "${svc}"
    fi
  done
  assert_service_healthy "${postgres_service}"
  assert_service_healthy redis
  INFRA_OK=1

  note 'checking loopback HTTP endpoints'
  curl_ok "http://127.0.0.1:${frontend_port}/" 'frontend'
  curl_ready_or_actuator "http://127.0.0.1:${user_port}" 'user-api'
  curl_ready_or_actuator "http://127.0.0.1:${meeting_port}" 'meeting-api'
  curl_ok "http://127.0.0.1:${processing_port}/ready" 'processing-api'
  curl_ok "http://127.0.0.1:${ai_port}/ready" 'ai-api'
  LOOPBACK_OK=1

  optional_public_nginx_smoke
  optional_functional_smoke

  cat <<EOF

VPS INFRA HEALTHY$([[ "${INFRA_OK}" == "1" ]] && echo '' || echo ' — FAIL')
VPS LOOPBACK APPLICATION HEALTHY$([[ "${LOOPBACK_OK}" == "1" ]] && echo '' || echo ' — FAIL')
VPS PUBLIC NGINX HEALTHY$([[ "${PUBLIC_OK}" == "1" ]] && echo '' || echo ' — NOT RUN')
PHASE 2 FUNCTIONAL SMOKE ${FUNCTIONAL_STATUS}

EOF
}

main "$@"
