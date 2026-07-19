#!/usr/bin/env bash
# Backup VPS Postgres via docker compose exec. Never logs secret values.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/docker-compose.vps.yml}"
COMPOSE=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")
LOAD_ENV_PY="${ROOT}/scripts/load-compose-env.py"
PYTHON_BIN=""
BACKUP_DIR="${BACKUP_DIR:-backups}"
BACKUP_ID="${BACKUP_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
BACKUP_FILE="${BACKUP_DIR}/audiomind-postgres-${BACKUP_ID}.sql.gz"

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
  printf '[backup-vps] %s\n' "$1"
}

fail() {
  printf '[backup-vps] ERROR: %s\n' "$1" >&2
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

main() {
  command -v docker >/dev/null 2>&1 || fail 'docker not found'
  docker compose version >/dev/null 2>&1 || fail 'docker compose plugin not found'
  resolve_python || fail 'python3/python >= 3.9 not found'
  command -v gzip >/dev/null 2>&1 || fail 'gzip not found'
  [[ -f "${ENV_FILE}" ]] || fail "missing ${ENV_FILE}"
  [[ -f "${COMPOSE_FILE}" ]] || fail "missing ${COMPOSE_FILE}"
  [[ -f "${LOAD_ENV_PY}" ]] || fail "missing ${LOAD_ENV_PY}"

  local postgres_service db_user db_name
  postgres_service="$(resolve_postgres_service)"
  db_user="$(env_get POSTGRES_USER)"
  db_user="${db_user:-audiomind}"
  db_name="$(env_get POSTGRES_DB)"
  db_name="${db_name:-audiomind}"

  mkdir -p "${BACKUP_DIR}"
  chmod 700 "${BACKUP_DIR}" 2>/dev/null || true
  note "writing ${BACKUP_FILE}"

  # Use compose service name + env from the postgres container (password never on shell argv).
  if ! "${COMPOSE[@]}" exec -T "${postgres_service}" \
    pg_dump -U "${db_user}" -d "${db_name}" --no-owner --no-privileges \
    | gzip -c > "${BACKUP_FILE}"; then
    rm -f "${BACKUP_FILE}"
    fail "pg_dump failed"
  fi

  if [[ ! -s "${BACKUP_FILE}" ]]; then
    rm -f "${BACKUP_FILE}"
    fail "backup file missing or empty: ${BACKUP_FILE}"
  fi

  if ! gzip -t "${BACKUP_FILE}"; then
    rm -f "${BACKUP_FILE}"
    fail "backup gzip integrity check failed: ${BACKUP_FILE}"
  fi

  chmod 600 "${BACKUP_FILE}" 2>/dev/null || true
  note "backup complete: ${BACKUP_FILE}"
}

main "$@"
