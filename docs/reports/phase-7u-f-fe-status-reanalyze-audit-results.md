# Phase 7U-F FE Status / Re-analyze Audit Results

## Files Inspected

- `FE-Audiomind/src/components/features/MeetingHistoryScene.tsx`
- `FE-Audiomind/src/components/features/FeatureAnalysis.tsx`
- `FE-Audiomind/src/components/analysis/AnalysisPanel.tsx`
- `FE-Audiomind/src/components/analysis/AnalysisSection.tsx`
- `FE-Audiomind/src/services/api.ts`
- `FE-Audiomind/src/types/index.ts`
- `FE-Audiomind/package.json`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/JobStateStore.java`
- `demoRecordAUDIOMID/ai-service/app/main.py`
- `demoRecordAUDIOMID/ai-service/app/schemas.py`
- `demoRecordAUDIOMID/ai-service/app/models.py`
- `demoRecordAUDIOMID/ai-service/app/services/analysis_runs.py`
- `docs/specs/phase-7u-analysis-cache-canonical-version-policy.md`
- `docs/reports/phase-7u-analysis-cache-audit-results.md`

CodeGraph was used first for the requested queries. This polish pass uses `rtk` for the requested docs-only git validation.

## FE Route/Component Findings

- Meeting detail lives in `MeetingHistoryScene`.
- The scene owns selected meeting state, detail loading, transcript export, report export, rename, and delete actions.
- Detail load runs `getMeetingDetail`, `getTranscript`, and `getSavedAnalysis` in parallel.
- `getSavedAnalysis` is already the read-only endpoint and is the correct initial-load base for 7U-F.
- The local detail model has `analysis`, `analysisState`, and `analysisError`, but no first-class metadata object.
- `DetailAnalysisState` is limited to `idle`, `processing`, `completed`, `failed`, and `missing`.
- `getAnalysisStateFromResponse` uses `analysis.status` and structured content presence. It does not inspect `analysisStatus`, `cacheHit`, `stale`, `staleReason`, provider/model, canonical transcript metadata, or retry-after.
- `FeatureAnalysis` can display a simple `statusLabel`, but meeting history detail does not currently use a dedicated analysis status panel.
- `AnalysisPanel` renders content/loading/empty states, not cache/freshness metadata.

## API Client Findings

- `getAnalysis(meetingId)` calls `${API_BASE}/processing/{meetingId}/analysis`.
  - This endpoint can trigger lazy provider analysis through processing-service.
  - It should not be used for meeting detail initial load or provider-safe polling.
- `getSavedAnalysis(meetingId)` calls `${API_BASE}/processing/{meetingId}/analysis/saved`.
  - This is the current provider-safe detail API.
- `getSavedAnalysis` normalizes analysis content and preserves only `status` explicitly after normalization.
- `AiAnalysis` does not currently type the full 7U metadata set.
- `getProcessingStatus(meetingId)` calls `${API_BASE}/processing/status/{meetingId}` and returns job status fields.
- `pollWithRetry` exists in both `src/services/api.ts` and `src/app/App.tsx`, but it polls processing status rather than analysis metadata.
- No FE API helper for Re-analyze/rerun was found.

## Backend Endpoint Findings

- Processing controller:
  - `GET /{meetingId}/analysis` calls `processingService.getAnalysis(...)`.
  - `GET /{meetingId}/analysis/saved` calls `processingService.getAnalysisReadOnly(...)`.
  - `GET /{meetingId}/status` returns processing status.
- `ProcessingService.getAnalysisInternal(..., allowLazyTrigger=false)` returns job-state/AI-service analysis data or status/retry metadata without starting lazy analysis.
- `ProcessingService.getAnalysisInternal(..., allowLazyTrigger=true)` can call `maybeTriggerRealtimeAnalysisLazy`, which can start provider work.
- `AIServiceClient.getSavedAnalysisCacheOnly` posts to AI-service `/api/internal/realtime-analysis` with `mode=cache_only`, but this is currently used by DOCX/report fallback, not FE detail.
- AI-service exposes `POST /api/meeting/{meeting_id}/analysis/rerun`.
  - It accepts `AnalysisRerunRequest` with `mode` defaulting to `force`.
  - It calls the realtime analysis path with `source="rerun"`.
  - It returns `AnalysisResponse` with 7U metadata fields.
- `AnalysisResponse` and `RealtimeTranscriptAnalysisResponse` include the required metadata fields: `analysisStatus`, `cacheHit`, `provider`, `model`, `canonicalTranscriptHash`, `canonicalTranscriptVersion`, `analysisInputMode`, `lastAnalyzedAt`, `stale`, `staleReason`, and `retryAfterSeconds`.
- Audit did not find a processing-service public rerun proxy for FE.

## Current Gaps

- FE does not type or preserve all 7U analysis metadata.
- FE status model cannot represent `STALE`, `RATE_LIMITED`, or `QUOTA_BLOCKED`.
- Meeting detail does not render provider/model/cache/freshness metadata.
- There is no Re-analyze button or FE rerun request helper.
- There is no local polling lifecycle for analysis metadata after rerun.
- Existing polling helpers are processing-job oriented, not analysis-status oriented.
- The FE-safe rerun contract is missing if `POST /processing/{meetingId}/analysis/rerun` is still absent at implementation time.
- `getAnalysis` remains dangerous for provider-safe detail polling because it can lazy-trigger provider analysis.

## Implementation Blocker / First Slice

The only rerun route found by CodeGraph is AI-service `POST /api/meeting/{meeting_id}/analysis/rerun`. FE should not call that service directly.

Recommended first 7U-F implementation slice:

- Confirm whether a public processing/gateway rerun proxy exists.
- If absent, add `POST /processing/{meetingId}/analysis/rerun`.
- The proxy should call existing AI-service `POST /api/meeting/{meeting_id}/analysis/rerun`.
- The proxy should forward trace/auth context consistently with existing processing-service analysis endpoints.
- The minimal FE request body should be `{ "mode": "force", "reason": "manual_reanalyze" }`.
- The proxy should return the same normalized analysis response shape and 7U metadata expected from saved analysis.

This resolves the previous open question into an implementation decision: include the small backend proxy in 7U-F before wiring the FE Re-analyze button if the proxy is still absent.

## Recommended Implementation Order

1. Add or confirm the backend-facing FE contract for rerun: `POST /processing/{meetingId}/analysis/rerun`.
2. Add FE metadata types and a normalization helper that preserves all required fields.
3. Add API helpers:
   - `getSavedAnalysisMetadata` or extend `getSavedAnalysis`.
   - `reanalyzeMeetingAnalysis(meetingId, { mode: 'force', reason: 'manual_reanalyze' })` against the processing/gateway route only.
4. Add `AnalysisStatusPanel` as a small component with status badge, metadata rows, disabled button logic, and inline error.
5. Wire the panel into `MeetingHistoryScene`.
6. Add rerun action and provider-safe polling against `analysis/saved`.
7. Add focused Vitest coverage for status rendering, metadata preservation, disabled states, rerun body, polling stop conditions, cleanup, and initial-load safety.

## First Implementation PR Scope

Recommended first PR for 7U-F:

- Backend rerun proxy if `POST /processing/{meetingId}/analysis/rerun` is still absent.
- FE API/types/component work once the rerun proxy contract exists or is confirmed.
- Add the analysis metadata type and normalizer.
- Preserve metadata from `getSavedAnalysis`.
- Add `AnalysisStatusPanel`.
- Wire the panel into meeting detail using existing saved analysis data.
- Add the rerun helper only against the confirmed backend route.
- Add polling cleanup logic if rerun route is available.
- Add Vitest tests for the status panel and API helper.

If the implementation work must be split across PRs, keep the dependency order explicit:

- 7U-F-A0: backend rerun proxy.
- 7U-F-A1: metadata typing, normalizer, status panel, initial read-only display.
- 7U-F-A2: rerun API helper, action, and polling after the backend route lands.

## Risks

- Using `GET /processing/{meetingId}/analysis` for polling would violate the no-provider-trigger requirement.
- Calling AI-service directly from FE would bypass the existing FE/gateway ownership and auth shape.
- Metadata may be silently lost if `normalizeAnalysisResponse` continues to return only content fields.
- Stale analysis can be misrepresented as completed if FE prefers `status` over `analysisStatus`/`stale`.
- Polling can update the wrong meeting if the user switches selection during an in-flight rerun.
- Rate-limit and quota states need exact backend error-code mapping before polished badge behavior.

## Open Questions

- Should backend later expose a dedicated read-only analysis status endpoint, or is `GET /processing/{meetingId}/analysis/saved` sufficient long term?
- Which backend `errorCode` values should map to `RATE_LIMITED` versus `QUOTA_BLOCKED`?
- Should stale completed analysis remain visible with a `STALE` badge, or should the content panel show an explicit stale empty state?
- Should Re-analyze be allowed from `NO_ANALYSIS` when transcript is ready but no analysis exists?
- Should the UI include a reason field later, or keep `reason="manual_reanalyze"` hidden in this minimal slice?

## Proposed 7U-F Implementation Slices

- 7U-F-A0: Backend rerun proxy if needed.
- 7U-F-A: FE API client methods and types.
- 7U-F-B: `AnalysisStatusPanel` component.
- 7U-F-C: Wire into meeting detail/history detail.
- 7U-F-D: Re-analyze action and polling cleanup.
- 7U-F-E: Tests and final FE smoke.

## Validation Plan

Docs-only validation for this task:

- `git diff --check`
- `git status --short --branch`

No npm/Vitest run is required because this task does not implement runtime code.
