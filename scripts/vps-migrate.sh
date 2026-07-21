#!/usr/bin/env bash
# Optional troubleshooting/re-run of database migrations for the layered VPS Docker Compose
# stack. Migrations normally run automatically via `depends_on: service_completed_successfully`
# when `deploy-vps.sh` / `deploy-local.sh` call `up -d` — this script exists to re-run them
# explicitly (e.g. after fixing a failed migration) without requiring any compose profile,
# since the migrate services (db-flyway-bootstrap, user-db-migrate, meeting-db-migrate,
# ai-db-migrate) are always-defined, profile-less, one-shot services. Never logs secret values.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

ENV_FILE="${ENV_FILE:-infra/.env}"
COMPOSE_FILES=(infra/docker-compose.dev.yml infra/docker-compose.mvp.yml infra/docker-compose.prod.yml)
COMPOSE=(docker compose --env-file "${ENV_FILE}" -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml)

note() {
  printf '[vps-migrate] %s\n' "$1"
}

fail() {
  printf '[vps-migrate] ERROR: %s\n' "$1" >&2
  exit 1
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

service_exists() {
  local name="$1"
  "${COMPOSE[@]}" config --services 2>/dev/null | grep -Fxq "${name}"
}

resolve_postgres_service() {
  if service_exists db; then
    printf '%s' db
    return 0
  fi
  if service_exists postgres; then
    printf '%s' postgres
    return 0
  fi
  fail "compose files have no db or postgres service"
}

wait_for_postgres() {
  local postgres_service="$1"
  local deadline=$(( $(date +%s) + ${POSTGRES_WAIT_SECONDS:-180} ))
  note "waiting for ${postgres_service} health"

  while true; do
    local cid
    cid="$("${COMPOSE[@]}" ps -q "${postgres_service}" 2>/dev/null || true)"
    if [[ -n "${cid}" ]]; then
      local status
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${cid}" 2>/dev/null || true)"
      if [[ "${status}" == "healthy" || "${status}" == "running" ]]; then
        note "${postgres_service} is ${status}"
        return 0
      fi
    fi
    if (( $(date +%s) >= deadline )); then
      fail "timed out waiting for ${postgres_service} health"
    fi
    sleep 3
  done
}

run_migration_service() {
  local name="$1"
  note "running ${name}"
  "${COMPOSE[@]}" run --rm "${name}"
  note "${name} completed"
}

run_java_migrations() {
  if service_exists db-flyway-bootstrap; then
    run_migration_service db-flyway-bootstrap
  else
    note "db-flyway-bootstrap not defined; skipping bootstrap"
  fi

  if service_exists user-db-migrate; then
    run_migration_service user-db-migrate
  else
    fail "no user-db-migrate service for user schema migrations"
  fi

  if service_exists meeting-db-migrate; then
    run_migration_service meeting-db-migrate
  else
    fail "no meeting-db-migrate service for meeting schema migrations"
  fi

  if service_exists ai-db-migrate; then
    run_migration_service ai-db-migrate
  else
    fail "no ai-db-migrate service for AI schema migrations"
  fi
}

main() {
  command -v docker >/dev/null 2>&1 || fail "docker not found"
  docker compose version >/dev/null 2>&1 || fail "docker compose plugin not found"

  require_env_file
  require_compose_files

  local postgres_service
  postgres_service="$(resolve_postgres_service)"

  note "using env file ${ENV_FILE}"
  note "using compose files: ${COMPOSE_FILES[*]}"

  # Ensure postgres is up for one-shot migrate containers (no profile required —
  # these services are always defined and simply not started implicitly by `run`).
  "${COMPOSE[@]}" up -d "${postgres_service}"
  wait_for_postgres "${postgres_service}"

  run_java_migrations

  note "all migrations completed successfully"
}

main "$@"
