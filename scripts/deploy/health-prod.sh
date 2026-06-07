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

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

env_value() {
  local key="$1"
  local line
  local value

  line="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -n 1 || true)"
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s\n' "$value"
}

DOMAIN_ROOT_VALUE="$(env_value DOMAIN_ROOT)"

expand_domain_root() {
  local value="$1"
  value="${value//\$\{DOMAIN_ROOT\}/$DOMAIN_ROOT_VALUE}"
  value="${value//\$DOMAIN_ROOT/$DOMAIN_ROOT_VALUE}"
  printf '%s\n' "$value"
}

domain_for() {
  local explicit="$1"
  local prefix="$2"

  if [[ -n "$explicit" ]]; then
    printf '%s\n' "$explicit"
    return 0
  fi

  if [[ -n "$DOMAIN_ROOT_VALUE" ]]; then
    printf '%s.%s\n' "$prefix" "$DOMAIN_ROOT_VALUE"
    return 0
  fi

  printf 'ERROR: set DOMAIN_ROOT or explicit APP_DOMAIN/MEETING_DOMAIN/PROCESSING_DOMAIN/USER_DOMAIN.\n' >&2
  return 1
}

APP_HOST="$(domain_for "$(expand_domain_root "$(env_value APP_DOMAIN)")" app)"
MEETING_HOST="$(domain_for "$(expand_domain_root "$(env_value MEETING_DOMAIN)")" meeting)"
PROCESSING_HOST="$(domain_for "$(expand_domain_root "$(env_value PROCESSING_DOMAIN)")" processing)"
USER_HOST="$(domain_for "$(expand_domain_root "$(env_value USER_DOMAIN)")" user)"

check_url() {
  local url="$1"
  printf 'Checking %s\n' "$url"
  curl -fsS "$url" > /dev/null
}

check_celery_worker_state() {
  local ps_output

  printf 'Checking celery-worker state through Compose\n'
  ps_output="$("${COMPOSE[@]}" ps -a celery-worker)"
  printf '%s\n' "$ps_output"

  if ! printf '%s\n' "$ps_output" | grep -Eiq 'celery-worker'; then
    fail "celery-worker is missing from Compose ps output"
  fi

  if printf '%s\n' "$ps_output" | grep -Eiq '\b(Restarting|Exited|Dead|Created|Paused|Removing)\b'; then
    fail "celery-worker is not running cleanly; Compose ps shows Restarting/Exited/non-running state"
  fi

  if ! printf '%s\n' "$ps_output" | grep -Eiq '\b(Up|running)\b'; then
    fail "celery-worker state is not clearly running in Compose ps output"
  fi
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

check_celery_worker_state

printf 'Production health checks passed.\n'
