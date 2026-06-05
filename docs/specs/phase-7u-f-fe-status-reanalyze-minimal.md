# Phase 7U-F: FE Status / Re-analyze Minimal

## Problem Statement

Meeting detail currently loads saved transcript and saved analysis, but the FE only models analysis as `idle`, `processing`, `completed`, `failed`, or `missing`. Backend work from 7U-B through 7U-E now exposes richer analysis cache and freshness metadata, including cache hits, stale state, provider/model identity, canonical transcript identity, and retry guidance. The FE does not yet surface that information, and there is no minimal manual Re-analyze control in meeting detail.

Users need to understand whether analysis is fresh, missing, stale, rate-limited, quota-blocked, or currently analyzing. They also need a safe Re-analyze path that asks the backend to run `mode=force` without the FE calling Gemini or any provider directly.

## Goals

- Show clear analysis status in meeting detail.
- Surface minimal metadata: `analysisStatus`, `cacheHit`, `stale`, `staleReason`, `provider`, `model`, `promptVersion`, `schemaVersion`, `canonicalTranscriptHash`, `canonicalTranscriptVersion`, `analysisInputMode`, `lastAnalyzedAt`, and `retryAfterSeconds`.
- Add a minimal Re-analyze button.
- Send Re-analyze through a backend API with `mode=force`.
- Keep meeting detail initial load read-only/cache-only and provider-safe.
- Poll lightly after Re-analyze until a terminal analysis state is reached.
- Reuse existing FE services, types, and meeting detail layout where practical.

## Non-goals

- No large FE redesign.
- No transcript search.
- No paragraph mode.
- No analysis history timeline or compare UI.
- No export/DOCX logic changes.
- No backend cache/rerun algorithm changes beyond a small processing-service rerun proxy contract if it is missing.
- No Docker, deploy, or environment-file work.
- No direct Gemini/provider calls from FE.
- No changes to 7Q canonical transcript logic, 7S speaker stabilization, or 7U-E export fallback behavior.

## Current FE Flow Summary

- Meeting detail is implemented in `FE-Audiomind/src/components/features/MeetingHistoryScene.tsx`.
- The detail load runs `Promise.all` over:
  - `getMeetingDetail(selectedMeetingId)`
  - `getTranscript(selectedMeetingId)`
  - `getSavedAnalysis(selectedMeetingId)`
- `getSavedAnalysis` calls `${API_BASE}/processing/{meetingId}/analysis/saved`.
- `getAnalysisStateFromResponse` maps saved analysis into `DetailAnalysisState = 'idle' | 'processing' | 'completed' | 'failed' | 'missing'`.
- `FeatureAnalysis` and `AnalysisPanel` display the structured analysis content, but there is no dedicated status/metadata panel.
- Existing FE `AiAnalysis` type contains content fields plus `status`, `promptVersion`, `schemaVersion`, and transcript hash fields, but it does not yet type the full 7U metadata set.
- `getProcessingStatus` and `pollWithRetry` exist for processing-job polling, but they are job-status oriented and do not currently poll the analysis metadata contract.
- FE tests use Vitest for unit/component tests and Playwright for e2e.

## Current Backend/API Flow Summary

- Processing-service exposes `GET /processing/{meetingId}/analysis`.
  - This calls `ProcessingService.getAnalysis(..., allowLazyTrigger=true)`.
  - If no saved analysis is found, this path can trigger lazy realtime analysis and therefore can call the provider.
- Processing-service exposes `GET /processing/{meetingId}/analysis/saved`.
  - This calls `ProcessingService.getAnalysisReadOnly(..., allowLazyTrigger=false)`.
  - This is the correct initial meeting-detail read path because it does not intentionally trigger provider work.
- Processing-service exposes `GET /processing/status/{meetingId}` for processing status.
- AI-service exposes `POST /api/meeting/{meeting_id}/analysis/rerun`.
  - Request model is `AnalysisRerunRequest` with `mode` defaulting to `force` and optional `reason`.
  - The route resolves transcript text, calls the realtime analysis path with `source="rerun"` and the requested mode, and returns `AnalysisResponse`.
- AI-service supports `auto`, `cache_only`, `force`, and `failed_retry` modes in analysis flow.
- Processing-service already has a cache-only internal client path for DOCX fallback, but audit did not find a public processing-service rerun proxy.

## Recommended API Decision

7U-F should standardize FE Re-analyze on the processing/gateway surface, not on the AI-service surface.

If the route does not already exist at implementation time, 7U-F should include a small backend proxy as the first slice:

`POST /processing/{meetingId}/analysis/rerun`

Request:

```json
{
  "mode": "force",
  "reason": "manual_reanalyze"
}
```

Decision details:

- FE must call only the processing/gateway route for manual Re-analyze.
- FE must never call AI-service directly.
- The processing-service proxy should forward trace/auth context and call existing AI-service `POST /api/meeting/{meeting_id}/analysis/rerun`.
- The proxy request must send `mode="force"` and `reason="manual_reanalyze"` for the minimal manual button.
- The proxy response should preserve the same normalized analysis response shape and 7U metadata returned by saved analysis.
- Initial meeting-detail load must keep using `GET /processing/{meetingId}/analysis/saved`.
- Polling after Re-analyze must use `GET /processing/{meetingId}/analysis/saved` unless backend provides a safer dedicated read-only analysis status endpoint.
- FE must not use `GET /processing/{meetingId}/analysis` for initial load or polling because that route can lazy-trigger provider work.

## Target UX

Add a small analysis status panel to meeting detail near the existing meeting actions or above the analysis content. It should be compact and informational, not a redesign.

The panel should show:

- Status badge: `NO_ANALYSIS`, `ANALYZING`, `COMPLETED`, `FAILED`, `STALE`, `RATE_LIMITED`, `QUOTA_BLOCKED`.
- Metadata rows for `provider`, `model`, `lastAnalyzedAt`, `cacheHit`, and `staleReason`.
- Optional collapsed or low-emphasis rows for `promptVersion`, `schemaVersion`, `canonicalTranscriptHash`, `canonicalTranscriptVersion`, and `analysisInputMode`.
- Re-analyze button.
- Inline error text for request failures.

Button disabled states:

- Disabled while status is `ANALYZING`.
- Disabled while a Re-analyze request is pending.
- Disabled for `RATE_LIMITED` when `retryAfterSeconds` is present and greater than zero.

On click:

- Optimistically set local status to `ANALYZING`.
- Call backend with `mode=force`.
- Poll the provider-safe saved-analysis/read-only status endpoint lightly until a terminal state is reached.
- Refresh the visible analysis payload when polling returns `COMPLETED`.

## Analysis Status Model

FE should introduce a typed status union for display:

```ts
type AnalysisStatus =
  | 'NO_ANALYSIS'
  | 'ANALYZING'
  | 'COMPLETED'
  | 'FAILED'
  | 'STALE'
  | 'RATE_LIMITED'
  | 'QUOTA_BLOCKED'
```

Normalization rules:

- Prefer `analysisStatus` when present.
- If `stale === true`, display `STALE` unless the backend status is an active or blocking state.
- Map backend `status` values `RUNNING`, `QUEUED`, `PENDING`, `ANALYZING`, or `skipped` with `reason=in_progress` to `ANALYZING`.
- Map `NOT_FOUND`, missing structured content, and no `analysisStatus` to `NO_ANALYSIS`.
- Map `retryAfterSeconds > 0` with a rate-limit error code to `RATE_LIMITED`.
- Map quota-oriented error codes to `QUOTA_BLOCKED`.
- Treat `COMPLETED` as terminal and render content when structured analysis exists.
- Treat `FAILED`, `RATE_LIMITED`, `QUOTA_BLOCKED`, `NO_ANALYSIS`, and `STALE` as terminal for polling purposes unless a new Re-analyze request is sent.

Minimal metadata type:

```ts
type AnalysisMetadata = {
  analysisStatus: AnalysisStatus
  cacheHit?: boolean
  stale?: boolean
  staleReason?: string | null
  provider?: string | null
  model?: string | null
  promptVersion?: string | null
  schemaVersion?: string | null
  canonicalTranscriptHash?: string | null
  canonicalTranscriptVersion?: string | null
  analysisInputMode?: string | null
  lastAnalyzedAt?: string | null
  retryAfterSeconds?: number | null
}
```

## API Contract Proposal

Initial read:

`GET /processing/{meetingId}/analysis/saved`

- Must remain provider-safe.
- Used when opening meeting detail.
- Returns structured analysis if current cached analysis is available.
- Returns metadata-only or empty-content response for `NO_ANALYSIS`, `STALE`, `RATE_LIMITED`, or `QUOTA_BLOCKED`.

Manual Re-analyze:

`POST /processing/{meetingId}/analysis/rerun`

Request:

```json
{
  "mode": "force",
  "reason": "manual_reanalyze"
}
```

Response:

- Same normalized analysis response shape as `GET /processing/{meetingId}/analysis/saved`.
- Includes all minimal metadata fields.
- May return `ANALYZING`, `COMPLETED`, `FAILED`, `RATE_LIMITED`, or `QUOTA_BLOCKED`.

Polling:

Preferred:

`GET /processing/{meetingId}/analysis/saved`

- Provider-safe and reads durable/cache metadata only.
- Used after the force request to observe completion.
- Use a safer dedicated read-only analysis status endpoint only if backend exposes one before FE wiring.

## Polling / Request Lifecycle

- Initial detail load calls only read-only APIs.
- Re-analyze click creates an `AbortController` or equivalent cancellation guard.
- Set local `analysisStatus` to `ANALYZING` and clear previous inline error.
- Send `POST /processing/{meetingId}/analysis/rerun` with `{ mode: 'force', reason: 'manual_reanalyze' }`.
- If the response is terminal, update analysis and stop polling.
- If the response is non-terminal, poll `GET /processing/{meetingId}/analysis/saved`.
- Suggested polling interval: 2 seconds initially, then 3 to 5 seconds after a few attempts.
- Suggested cap: 60 seconds or 20 attempts for the first FE slice.
- Stop polling on `COMPLETED`, `FAILED`, `RATE_LIMITED`, `QUOTA_BLOCKED`, unmount, meeting change, or a newer Re-analyze request.
- Preserve the last known completed analysis content while showing an `ANALYZING` status during rerun, unless backend explicitly returns no content and product wants a blank state.

## Component Plan

- Add `AnalysisStatusPanel` under `FE-Audiomind/src/components/analysis/` or near `MeetingHistoryScene` if it remains private to the scene.
- Props:
  - `metadata: AnalysisMetadata`
  - `busy: boolean`
  - `error?: string | null`
  - `onReanalyze: () => void`
- Keep layout compact:
  - One badge row.
  - Three to five primary metadata rows.
  - Re-analyze button.
  - Optional small technical metadata group.
- Reuse existing visual primitives/classes where possible, such as `meta-pill` and existing error presentation.
- Avoid adding a broad design system in this slice.

## State Management Plan

- Extend `AiAnalysis` or add a companion `AnalysisMetadata` type in `FE-Audiomind/src/types/index.ts`.
- Extend `SelectedMeetingDetail` with:
  - `analysisMetadata`
  - `reanalyzePending`
  - `reanalyzeError`
  - optional `analysisPollRequestId`
- Keep `analysis` as the content payload for existing `AnalysisPanel`.
- Normalize metadata once in the API client or a small utility so `MeetingHistoryScene` does not duplicate response-shape parsing.
- Keep polling local to meeting detail for 7U-F. Do not introduce a global store.

## Error / Rate Limit Handling

- Show inline API errors in the status panel.
- If backend returns `retryAfterSeconds`, display it and disable Re-analyze until the timer expires or the meeting detail is refreshed.
- If force rerun returns rate/quota errors, keep previous analysis content visible if it exists and update status to `RATE_LIMITED` or `QUOTA_BLOCKED`.
- Treat abort/unmount as silent cleanup, not a user-visible failure.
- Preserve trace IDs from `ApiError` in console diagnostics only unless the existing UI has a trace display convention.

## Test Plan

Use Vitest for component/API-unit coverage. Add Playwright only if a later implementation slice changes route-level behavior enough to justify e2e coverage.

Required tests:

- Render `COMPLETED` badge.
- Render `STALE` with `staleReason`.
- `RATE_LIMITED` disables the Re-analyze button.
- Clicking Re-analyze sends `mode=force`.
- Status becomes `ANALYZING` while request is pending.
- Polling stops on `COMPLETED`.
- Polling stops on `FAILED`.
- Polling stops on `RATE_LIMITED`.
- Cleanup aborts polling on unmount or meeting change.
- API failure displays an inline error.
- Opening meeting detail does not call provider-triggering analysis endpoint.

Recommended API helper tests:

- `getSavedAnalysis` preserves all minimal metadata fields.
- New rerun helper posts the expected body.
- Metadata normalization maps legacy `status` values into display statuses.

## Implementation Slices

- 7U-F-A0: Backend rerun proxy contract if needed.
  - Confirm whether `POST /processing/{meetingId}/analysis/rerun` already exists.
  - If absent, add the small processing-service/gateway proxy before FE Re-analyze wiring.
  - Proxy to AI-service `POST /api/meeting/{meeting_id}/analysis/rerun`.
  - Forward trace/auth context consistently with existing processing-service analysis endpoints.
  - Accept and send `{ mode: 'force', reason: 'manual_reanalyze' }`.
  - Return the same normalized analysis response shape and 7U metadata used by saved analysis.
- 7U-F-A: FE API client methods and types.
  - Add metadata types.
  - Preserve metadata in `normalizeAnalysisResponse` or a companion normalizer.
  - Add `reanalyzeMeetingAnalysis(meetingId, { mode: 'force', reason: 'manual_reanalyze' })` against the processing/gateway route only.
- 7U-F-B: `AnalysisStatusPanel` component.
  - Render badges, key metadata, disabled button states, and inline errors.
- 7U-F-C: Wire into meeting detail/history detail.
  - Use read-only saved analysis metadata on initial load.
  - Keep content rendering unchanged.
- 7U-F-D: Re-analyze action and polling cleanup.
  - Add force request.
  - Poll saved analysis metadata.
  - Stop on terminal states and cleanup on unmount/meeting change.
- 7U-F-E: Tests and final FE smoke.
  - Add Vitest coverage for status panel, API helpers, and lifecycle.
  - Run FE build/test checks as implementation changes require.

## Acceptance Criteria

- Meeting detail shows a visible analysis status badge.
- Meeting detail shows provider, model, last analyzed time, cache hit state, and stale reason when available.
- Full minimal metadata is available in FE state and can be rendered/debugged.
- Opening meeting detail uses read-only/cache-only metadata and does not trigger provider analysis.
- FE never uses provider-triggering `GET /processing/{meetingId}/analysis` for initial load or polling.
- Re-analyze button sends a processing/gateway backend request.
- Re-analyze request body uses `mode="force"`.
- Re-analyze request body uses `reason="manual_reanalyze"` for this minimal slice.
- FE never calls AI-service directly.
- FE never calls Gemini/provider endpoints directly.
- Button is disabled while analyzing, pending, or rate-limited with retry-after.
- Polling starts after Re-analyze and stops on terminal status.
- Polling is aborted on unmount or meeting change.
- Existing analysis content display remains intact.
- Tests cover the required status, button, polling, error, and no-provider-trigger cases.

## Risks / Rollback Plan

- Risk: FE wires to provider-triggering `GET /processing/{meetingId}/analysis` for polling.
  - Mitigation: Poll `analysis/saved` unless backend explicitly provides another provider-safe status endpoint.
- Risk: No processing-service rerun proxy exists yet.
  - Mitigation: make 7U-F-A0 the first implementation slice and add the small proxy before FE rerun wiring.
- Risk: Existing `normalizeAnalysisResponse` drops unknown metadata.
  - Mitigation: add a companion metadata normalizer and tests before rendering.
- Risk: Polling keeps running after meeting switch.
  - Mitigation: use request IDs and abort/cleanup in the effect/action lifecycle.
- Rollback: remove the status panel wiring and rerun helper while keeping backend read-only analysis behavior unchanged. If 7U-F-A0 added the proxy, remove that route/client method as well. No database rollback is expected.

## Remaining Open Questions

- Should backend later add a dedicated read-only analysis status endpoint, or is `GET /processing/{meetingId}/analysis/saved` sufficient long term?
- What exact backend error codes distinguish `RATE_LIMITED` from `QUOTA_BLOCKED` in the FE contract?
- Should the panel show stale completed analysis content, or hide content when status is `STALE`?
- Should `retryAfterSeconds` be decremented client-side or only displayed as returned by the backend?
- Should `canonicalTranscriptHash` be truncated in the default UI with full value available in a tooltip/copy action?
