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

required_files=(
  "$ENV_FILE"
  infra/.env.production.example
  infra/Caddyfile.example
  infra/docker-compose.dev.yml
  infra/docker-compose.mvp.yml
  infra/docker-compose.prod.yml
)

required_env_keys=(
  APP_ENV
  CORS_ALLOWED_ORIGINS
  POSTGRES_DB
  POSTGRES_USER
  POSTGRES_PASSWORD
  JWT_SECRET
  DEEPGRAM_API_KEY
  GEMINI_API_KEY
  STT_PROVIDER
  ANALYSIS_PROVIDER
  AI_PROVIDER
  LOCAL_WHISPER_ENABLED
  ALLOW_LEGACY_LOCAL_STT
  OLLAMA_ENABLED
  ALLOW_LEGACY_LOCAL_AI
  VITE_MEETING_API_BASE_URL
  VITE_PROCESSING_API_BASE_URL
  VITE_USER_API_BASE_URL
  VITE_API_BASE
  VITE_API_CPU_BASE
  VITE_API_GPU_BASE
  VITE_AI_SERVICE_URL
  VITE_REALTIME_WS_ENABLED
  VITE_REALTIME_WS_BASE_URL
)

allow_empty_env_keys=(
  VITE_AI_SERVICE_URL
)

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

allows_empty_value() {
  local key="$1"
  local allowed

  for allowed in "${allow_empty_env_keys[@]}"; do
    [[ "$key" == "$allowed" ]] && return 0
  done

  return 1
}

for path in "${required_files[@]}"; do
  [[ -f "$path" ]] || fail "missing required file: $path"
done

for key in "${required_env_keys[@]}"; do
  line="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -n 1 || true)"
  [[ -n "$line" ]] || fail "missing required env key: $key"
  value="${line#*=}"
  [[ -n "$value" ]] || allows_empty_value "$key" || fail "empty required env key: $key"
  if [[ "$value" == replace-with-* || "$value" == *example.com* ]]; then
    fail "placeholder value remains for required env key: $key"
  fi
done

[[ "$(grep -E '^[[:space:]]*APP_ENV=' "$ENV_FILE" | tail -n 1 | cut -d= -f2-)" == "production" ]] ||
  fail "APP_ENV must be production"
[[ "$(grep -E '^[[:space:]]*STT_PROVIDER=' "$ENV_FILE" | tail -n 1 | cut -d= -f2-)" == "deepgram" ]] ||
  fail "STT_PROVIDER must be deepgram"
[[ "$(grep -E '^[[:space:]]*ANALYSIS_PROVIDER=' "$ENV_FILE" | tail -n 1 | cut -d= -f2-)" == "gemini" ]] ||
  fail "ANALYSIS_PROVIDER must be gemini"
[[ "$(grep -E '^[[:space:]]*AI_PROVIDER=' "$ENV_FILE" | tail -n 1 | cut -d= -f2-)" == "gemini" ]] ||
  fail "AI_PROVIDER must be gemini"

"${COMPOSE[@]}" config --quiet

printf 'Production Compose configuration rendered successfully.\n'
