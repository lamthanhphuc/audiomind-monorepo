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

TAIL_LINES="${TAIL_LINES:-500}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/../audiomind-logs}"

if [[ -z "${OUTPUT_FILE:-}" ]]; then
  mkdir -p "$OUTPUT_DIR"
  OUTPUT_FILE="$OUTPUT_DIR/prod-logs-redacted-$(date -u +%Y%m%dT%H%M%SZ).log"
else
  mkdir -p "$(dirname "$OUTPUT_FILE")"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'ERROR: %s is missing. Create it from infra/.env.production.example on the server.\n' "$ENV_FILE" >&2
  exit 1
fi

"${COMPOSE[@]}" logs --no-color --tail="$TAIL_LINES" "$@" |
  perl -pe '
    s/\b(DEEPGRAM_API_KEY|GEMINI_API_KEY|JWT_SECRET|POSTGRES_PASSWORD)([=:][[:space:]]*)[^[:space:],;]+/${1}${2}[REDACTED]/gi;
    s/(Authorization:[[:space:]]*Bearer[[:space:]]+)[A-Za-z0-9._~+\/=-]+/${1}[REDACTED]/gi;
    s/\bAIza[0-9A-Za-z_-]{20,}\b/[REDACTED_GOOGLE_API_KEY]/g;
    s/\bsk-[A-Za-z0-9_-]{20,}\b/[REDACTED_OPENAI_API_KEY]/g;
    s/\bsk-proj-[A-Za-z0-9_-]{20,}\b/[REDACTED_OPENAI_API_KEY]/g;
  ' > "$OUTPUT_FILE"

printf 'Wrote redacted logs to %s\n' "$OUTPUT_FILE"
