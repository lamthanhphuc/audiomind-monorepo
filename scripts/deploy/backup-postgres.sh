#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="infra/.env"
COMPOSE_FILES=(
  -f infra/docker-compose.dev.yml
  -f infra/docker-compose.mvp.yml
  -f infra/docker-compose.prod.yml
)
COMPOSE=(docker compose --env-file "$ENV_FILE" "${COMPOSE_FILES[@]}")

BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/../audiomind-backups}"
BACKUP_FILE="${BACKUP_FILE:-$BACKUP_DIR/audiomind-postgres-$(date -u +%Y%m%dT%H%M%SZ).dump}"

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'ERROR: %s is missing. Create it from infra/.env.production.example on the server.\n' "$ENV_FILE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

"${COMPOSE[@]}" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges' > "$BACKUP_FILE"

printf 'Wrote Postgres backup to %s\n' "$BACKUP_FILE"
