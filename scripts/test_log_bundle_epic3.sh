#!/usr/bin/env bash
set -euo pipefail

TMP_LOG="$(mktemp)"
cat >"$TMP_LOG" <<'EOF'
event=TRANSCRIPT_QUALITY_CANONICAL_PERSISTED meetingId=1
event=TRANSCRIPT_QUALITY_NOT_READY meetingId=1
event=TRANSCRIPT_QUALITY_VERSION_MISMATCH meetingId=1
event=TRANSCRIPT_QUALITY_IDEMPOTENT_SKIP meetingId=1
event=TRANSCRIPT_QUALITY_SKIP_NO_RUN meetingId=1
event=EVIDENCE_QA_VERIFIED meetingId=1
event=EVIDENCE_QA_WEAK meetingId=1
event=EVIDENCE_QA_STATS_MISSING meetingId=1
event=EVIDENCE_QA_DEDUPED meetingId=1
event=SEARCH_QUERY_LIMITED meetingId=1
event=EXPORT_VERIFY_COMPLETED meetingId=1
event=DOMAIN_LEXICON_COLLISION term=hop_dong
event=POLICY_LOAD_FALLBACK path=policy.json
event=BACKFILL_PROGRESS meetingId=1
EOF

export LOG_FILE="$TMP_LOG"
bash "$(dirname "$0")/log-bundle.sh" | wc -l | awk '{ if ($1 >= 10) exit 0; exit 1 }'
rm -f "$TMP_LOG"
