#!/usr/bin/env bash
# Generate export golden files from meeting-golden.json (Epic 3 Slice 6)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="${1:-$ROOT/demoRecordAUDIOMID/processing-service/src/test/resources/fixtures/meeting-golden.json}"
OUT_DIR="$ROOT/demoRecordAUDIOMID/processing-service/src/test/resources/export-golden"
mkdir -p "$OUT_DIR"
cp "$FIXTURE" "$OUT_DIR/meeting-golden.snapshot.json"
echo "Wrote $OUT_DIR/meeting-golden.snapshot.json"
