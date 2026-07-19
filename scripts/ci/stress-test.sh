#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "=== AI-service STT stress (sequential chunks) ==="
pip install -q -r demoRecordAUDIOMID/ai-service/requirements.txt \
  -r demoRecordAUDIOMID/ai-service/requirements-dev.txt
cd demoRecordAUDIOMID/ai-service
python -m pytest tests/stress/test_stt_stress.py -q

echo "STRESS: PASS"
