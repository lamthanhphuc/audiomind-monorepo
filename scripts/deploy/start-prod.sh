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

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'ERROR: %s is missing. Create it from infra/.env.production.example on the server.\n' "$ENV_FILE" >&2
  exit 1
fi

"$ROOT_DIR/scripts/deploy/check-prod-config.sh"
"${COMPOSE[@]}" build
"${COMPOSE[@]}" up -d
"${COMPOSE[@]}" ps
