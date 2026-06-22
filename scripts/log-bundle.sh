#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SINCE="${SINCE:-15m}"
GREP_PROFILE="${GREP_PROFILE:-ALL}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/../audiomind-logs}"

usage() {
  cat <<'EOF'
Usage: scripts/log-bundle.sh [--since DURATION] [--grep PR1|PR2|EPIC2|ALL]

Collects redacted docker compose logs and filters Epic 7T observability markers.

Environment:
  SINCE          docker logs --since value (default: 15m)
  OUTPUT_DIR     directory for bundle file (default: ../audiomind-logs)
  TAIL_LINES     passed to collect-prod-logs-redacted.sh (default: 500)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since)
      SINCE="${2:-15m}"
      shift 2
      ;;
    --grep)
      GREP_PROFILE="${2:-ALL}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

mkdir -p "$OUTPUT_DIR"
BUNDLE_FILE="$OUTPUT_DIR/log-bundle-7t-$(date -u +%Y%m%dT%H%M%SZ).log"
RAW_FILE="$(mktemp)"

cleanup() {
  rm -f "$RAW_FILE"
}
trap cleanup EXIT

export TAIL_LINES="${TAIL_LINES:-2000}"
export OUTPUT_FILE="$RAW_FILE"

if [[ -n "$SINCE" ]]; then
  ENV_FILE="infra/.env"
  COMPOSE_FILES=(
    -f infra/docker-compose.dev.yml
    -f infra/docker-compose.mvp.yml
    -f infra/docker-compose.prod.yml
  )
  docker compose --env-file "$ENV_FILE" "${COMPOSE_FILES[@]}" logs --no-color --since="$SINCE" 2>/dev/null |
    perl -pe '
      s/\b(DEEPGRAM_API_KEY|GEMINI_API_KEY|JWT_SECRET|POSTGRES_PASSWORD)([=:][[:space:]]*)[^[:space:],;]+/${1}${2}[REDACTED]/gi;
      s/(Authorization:[[:space:]]*Bearer[[:space:]]+)[A-Za-z0-9._~+\/=-]+/${1}[REDACTED]/gi;
      s/\bAIza[0-9A-Za-z_-]{20,}\b/[REDACTED_GOOGLE_API_KEY]/g;
    ' > "$RAW_FILE" || bash "$ROOT_DIR/scripts/deploy/collect-prod-logs-redacted.sh" >/dev/null
else
  bash "$ROOT_DIR/scripts/deploy/collect-prod-logs-redacted.sh" >/dev/null
fi

PR1_PATTERN='REALTIME_FINAL_CHUNK_ENQUEUED|REALTIME_FINALIZE_AFTER_CLIENT_DRAIN|REALTIME_STOP_FINALIZE_AFTER_DRAIN|MEDIARECORDER_REQUEST_DATA|MEDIARECORDER_STOP_EVENT|REALTIME_STOP_DUPLICATE_IGNORED'
PR2_PATTERN='ANALYSIS_SKIPPED_SHORT_TRANSCRIPT|GEMINI_KEY_SELECTED|GEMINI_KEY_FAILED|GEMINI_ALL_KEYS_EXHAUSTED|ANALYSIS_BACKGROUND_RETRY_|ANALYSIS_LOCK_|REALTIME_ANALYSIS_FAILED_RETRYABLE|ANALYSIS_FAILED_RETRYABLE'
EPIC2_PATTERN='UPLOAD_VALIDATION_|MIME_MISMATCH|REALTIME_VALIDATION_|UPLOAD_SCAN_|UPLOAD_SCAN_CIRCUIT_OPEN'

case "${GREP_PROFILE^^}" in
  PR1)
    PATTERN="$PR1_PATTERN"
    ;;
  PR2)
    PATTERN="$PR2_PATTERN"
    ;;
  EPIC2)
    PATTERN="$EPIC2_PATTERN"
    ;;
  ALL|*)
    PATTERN="$PR1_PATTERN|$PR2_PATTERN|$EPIC2_PATTERN"
    ;;
esac

{
  printf '# log-bundle profile=%s since=%s generated=%s\n' "$GREP_PROFILE" "$SINCE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '# pattern: %s\n\n' "$PATTERN"
  grep -E "$PATTERN" "$RAW_FILE" || true
} > "$BUNDLE_FILE"

printf 'Wrote filtered log bundle to %s (%s lines)\n' "$BUNDLE_FILE" "$(wc -l < "$BUNDLE_FILE" | tr -d ' ')"
