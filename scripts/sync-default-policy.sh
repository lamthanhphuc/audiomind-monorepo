#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIMARY_POLICY="${ROOT}/packages/contracts/transcript-quality-policy.json"
DEFAULT_POLICY="${ROOT}/packages/contracts/default-policy.json"
FE_DEFAULTS="${ROOT}/FE-Audiomind/src/config/transcriptQualityDefaults.json"
FE_FALLBACK="${ROOT}/FE-Audiomind/src/config/fallback-policy.ts"
PROCESSING_PRIMARY="${ROOT}/demoRecordAUDIOMID/processing-service/src/main/resources/transcript-quality-policy.json"
PROCESSING_DEFAULT="${ROOT}/demoRecordAUDIOMID/processing-service/src/main/resources/default-policy.json"

if [[ ! -f "${PRIMARY_POLICY}" ]]; then
  echo "Missing ${PRIMARY_POLICY}" >&2
  exit 1
fi

if [[ ! -f "${DEFAULT_POLICY}" ]]; then
  echo "Missing ${DEFAULT_POLICY}" >&2
  exit 1
fi

mkdir -p "$(dirname "${FE_DEFAULTS}")"
cp "${PRIMARY_POLICY}" "${PROCESSING_PRIMARY}"
cp "${DEFAULT_POLICY}" "${PROCESSING_DEFAULT}"
cp "${DEFAULT_POLICY}" "${FE_DEFAULTS}"

node "${ROOT}/scripts/generate-fallback-policy.mjs" "${DEFAULT_POLICY}" "${FE_FALLBACK}"

echo "Synced transcript quality policy:"
echo "  primary -> processing-service/transcript-quality-policy.json"
echo "  default -> processing-service/default-policy.json + FE bundle + fallback-policy.ts"
