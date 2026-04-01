#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --verify origin/main >/dev/null 2>&1; then
  git fetch origin main
fi

specs=(
  "meeting-api.yaml"
  "processing-api.yaml"
  "ai-api.yaml"
)

for spec in "${specs[@]}"; do
  current="packages/contracts/${spec}"
  baseline="$(mktemp)"

  if ! git show "origin/main:packages/contracts/${spec}" > "${baseline}" 2>/dev/null; then
    echo "No baseline file found on origin/main for ${spec}. Skipping breaking check for this spec."
    rm -f "${baseline}"
    continue
  fi

  npx openapi-diff "${baseline}" "${current}" --fail-on-incompatible
  rm -f "${baseline}"
done
