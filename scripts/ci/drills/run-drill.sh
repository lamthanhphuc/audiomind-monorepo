#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

DRILL="${1:-all}"

run_drill() {
  local id="$1"
  printf '\n=== Drill %s ===\n' "$id"
  case "$id" in
    1)
      printf '%s\n' \
        "1. Upload oversize/unsupported file via FE or API" \
        "2. Copy traceId from error response" \
        "3. docker compose logs meeting-api processing-api | grep traceId=<id>" \
        "4. Expect UPLOAD_TOO_LARGE or UNSUPPORTED_AUDIO_TYPE"
      ;;
    2)
      printf '%s\n' \
        "docker compose stop ai-api" \
        "curl -sS -o /dev/null -w '%{http_code}' http://localhost:8082/ready  # expect 503" \
        "docker compose start ai-api"
      ;;
    3)
      printf '%s\n' \
        "K8s staging only:" \
        "kubectl port-forward -n audiomind-staging svc/jaeger 16686:16686" \
        "Call processing API with header X-Trace-Id: drill-3-test" \
        "Jaeger UI: processing-api child span to ai-api"
      ;;
    4)
      bash "${ROOT_DIR}/scripts/ci/log-bundle.sh" --profile BETA_OPS --since 1h
      printf 'Inspect bundle for secrets: grep -r GEMINI_API_KEY= ops-logs/\n'
      ;;
    5)
      printf '%s\n' \
        "Trigger ANALYSIS_BUSY path" \
        "docker compose logs ai-api processing-api | grep event=ANALYSIS_BUSY"
      ;;
    *)
      printf 'Unknown drill: %s\n' "$id" >&2
      exit 2
      ;;
  esac
}

if [[ "$DRILL" == "all" ]]; then
  for id in 1 2 3 4 5; do
    run_drill "$id"
  done
else
  run_drill "$DRILL"
fi

printf '\nRecord evidence in docs/specs/beta-ops-gate-checklist.md\n'
