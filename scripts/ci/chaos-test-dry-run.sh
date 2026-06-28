#!/usr/bin/env bash
# Validates chaos-test.sh prerequisites without a live cluster (CI safe).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

test -f scripts/chaos-test.sh || { echo "missing scripts/chaos-test.sh"; exit 1; }
test -f k8s/chaos/network-fault.yaml || { echo "missing k8s/chaos/network-fault.yaml"; exit 1; }

if command -v kubectl >/dev/null 2>&1 && kubectl cluster-info >/dev/null 2>&1; then
  echo "Cluster detected — run scripts/chaos-test.sh manually on staging."
  bash scripts/chaos-test.sh
else
  echo "CHAOS_DRY_RUN: no kubectl cluster — validated manifest paths only."
  grep -q 'meeting-api' k8s/chaos/network-fault.yaml
  echo "CHAOS_DRY_RUN: PASS"
fi
