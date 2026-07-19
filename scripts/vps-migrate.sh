#!/usr/bin/env bash
# Run database migrations for VPS Docker Compose. Never logs secret values.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/docker-compose.vps.yml}"
# Migrate services use Compose profile "migrate" so they are not started by default `up`.
COMPOSE=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" --profile migrate)

note() {
  printf '[vps-migrate] %s\n' "$1"
}

fail() {
  printf '[vps-migrate] ERROR: %s\n' "$1" >&2
  exit 1
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

service_exists() {
  local name="$1"
  "${COMPOSE[@]}" config --services 2>/dev/null | grep -Fxq "${name}"
}

resolve_postgres_service() {
  if service_exists postgres; then
    printf '%s' postgres
    return 0
  fi
  if service_exists db; then
    printf '%s' db
    return 0
  fi
  fail "compose file has no postgres or db service"
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

run_spring_migration_profile() {
  local service="$1"
  note "running ${service} Spring migration profile"
  "${COMPOSE[@]}" run --rm \
    -e SPRING_PROFILES_ACTIVE=migration \
    -e SPRING_FLYWAY_ENABLED=true \
    -e SPRING_MAIN_WEB_APPLICATION_TYPE=none \
    "${service}"
  note "${service} Spring migration profile completed"
}

run_java_migrations() {
  if service_exists db-flyway-bootstrap; then
    run_migration_service db-flyway-bootstrap
  else
    note "db-flyway-bootstrap not defined; skipping bootstrap"
  fi

  if service_exists user-db-migrate; then
    run_migration_service user-db-migrate
  elif service_exists user-api; then
    run_spring_migration_profile user-api
  else
    fail "no user-db-migrate service or user-api image for migrations"
  fi

  if service_exists meeting-db-migrate; then
    run_migration_service meeting-db-migrate
  elif service_exists meeting-api; then
    run_spring_migration_profile meeting-api
  else
    fail "no meeting-db-migrate service or meeting-api image for migrations"
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
  require_compose_file

  local postgres_service
  postgres_service="$(resolve_postgres_service)"

  note "using env file ${ENV_FILE}"
  note "using compose file ${COMPOSE_FILE}"

  # Ensure postgres is up for one-shot migrate containers.
  "${COMPOSE[@]}" up -d "${postgres_service}"
  wait_for_postgres "${postgres_service}"

  run_java_migrations

  note "all migrations completed successfully"
}

main "$@"
