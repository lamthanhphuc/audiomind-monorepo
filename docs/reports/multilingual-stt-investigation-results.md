# Phase 7F Multi en+vi STT Investigation Results

- Date: 2026-05-28
- Branch: `chore/multilingual-stt-investigation-spec`
- Scope: backend STT diagnostics and multilingual behavior validation for upload/realtime (`vi`, `en`, `multi`) plus realtime analysis guard reliability.

## Summary

- Upload flow supports `vi`, `en`, and `multi` successfully.
- Realtime flow works for `vi`, `en`, and `multi` at protocol level.
- Realtime `multi` quality is unstable in mixed-language speech and can produce wrong-language output.
- Realtime analysis post-stop reliability issue is fixed by guard ownership and stale/foreign lock recovery.

## Upload Results

- `vi`: pass
- `en`: pass
- `multi`: pass

## Realtime Results

- `vi`: pass, transcript saved, analysis completed and visible.
- `en`: pass, transcript saved, analysis completed and visible.
- `multi`: technical pass, transcript saved, analysis completed and visible, but quality unstable in mixed vi+en speech with wrong-language output observed.

## Diagnostic Logging Implemented

- Batch:
  - `BATCH_STT_DIAGNOSTIC_START`
  - `BATCH_STT_DIAGNOSTIC_CONFIG`
  - `BATCH_STT_DIAGNOSTIC_COMPLETED`
  - `BATCH_STT_DIAGNOSTIC_FAILED`
- Realtime:
  - `REALTIME_STT_DIAGNOSTIC_START`
  - `REALTIME_STT_DIAGNOSTIC_CONFIG`
  - `REALTIME_STT_SEGMENT_FINAL`
  - `REALTIME_STT_DIAGNOSTIC_COMPLETED`
  - `REALTIME_STT_DIAGNOSTIC_FAILED`

## Safety and Logging Boundaries

- Full transcript text is not logged in diagnostics.
- API keys, auth tokens, and raw provider payloads are not logged.
- Correlation relies on trace/request/meeting IDs and short hash prefixes.

## Realtime Analysis Fix (Post-stop)

- Confirmed root cause: Redis guard ownership conflict between `processing-api` and `ai-api`.
- Previous behavior:
  - `processing-api` set `analysis:lock:*` and `analysis:state:*` to running before `ai-api` execution.
  - first `ai-api` realtime-analysis request could return `skipped/in_progress` even when no analysis task had run.
- Implemented fix:
  - ai-api-owned lock token prefix and state owner marker.
  - stale/foreign/orphan lock and running-state recovery.
  - retry path to allow real execution instead of endless `in_progress`.
- Verification probe on meeting `17` after fix:
  - first `POST /api/internal/realtime-analysis`: `completed`
  - second `POST`: `skipped/already_exists`
  - `GET /api/meeting/17/analysis`: `200`, `COMPLETED`

## 7G Recommendation

- Do not default realtime STT to `multi`.
- Keep explicit language selection (`vi` / `en` / `multi`).
- Prefer explicit `vi` or `en` for demo reliability.
- Use upload `multi` only when mixed-language capture is explicitly needed.

## Notes

- No FE changes in this phase.
- No STT routing/default/model/language parameter changes were introduced in this phase.
- No raw transcript or PII is included in this report.
