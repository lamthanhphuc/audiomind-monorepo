#!/usr/bin/env bash
# Backup VPS Postgres via docker compose exec. Never logs secret values.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/docker-compose.vps.yml}"
COMPOSE=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")
BACKUP_DIR="${BACKUP_DIR:-backups}"
BACKUP_ID="${BACKUP_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
BACKUP_FILE="${BACKUP_DIR}/audiomind-postgres-${BACKUP_ID}.sql.gz"

note() {
  printf '[backup-vps] %s\n' "$1"
}

fail() {
  printf '[backup-vps] ERROR: %s\n' "$1" >&2
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

main() {
  command -v docker >/dev/null 2>&1 || fail 'docker not found'
  docker compose version >/dev/null 2>&1 || fail 'docker compose plugin not found'
  [[ -f "${ENV_FILE}" ]] || fail "missing ${ENV_FILE}"
  [[ -f "${COMPOSE_FILE}" ]] || fail "missing ${COMPOSE_FILE}"

  local postgres_service
  postgres_service="$(resolve_postgres_service)"

  mkdir -p "${BACKUP_DIR}"
  note "writing ${BACKUP_FILE}"

  "${COMPOSE[@]}" exec -T "${postgres_service}" \
    sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges' \
    | gzip > "${BACKUP_FILE}"

  if [[ ! -s "${BACKUP_FILE}" ]]; then
    fail "backup file missing or empty: ${BACKUP_FILE}"
  fi

  note "backup complete: ${BACKUP_FILE}"
}

main "$@"
