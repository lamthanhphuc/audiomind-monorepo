#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SAMPLE_LOG="$(mktemp)"
trap 'rm -f "$SAMPLE_LOG"' EXIT

cat >"$SAMPLE_LOG" <<'EOF'
event=UPLOAD_VALIDATION_REJECTED errorCode=UPLOAD_TOO_LARGE traceId=abc123
event=UPLOAD_MIME_MISMATCH traceId=def456
event=REALTIME_VALIDATION_FAILED errorCode=REALTIME_INVALID_PAYLOAD meetingId=9
event=REALTIME_VALIDATION_ACCEPTED meetingId=9 seq=1
event=REALTIME_CHUNK_TOO_LARGE meetingId=9 seq=2
event=UPLOAD_SCAN_SKIPPED traceId=ghi789
event=UPLOAD_SCAN_PASSED traceId=jkl012
event=UPLOAD_SCAN_FAILED traceId=mno345
event=UPLOAD_SCAN_INFRA_ERROR traceId=pqr678
event=UPLOAD_SCAN_CIRCUIT_OPEN traceId=stu901
noise line without markers should be ignored
EOF

PATTERN='UPLOAD_VALIDATION_|MIME_MISMATCH|REALTIME_VALIDATION_|UPLOAD_SCAN_|UPLOAD_SCAN_CIRCUIT_OPEN'
MATCHES="$(grep -E "$PATTERN" "$SAMPLE_LOG" | wc -l | tr -d ' ')"

if [[ "$MATCHES" -lt 9 ]]; then
  printf 'Expected at least 9 Epic 2 log markers, found %s\n' "$MATCHES" >&2
  exit 1
fi

printf 'Epic 2 log-bundle pattern smoke passed (%s markers)\n' "$MATCHES"
