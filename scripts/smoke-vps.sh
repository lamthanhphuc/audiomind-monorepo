#!/usr/bin/env bash
# Infrastructure and application health smoke for the layered VPS Docker Compose stack.
# Default compose: infra/.env + dev.yml + mvp.yml + prod.yml. Fail-closed on every check.
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

resolve_port() {
  local primary="$1" fallback="$2" default="$3"
  local value
  value="$(env_get "${primary}")"
  if [[ -z "${value}" ]]; then
    value="$(env_get "${fallback}")"
  fi
  printf '%s' "${value:-${default}}"
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

# Performs an HTTP GET. Returns nonzero ONLY on a curl network-level failure
# (never masked with `|| true`); prints the HTTP status code on stdout.
http_probe() {
  local url="$1" body_file="$2" headers_file="$3"
  curl -sS --max-time 10 -D "${headers_file}" -o "${body_file}" -w '%{http_code}' "${url}"
}

curl_ok() {
  local url="$1"
  local label="$2"
  local code
  if ! code="$(curl -sS -o /dev/null --max-time 8 -w '%{http_code}' "${url}")"; then
    fail "${label} unreachable (network error): ${url}"
  fi
  [[ "${code}" == "200" ]] || fail "${label} expected HTTP 200, got ${code} (${url})"
  note "${label} OK"
}

curl_ready_or_actuator() {
  local base="$1"
  local label="$2"
  local code
  if code="$(curl -sS -o /dev/null --max-time 8 -w '%{http_code}' "${base}/ready" 2>/dev/null)" && [[ "${code}" == "200" ]]; then
    note "${label} OK (/ready)"
    return 0
  fi
  if code="$(curl -sS -o /dev/null --max-time 8 -w '%{http_code}' "${base}/actuator/health/readiness" 2>/dev/null)" && [[ "${code}" == "200" ]]; then
    note "${label} OK (/actuator/health/readiness)"
    return 0
  fi
  fail "${label} readiness check failed (${base})"
}

assert_public_success_html() {
  local url="$1" label="$2"
  local body_file headers_file code
  body_file="$(mktemp)"
  headers_file="$(mktemp)"
  if ! code="$(http_probe "${url}" "${body_file}" "${headers_file}")"; then
    rm -f "${body_file}" "${headers_file}"
    fail "${label} unreachable (network error): ${url}"
  fi
  if [[ "${code}" != "200" ]]; then
    rm -f "${body_file}" "${headers_file}"
    fail "${label} expected HTTP 200, got ${code}: ${url}"
  fi
  if ! grep -qiE '^content-type:[[:space:]]*text/html' "${headers_file}"; then
    rm -f "${body_file}" "${headers_file}"
    fail "${label} expected Content-Type: text/html: ${url}"
  fi
  if ! grep -qiE '<!DOCTYPE html|<html|<div id="root"|index\.html' "${body_file}"; then
    rm -f "${body_file}" "${headers_file}"
    fail "${label} body does not look like frontend HTML: ${url}"
  fi
  rm -f "${body_file}" "${headers_file}"
  note "${label} OK (200, text/html)"
}

assert_status_allowed_not_html() {
  local url="$1" label="$2"
  local body_file code
  body_file="$(mktemp)"
  if ! code="$(curl -sS --max-time 10 -o "${body_file}" -w '%{http_code}' "${url}")"; then
    rm -f "${body_file}"
    fail "${label} unreachable (network error): ${url}"
  fi
  case "${code}" in
    200|401|403) ;;
    *)
      rm -f "${body_file}"
      fail "${label} unexpected HTTP ${code} (only 200/401/403 are acceptable): ${url}"
      ;;
  esac
  if grep -qiE '<!DOCTYPE html|<html' "${body_file}"; then
    rm -f "${body_file}"
    fail "${label} returned HTML (routing likely hit SPA fallback): ${url}"
  fi
  rm -f "${body_file}"
  note "${label} OK (HTTP ${code}, not HTML)"
}

assert_ws_handshake() {
  local url="$1" label="$2"
  local code
  if ! code="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "${url}")"; then
    fail "${label} unreachable (network error): ${url}"
  fi
  case "${code}" in
    101|400|401|403|426)
      note "${label} OK (HTTP ${code})"
      ;;
    404)
      fail "${label} returned 404 (WebSocket route missing on public Nginx)"
      ;;
    5??)
      fail "${label} returned server error HTTP ${code}"
      ;;
    *)
      fail "${label} unexpected HTTP ${code} (expected 101/400/401/403/426)"
      ;;
  esac
}

optional_public_nginx_smoke() {
  if [[ "${RUN_PUBLIC_SMOKE:-0}" != "1" ]]; then
    note 'public Nginx smoke skipped (set RUN_PUBLIC_SMOKE=1 to run against the real public domain)'
    PUBLIC_OK=0
    return 0
  fi

  local origin
  origin="$(env_get PUBLIC_ORIGIN)"
  if [[ -z "${origin}" || "${origin}" == https://your-domain.com ]]; then
    fail 'RUN_PUBLIC_SMOKE=1 but PUBLIC_ORIGIN is empty or a placeholder'
  fi
  if [[ "${origin}" != https://* ]]; then
    fail "RUN_PUBLIC_SMOKE=1 requires an HTTPS PUBLIC_ORIGIN, got '${origin}'"
  fi

  note "public Nginx smoke against ${origin} (fail-closed)"
  assert_public_success_html "${origin}/" 'public frontend /'
  assert_public_success_html "${origin}/auth/google/success" 'public /auth/google/success'
  assert_status_allowed_not_html "${origin}/users/me/google/status" 'public /users/me/google/status'
  assert_ws_handshake "${origin}/ws/meetings/1" 'public /ws/meetings'

  PUBLIC_OK=1
}

optional_functional_smoke() {
  if [[ -z "${SMOKE_JWT:-}" ]]; then
    FUNCTIONAL_STATUS="NOT RUN"
    return 0
  fi
  local processing_port subject_id
  processing_port="$(resolve_port PROCESSING_HOST_PORT PROCESSING_API_HOST_PORT 8082)"
  subject_id="${SMOKE_SUBJECT_ID:-}"

  note 'SMOKE_JWT set; checking authenticated /api/users/me'
  local user_port
  user_port="$(resolve_port USER_HOST_PORT USER_API_HOST_PORT 8083)"
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
  local f
  for f in "${COMPOSE_FILES[@]}"; do
    [[ -f "${f}" ]] || fail "missing ${f}"
  done
  [[ -f "${LOAD_ENV_PY}" ]] || fail "missing ${LOAD_ENV_PY}"

  local db_service web_service
  db_service="$(resolve_db_service)"
  web_service="$(resolve_web_service)"

  local frontend_port user_port meeting_port processing_port ai_port
  frontend_port="$(resolve_port FRONTEND_HOST_PORT WEB_HOST_PORT 8080)"
  user_port="$(resolve_port USER_HOST_PORT USER_API_HOST_PORT 8083)"
  meeting_port="$(resolve_port MEETING_HOST_PORT MEETING_API_HOST_PORT 8081)"
  processing_port="$(resolve_port PROCESSING_HOST_PORT PROCESSING_API_HOST_PORT 8082)"
  ai_port="$(resolve_port AI_HOST_PORT AI_API_HOST_PORT 8000)"

  note 'checking compose service state'
  for svc in "${db_service}" redis user-api meeting-api processing-api ai-api celery-worker celery-beat "${web_service}"; do
    if service_exists "${svc}"; then
      assert_service_running "${svc}"
    fi
  done
  assert_service_healthy "${db_service}"
  assert_service_healthy redis
  INFRA_OK=1

  note 'checking loopback HTTP endpoints'
  curl_ok "http://127.0.0.1:${frontend_port}/" 'web'
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
VPS PUBLIC NGINX HEALTHY$([[ "${PUBLIC_OK}" == "1" ]] && echo '' || echo ' — NOT RUN (RUN_PUBLIC_SMOKE=1 to enable)')
PHASE 2 FUNCTIONAL SMOKE ${FUNCTIONAL_STATUS}

EOF
}

main "$@"
