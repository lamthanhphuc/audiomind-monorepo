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

check_health_json_url() {
  local url="$1"
  local label="${2:-$url}"
  local body
  local status

  printf 'Checking %s (expect JSON status=UP)\n' "$label"
  body="$(curl -fsS "$url")"
  status="$(printf '%s' "$body" | python -c "import json,sys; print(json.load(sys.stdin).get('status',''))")"
  if [[ "$status" != "UP" ]]; then
    fail "${label} returned status=${status:-<missing>}, expected UP. body=${body}"
  fi
}

check_celery_worker_state() {
  local container_id
  local inspect_output
  local ps_output
  local state_exit_code
  local state_restarting
  local state_status

  printf 'Checking celery-worker state through Compose\n'
  ps_output="$("${COMPOSE[@]}" ps -a celery-worker)"
  printf '%s\n' "$ps_output"

  container_id="$("${COMPOSE[@]}" ps -q celery-worker)"
  if [[ -z "$container_id" ]]; then
    fail "celery-worker container id was not found through Compose"
  fi

  inspect_output="$(docker inspect --format '{{.State.Status}} {{.State.Restarting}} {{.State.ExitCode}}' "$container_id")" ||
    fail "could not inspect celery-worker container state: $container_id"
  read -r state_status state_restarting state_exit_code <<< "$inspect_output"

  printf 'celery-worker inspect state: status=%s restarting=%s exit=%s\n' \
    "$state_status" "$state_restarting" "$state_exit_code"

  if [[ "$state_restarting" == "true" ]]; then
    fail "celery-worker is restarting"
  fi

  if [[ "$state_status" != "running" ]]; then
    if [[ "$state_exit_code" != "0" ]]; then
      fail "celery-worker is not running cleanly: status=$state_status exit=$state_exit_code"
    fi
    fail "celery-worker status is $state_status, expected running"
  fi
}

check_url "https://${APP_HOST}/"
check_health_json_url "https://${MEETING_HOST}/health" "meeting-api /health"
check_health_json_url "https://${MEETING_HOST}/ready" "meeting-api /ready"
check_health_json_url "https://${PROCESSING_HOST}/health" "processing-api /health"
check_health_json_url "https://${PROCESSING_HOST}/ready" "processing-api /ready"
check_health_json_url "https://${USER_HOST}/health" "user-api /health"
check_health_json_url "https://${USER_HOST}/ready" "user-api /ready"

printf 'Checking private ai-api /ready through Compose\n'
"${COMPOSE[@]}" exec -T ai-api python -c "import json, urllib.request; body=urllib.request.urlopen('http://127.0.0.1:8000/ready', timeout=4).read().decode(); status=json.loads(body).get('status',''); assert status=='UP', f'expected UP got {status!r}: {body}'; print('ai-api /ready status=UP')"

check_celery_worker_state

printf 'Production health checks passed.\n'
