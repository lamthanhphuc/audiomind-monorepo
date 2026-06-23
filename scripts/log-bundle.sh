#!/usr/bin/env bash
# Epic 3 log bundle patterns (Slice 7)
EPIC3_PATTERN='TRANSCRIPT_QUALITY_|EVIDENCE_QA_|SEARCH_QUERY_LIMITED|TRANSCRIPT_SEARCH_REJECTED|EXPORT_VERIFY_|DOMAIN_LEXICON_|POLICY_LOAD_FALLBACK|BACKFILL_PROGRESS'

if [[ -n "${LOG_FILE:-}" ]]; then
  grep -E "$EPIC3_PATTERN" "$LOG_FILE" || true
else
  echo "Set LOG_FILE to scan Epic 3 markers"
  exit 1
fi
