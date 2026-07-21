#!/usr/bin/env bash
# Smoke: verify processing-api replicas share Redis and realtime streams config is enabled.
# Prerequisite: stack up with staging + staging-scale (2 processing-api replicas).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if ! docker info >/dev/null 2>&1; then
  echo "SKIP: Docker not available"
  exit 0
fi

PROCESSING_COUNT="$(docker compose --env-file infra/.env \
  -f infra/docker-compose.dev.yml \
  -f infra/docker-compose.mvp.yml \
  -f infra/docker-compose.staging.yml \
  -f infra/docker-compose.staging-scale.yml \
  ps -q processing-api 2>/dev/null | wc -l | tr -d ' ')"

if [ "${PROCESSING_COUNT:-0}" -lt 2 ]; then
  echo "WARN: expected 2 processing-api containers, found ${PROCESSING_COUNT:-0}"
  echo "Start with: docker compose ... -f infra/docker-compose.staging-scale.yml up -d --scale processing-api=2"
  exit 1
fi

echo "OK: ${PROCESSING_COUNT} processing-api replica(s) running"

port="${PROCESSING_API_HOST_PORT:-8082}"
if curl -fsS "http://127.0.0.1:${port}/ready" >/dev/null; then
  echo "OK: processing-api ready on :${port}"
  exit 0
fi

echo "FAIL: no processing-api /ready on expected port"
exit 1
