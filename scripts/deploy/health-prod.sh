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

domain_for() {
  local explicit="$1"
  local prefix="$2"

  if [[ -n "$explicit" ]]; then
    printf '%s\n' "$explicit"
    return 0
  fi

  if [[ -n "${DOMAIN_ROOT:-}" ]]; then
    printf '%s.%s\n' "$prefix" "$DOMAIN_ROOT"
    return 0
  fi

  printf 'ERROR: set DOMAIN_ROOT or explicit APP_DOMAIN/MEETING_DOMAIN/PROCESSING_DOMAIN/USER_DOMAIN.\n' >&2
  return 1
}

APP_HOST="$(domain_for "${APP_DOMAIN:-}" app)"
MEETING_HOST="$(domain_for "${MEETING_DOMAIN:-}" meeting)"
PROCESSING_HOST="$(domain_for "${PROCESSING_DOMAIN:-}" processing)"
USER_HOST="$(domain_for "${USER_DOMAIN:-}" user)"

check_url() {
  local url="$1"
  printf 'Checking %s\n' "$url"
  curl -fsS "$url" > /dev/null
}

check_url "https://${APP_HOST}/"
check_url "https://${MEETING_HOST}/health"
check_url "https://${MEETING_HOST}/ready"
check_url "https://${PROCESSING_HOST}/health"
check_url "https://${PROCESSING_HOST}/ready"
check_url "https://${USER_HOST}/health"
check_url "https://${USER_HOST}/ready"

printf 'Checking private ai-api /ready through Compose\n'
"${COMPOSE[@]}" exec -T ai-api python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/ready', timeout=4).read()"

printf 'Production health checks passed.\n'
