## Summary

Completes Phase 1: subject management and per-meeting Education analysis.

## Main changes

- Study folders and subjects CRUD/archive
- Subject assignment for realtime, upload, history, and unclassified meetings
- Education-specific structured AI analysis
- Multi-segment transcript evidence navigation
- Session/attempt/domain-scoped saved analysis
- Realtime Education analysis and stale-cache protection
- Unclassified meetings sorted newest-first
- OpenAPI verification migrated to recursive-ref-compatible oasdiff
- Realtime Education domain intent is persisted into processing job-state, allowing scoped saved-analysis requests to hit job-state without unnecessary AI fallback

## Verification

- Phase 1 acceptance criteria: 55 DONE / 0 PARTIAL
- Processing-service: 340 passed, exit 0
- Meeting-service: 131 passed
- AI full suite: 480 passed, 23 skipped
- AI Education focused: 41 passed
- Frontend evidence tests: 35 passed
- Unclassified meetings tests: 5 passed
- Frontend build: passed
- Root lint: passed
- OpenAPI validation/diff/client drift: passed
- Fresh realtime Education smoke: passed
- Deterministic realtime evidence verification: passed

## Fresh realtime Education evidence

- New realtime meeting and new transcript
- `domainMode=education`
- `educationStudy` returned
- `promptVersion=education-analysis-v1`
- `schemaVersion=education-study-v1`
- `analysisFeatureSet=education-study-v1`

## Notes

- No database-destructive operations
- No Git Stage B cleanup
- Verification logs are redacted and stored locally under `logs/phase1-verification/` (gitignored)
- Fast-path hardening: AI completed-analysis job-state writes now merge `domainMode` + recording session/attempt provenance instead of replacing the result map
