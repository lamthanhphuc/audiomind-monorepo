#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PROFILE="BETA_OPS"
SINCE="1h"
NAMESPACE=""
SERVICES=(processing-api meeting-api user-api ai-api celery-worker)

usage() {
  cat <<'EOF'
Usage: log-bundle.sh [--profile BETA_OPS] [--since 1h] [--namespace audiomind-staging]

Grep compose or kubectl logs for Beta Ops patterns:
  Health check, traceId, span, error, event=
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    --since)
      SINCE="$2"
      shift 2
      ;;
    --namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

PATTERNS='Health check|traceId|TraceId|span|error|event='

if [[ "$PROFILE" != "BETA_OPS" ]]; then
  printf 'Unsupported profile: %s (only BETA_OPS)\n' "$PROFILE" >&2
  exit 2
fi

OUT_DIR="${ROOT_DIR}/ops-logs/beta-ops-bundle-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR"

if [[ -n "$NAMESPACE" ]] && command -v kubectl >/dev/null 2>&1; then
  for svc in "${SERVICES[@]}"; do
    outfile="${OUT_DIR}/${svc}.log"
    kubectl logs -n "$NAMESPACE" -l "app=${svc}" --since="$SINCE" 2>/dev/null \
      | grep -Eai "$PATTERNS" >"$outfile" || true
    printf 'Wrote %s (%s lines)\n' "$outfile" "$(wc -l <"$outfile" | tr -d ' ')"
  done
else
  COMPOSE=(docker compose --env-file infra/.env \
    -f infra/docker-compose.dev.yml \
    -f infra/docker-compose.mvp.yml)
  for svc in "${SERVICES[@]}"; do
    outfile="${OUT_DIR}/${svc}.log"
    "${COMPOSE[@]}" logs --since "$SINCE" "$svc" 2>/dev/null \
      | grep -Eai "$PATTERNS" >"$outfile" || true
    printf 'Wrote %s (%s lines)\n' "$outfile" "$(wc -l <"$outfile" | tr -d ' ')"
  done
fi

printf 'Beta Ops log bundle: %s\n' "$OUT_DIR"
