# 7T-QA-F1 - Initial Analysis Recovery

Spec/plan only. No implementation, commit, push, deploy, Docker run, SSH, or browser smoke was performed for this phase.

## 1. Problem summary

Production QA shows the upload flow is healthy, but live/realtime recording can finish with a completed transcript and no initial analysis visible. The user can then press Re-analyze and the analysis appears.

Known runtime direction remains cloud-first:

- STT/transcription: Deepgram.
- Analysis/summarization: Gemini.
- Whisper/Ollama must not become the default runtime path.

The failure should be treated as an initial-analysis recovery problem, not as a transcript completion problem.

## 2. Reproduction notes

Observed QA behavior:

- Start realtime recording.
- Stop after enough audio to produce a transcript.
- Transcript completes and saved transcript/detail can be viewed.
- Initial analysis does not automatically appear.
- Logs previously showed Gemini 503/high demand, `REALTIME_ANALYSIS_FAILED`, and `getAnalysis` 404/NotFound or not-ready behavior during polling.
- Pressing Re-analyze later succeeds.

No fresh browser smoke or production test was run in this phase.

## 3. Current realtime recording flow

Important files:

- `FE-Audiomind/src/app/App.tsx`
- `FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts`
- `FE-Audiomind/src/services/api.ts`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/JobStateStore.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java`
- `demoRecordAUDIOMID/ai-service/app/main.py`
- `demoRecordAUDIOMID/ai-service/app/services/analysis_runs.py`

Frontend stop flow:

- `handleLiveRecordingComplete` stops the realtime stream, hydrates persisted transcript rows with `getTranscript`, merges them with live segments, then marks the lifecycle as stopped.
- After stop, `startRealtimeAnalysisPolling` calls `pollRealtimeAnalysisAfterStop`.
- `pollRealtimeAnalysisAfterStop` calls `getAnalysis(meetingId)` every 2 seconds, up to 25 attempts.
- `getAnalysis` uses the processing gateway path: `${API_BASE}/processing/${meetingId}/analysis`.
- During this polling, 404 is treated as "analysis not ready yet"; 5xx is treated as transient and polling continues.
- If polling exhausts, UI sets `liveAnalysisStatus` to `pending` and shows a retry-ish message, but it does not necessarily trigger a bounded recovery rerun.

Processing-service analysis read flow:

- `ProcessingController.analysis` delegates to `ProcessingService.getAnalysis(..., allowLazyTrigger=true)`.
- `getAnalysisInternal` first looks for analysis in job state.
- If job state has no analysis, it falls back to ai-service `GET /api/meeting/{id}/analysis`.
- If ai-service has no persisted analysis and lazy trigger is allowed, it calls `maybeTriggerRealtimeAnalysisLazy`.
- `maybeTriggerRealtimeAnalysisLazy` builds readable transcript text from job state or persisted transcript payload, creates an analysis cache key, and uses `JobStateStore.tryStartAnalysis` to avoid duplicate provider calls.
- If allowed, it runs `runLazyRealtimeAnalysis` asynchronously.
- `runLazyRealtimeAnalysis` calls ai-service `POST /api/internal/realtime-analysis` through `AIServiceClient.analyzeRealtimeTranscript`.
- It records analysis state as completed, failed, or skipped via `JobStateStore`.

Ai-service realtime analysis flow:

- `POST /api/internal/realtime-analysis` maps to `analyze_realtime_transcript`.
- It computes transcript hash, prompt version, schema version, and analysis identity.
- It checks completed analysis runs for the same identity and returns cache hits.
- It checks in-progress runs and skips duplicate work.
- It supports `cache_only`, `force`, and `failed_retry` modes.
- It calls `_analyze_and_persist_realtime_transcript` when a new provider call is allowed.
- `_analyze_and_persist_realtime_transcript` calls Gemini, normalizes and stores the analysis row, persists a completed `MeetingAnalysisRun`, updates job status with analysis, and returns completed metadata.

## 4. Current upload file flow comparison

Upload path differs in important ways:

- FE upload uses `uploadAudio`, `createMeeting`, and `processAudio`/processing start paths rather than realtime stop polling.
- Processing-service `processMeeting` calls `AIServiceClient.processAudio`, which posts `/api/process` to ai-service.
- Ai-service queues `process_meeting` through Celery.
- `tasks.process_meeting` calls `pipeline.process_meeting`, then marks job status completed with transcripts and analysis if present.
- `pipeline.process_meeting` runs STT, speaker normalization/diarization selection, then `self.ai_analyzer.analyze_meeting(formatted_transcript)`.

Key code difference:

- Batch upload uses `AIAnalyzer.analyze_meeting`.
- Realtime persistence uses `_analyze_and_persist_realtime_transcript`, which for Gemini calls `analyzer._analyze_with_gemini(...)` directly.

That matters because `analyze_meeting` catches `AnalysisUnavailableError` and returns a default structured fallback for Gemini unavailable errors, while the realtime direct Gemini call lets provider errors bubble to `analyze_realtime_transcript`, which marks the analysis run failed and returns an HTTP error.

## 5. Observed failure mode

The likely failure chain from code is:

1. Realtime transcript is saved successfully.
2. FE starts post-stop polling for `getAnalysis`.
3. Processing-service cannot find stored analysis.
4. Processing-service lazily triggers realtime analysis if transcript text is available and analysis state permits it.
5. Ai-service calls Gemini through the realtime path.
6. Gemini returns 503/high-demand/unavailable.
7. Ai-service marks the analysis run failed and returns 503.
8. Processing-service marks analysis state failed with cooldown/retryAfter.
9. FE polling sees not-ready, transient, or failure/pending states, but no automatic bounded recovery is guaranteed.
10. Transcript remains completed, but analysis is missing or failed until the user manually Re-analyzes.

## 6. Root cause hypothesis from code

Primary hypothesis:

Realtime analysis can fail independently after transcript completion because the realtime path calls Gemini directly and records a failed analysis run/state on transient provider errors. The UI polling path recognizes missing/not-ready analysis, but it mostly waits; it does not consistently convert "completed transcript + missing/failed initial analysis" into a clear recovery workflow.

Why Re-analyze succeeds:

- `reanalyzeMeetingAnalysis` calls processing gateway `/processing/{meetingId}/analysis/rerun`.
- Processing-service forwards to ai-service `/api/meeting/{id}/analysis/rerun`.
- Ai-service `rerun_analysis` rebuilds transcript text from saved transcript rows and calls `analyze_realtime_transcript` with `source="rerun"` and default force semantics.
- If Gemini is available later, the same persistence path succeeds and `getAnalysis` begins returning saved structured analysis.

What state is saved when Gemini fails:

- In ai-service `analysis_runs.py`, retryable failed states include `FAILED`, `QUOTA_BLOCKED`, and `RATE_LIMITED`.
- `analyze_realtime_transcript` marks `MeetingAnalysisRun` as `FAILED` for Gemini unavailable/parse/general failures, or `RATE_LIMITED` for rate limit.
- Processing-service `JobStateStore.markAnalysisFailed` stores `status=FAILED`, `errorCode`, `errorMessage`, `cooldownUntilMs`, and `retryAfterSeconds`.

Is `getAnalysis` 404 expected?

- Yes, a missing analysis can be expected while transcript is ready but analysis has not been persisted yet.
- Current FE post-stop polling already treats 404 as "Analysis not ready yet."
- Current processing-service also has explicit `ANALYSIS_GET_NOT_READY` handling and read-only `/analysis/saved` can return metadata without lazy triggering.
- The problem is not that 404/missing exists; the problem is that expected missing/pending can become a silent stuck state unless recovery/status is explicit.

## 7. Recommended solution

Recommended option: Option C - Hybrid recovery.

Backend should own durable analysis state and idempotent retry boundaries. Frontend should make the state visible and perform at most one bounded safe recovery action when transcript is completed but analysis is missing/retryable.

Option A - FE recovery only:

- Behavior:
  - If transcript completed but analysis is missing, show "Analysis not ready / failed".
  - Expose a retry button.
  - Optionally call `reanalyzeMeetingAnalysis` once after post-stop polling times out.
- Pros:
  - Small surface area.
  - Keeps provider throttling mostly unchanged.
  - Fastest UI improvement.
- Cons:
  - Does not fully fix backend state semantics.
  - Could trigger force reruns without respecting retryable failure state unless the request mode is chosen carefully.
  - May duplicate lazy analysis work already started by `getAnalysis`.

Option B - BE recovery in processing-service:

- Behavior:
  - When realtime finalized/transcript completed and analysis is failed/missing because of transient 503, mark a clear retryable state.
  - Provide or use an idempotent retry endpoint/mode.
  - Do not spam Gemini; use existing locks, cooldowns, and analysis identity.
- Pros:
  - Centralizes retry throttling.
  - Protects Gemini and cache/idempotency.
  - Makes FE simpler and production behavior more observable.
- Cons:
  - More moving parts.
  - Needs careful tests around `JobStateStore`, `getAnalysisInternal`, lazy trigger, and ai-service run identity.

Option C - Hybrid recommended:

- Backend:
  - Preserve existing cache/idempotency identity from 7U.
  - Continue using processing-service as the FE boundary.
  - Treat transcript-completed + no analysis as a first-class state, not an exceptional UI mystery.
  - Use `failed_retry` or an equivalent retryable mode for transient failures after cooldown, rather than `force` for automatic recovery.
  - Keep `force` for explicit manual Re-analyze.
  - Ensure `getAnalysis` returns actionable status metadata (`ANALYZING`, `FAILED`, `RATE_LIMITED`, `retryAfterSeconds`, `errorCode`) without excessive WARN logs for pending/missing.
- Frontend:
  - Show clear status after post-stop polling: completed, processing, failed retryable, missing.
  - Auto-retry at most once only when backend state says retry is allowed or cooldown is over.
  - Keep manual Re-analyze visible and working.
  - Keep all calls through processing-service/gateway; do not call ai-service directly.

Force vs failed_retry rule:

- Manual Re-analyze may use `force`/manual semantics because it is an explicit user action.
- Auto recovery must not use `force` by default.
- Auto recovery should use `failed_retry` or an equivalent cache-aware retry mode so it only retries known retryable failures and does not break 7U cache/idempotency.
- If `retryAfterSeconds` is still active, UI should only display wait/retry-after state and must not call the provider again.

MVP acceptable outcome:

- If analysis fails because Gemini returns 503/high demand, UI clearly shows "Analysis failed, retry available" or equivalent.
- User can press Retry/Re-analyze and analysis succeeds once Gemini recovers.
- Auto retry is optional polish after F1-A if provider-call duplication risk is still high.

Implementation slicing:

F1-A - Safe status + manual recovery clarity:

- FE displays analysis `pending`, `missing`, `failed`, and retryable failure states clearly after realtime recording stops.
- Manual Re-analyze remains the main fallback.
- Do not add auto retry yet; first make the state visible and trustworthy.
- Low risk and should be implemented first.
- Backend should still return enough metadata for FE to distinguish pending/missing/failed/retryAfter without excessive warning noise.

F1-B - Bounded auto retry:

- Implement only after F1-A is stable and validated.
- FE may auto retry at most once per realtime meeting in the current FE session.
- Auto retry is allowed only when backend metadata says retry is permitted.
- Auto retry must respect `retryAfterSeconds`/cooldown.
- Auto retry must not use `force`; prefer `failed_retry` or another cache-aware retry mode.
- Manual Re-analyze stays available as fallback even if auto retry is disabled.

## 8. Files likely to change in implementation

Frontend:

- `FE-Audiomind/src/app/App.tsx`
  - Post-stop analysis polling and bounded recovery behavior.
- `FE-Audiomind/src/services/api.ts`
  - Possibly add a non-force retry request wrapper or expose retry metadata cleanly.
- `FE-Audiomind/src/components/features/RealtimeDashboardScene.tsx`
  - Display retryable/missing/failed status more clearly.
- `FE-Audiomind/src/components/features/MeetingHistoryScene.tsx`
  - Align detail view missing/failed metadata with realtime recovery language if needed.
- `FE-Audiomind/src/components/analysis/AnalysisStatusPanel.tsx`
  - Display retryAfter/errorCode/status if not already sufficient.

Processing-service:

- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java`
  - `getAnalysisInternal`, `maybeTriggerRealtimeAnalysisLazy`, `runLazyRealtimeAnalysis`, retry/status response semantics.
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/JobStateStore.java`
  - Only if existing `FAILED`/cooldown state cannot represent retryable analysis cleanly.
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java`
  - Only if request mode/reason needs to be passed for `failed_retry`.
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java`
  - Only if adding a distinct retry endpoint or response metadata.

Ai-service:

- `demoRecordAUDIOMID/ai-service/app/main.py`
  - Realtime analysis mode handling, failed retry response semantics, and provider error mapping.
- `demoRecordAUDIOMID/ai-service/app/services/analysis_runs.py`
  - Only if retryable failure identity/status needs refinement.
- `demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py`
  - Avoid changing default providers; only consider whether realtime should call `analyze_meeting` or keep direct Gemini with explicit retryable failure semantics.

Tests:

- `demoRecordAUDIOMID/processing-service/src/test/java/com/example/processingservice/service/ProcessingServiceTest.java`
- `demoRecordAUDIOMID/processing-service/src/test/java/com/example/processingservice/client/AIServiceClientTest.java`
- `demoRecordAUDIOMID/ai-service/tests/test_gemini_analyzer.py`
- Add/extend ai-service route tests for realtime analysis/rerun if an existing suitable file exists.
- Add FE tests for `pollRealtimeAnalysisAfterStop` and realtime status UI if the current test harness supports it.

## 9. Implementation plan by small steps

F1-A - Safe status + manual recovery clarity:

1. Add tests that freeze current failure behavior:
   - Realtime transcript exists, analysis missing.
   - `getAnalysis` lazily starts analysis once.
   - Gemini 503 marks retryable failed state with retryAfter/cooldown.
   - A second immediate poll does not call Gemini again.

2. Clarify processing-service response semantics:
   - Return pending/failed retryable metadata from `getAnalysis` without making expected missing states look like unexpected WARN failures.
   - Keep `/analysis/saved` read-only.

3. Update frontend realtime status display:
   - After post-stop polling times out or sees retryable failed metadata, show explicit state.
   - Show clear Retry/Re-analyze affordance for manual recovery.
   - Never call ai-service directly.
   - Keep manual Re-analyze as fallback.

4. Align history/detail display:
   - Make saved analysis states consistent with realtime statuses.
   - Display retryAfter/errorCode where useful.

5. Add regression tests:
   - FE polling treats 404/missing as pending.
   - FE shows failed/retry UI after retryable failure.
   - Manual Re-analyze still succeeds and uses `force`.
   - Upload flow still uses existing batch path and remains unaffected.

F1-B - Bounded auto retry:

1. Add a bounded retry path:
   - Prefer backend-triggered `mode=failed_retry` or equivalent when the latest analysis state is retryable and cooldown has expired.
   - Preserve `mode=force` for manual Re-analyze only.
   - Ensure retry uses the same analysis identity/cache key fields: meeting, owner when available, canonical transcript hash/version, prompt/schema, provider/model, input mode, language/recognition metadata where applicable.

2. Add FE session guard:
   - Track whether auto recovery has already been attempted for the current realtime meeting/session.
   - Auto-trigger at most one safe retry only when backend metadata allows it.
   - If `retryAfterSeconds` is positive, render wait/retry-after state instead of triggering.

3. Add regression tests:
   - Auto retry happens at most once for the same realtime meeting in one FE session.
   - Auto retry uses `failed_retry` or cache-aware retry mode, not `force`.
   - Backend lock/cooldown prevents repeated provider calls during in-progress/cooldown state.

## 10. Acceptance criteria

- With realtime recording, after transcript completed, analysis is not stuck silent/missing.
- If Gemini returns transient 503/high demand, UI shows failed/retryable status or performs one bounded safe retry.
- Manual Re-analyze still works.
- FE does not call ai-service directly.
- FE still goes through processing-service/gateway.
- Upload file flow remains unchanged and passing.
- Existing cache/idempotency/rerun policy from 7U-B/C/D/E/F remains intact.
- `getAnalysis` 404/not-ready while analysis is pending/missing is treated as expected and does not spam misleading WARN logs.
- Whisper/Ollama default is not re-enabled.
- Cloud-first Deepgram/Gemini runtime remains the default.
- F1-A can pass without auto retry if UI clearly exposes failed/missing/retryable state and manual Re-analyze works.
- In one realtime meeting, FE must not auto-trigger provider retry more than once.
- Backend must keep lock/cooldown/idempotency for analysis retry attempts.
- If `retryAfterSeconds` is still active, UI must only show wait/retry-after state and must not call Gemini/provider again.

## 11. Validation plan

Do not run Docker/browser/production in this spec phase. For implementation phase, validate with:

Local/static:

- FE tests covering realtime analysis polling/status/retry if available.
- Processing-service tests:
  - `getAnalysis_shouldEnqueueRealtimeAnalysisLazilyWhenAiAnalysisIsMissing`
  - `getAnalysis_shouldNotEnqueueRealtimeAnalysisRepeatedlyWhileInProgress`
  - `getAnalysis_shouldSkipLazyEnqueueDuringRecentFailureCooldown`
  - add tests for retry after cooldown / `failed_retry`.
- AIServiceClient test for realtime analysis payload mode/reason if changed.
- Ai-service tests for `/api/internal/realtime-analysis` failure and `/analysis/rerun` success paths.

Production manual after deployment:

1. `health-prod.sh` passes.
2. `monitor-prod.sh` passes.
3. Run `backup-prod.sh` before test.
4. Record live Vietnamese audio for 1-3 minutes.
5. Wait for transcript completed.
6. Confirm analysis appears automatically or failed/retry state is clear.
7. If retry is shown/triggered, confirm retry succeeds when provider recovers.
8. Confirm manual Re-analyze still works.
9. Confirm regular upload file flow still passes.
10. Confirm DOCX export still passes.
11. If failure remains, run `collect-prod-logs-redacted.sh`.

F1-A validation:

- Realtime recording finishes and transcript reaches completed/available state.
- If analysis is missing or failed, UI does not stay silent.
- Retry/Re-analyze action is clear.
- Manual retry/Re-analyze succeeds once Gemini is available.
- Upload file flow still passes.

F1-B validation:

- Auto retry happens at most once per realtime meeting in the FE session.
- Auto retry respects `retryAfterSeconds`/cooldown.
- Logs do not show repeated Gemini/provider calls for the same meeting while in-progress or cooling down.
- Manual Re-analyze still works after auto retry is skipped, exhausted, or disabled.

## 12. Rollback/safety plan

- Keep implementation behind existing processing-service/gateway paths.
- Do not alter production scripts unless a later implementation spec explicitly requires it.
- Do not alter env defaults to Whisper/Ollama.
- If recovery causes excessive provider calls, disable frontend auto-retry first and keep explicit manual retry.
- If backend retry state regresses, fall back to existing manual Re-analyze flow while preserving clearer UI messaging.
- Preserve `JobStateStore` locks/cooldowns and ai-service analysis run idempotency.

## 13. Out of scope

- No implementation in this phase.
- No commit/push.
- No Docker build/up.
- No deploy/SSH/browser smoke.
- No real `.env` edits.
- No provider swap.
- No change to upload flow except tests proving it is not broken.
- No re-enable of Whisper/Ollama default runtime.

## 14. Risks / notes

- Automatic retry can spam Gemini if it bypasses `JobStateStore` locks/cooldown or ai-service run identity. Keep retries bounded and backend-authorized.
- `force` mode is appropriate for manual Re-analyze, but automatic recovery should prefer retryable failure semantics.
- Auto recovery must not use `force` by default; it should use `failed_retry` or an equivalent cache-aware retry mode.
- If FE cannot prove it will retry at most once per realtime meeting/session, ship F1-A only and leave F1-B disabled.
- If `retryAfterSeconds` is positive, retry UI should communicate waiting/retry-after rather than re-triggering provider calls.
- Realtime and upload currently differ in Gemini error behavior. Making them identical may change user-visible semantics; choose deliberately.
- `getAnalysis` has lazy-trigger behavior, while `/analysis/saved` is read-only. The UI should use each intentionally.
- Direct ai-service calls from FE would bypass ownership/gateway policy and should remain out of scope.
- The current code already has useful primitives: `ANALYSIS_MODE_FAILED_RETRY`, `ANALYSIS_RETRYABLE_FAILURE_STATUSES`, `retryAfterSeconds`, analysis locks, cooldowns, and completed-run cache lookup. The implementation should use these before introducing new state.

## Questions answered

1. Realtime differs from upload because realtime final analysis is triggered/polled after stop through processing-service lazy realtime analysis and ai-service `/api/internal/realtime-analysis`; upload is queued through `/api/process` and Celery pipeline.
2. When realtime is finalized, processing-service `getAnalysis` can trigger analysis lazily after transcript exists; ai-service persists the analysis through `analyze_realtime_transcript`.
3. Gemini 503/unavailable in realtime marks failed analysis run/state with error code/cooldown/retryAfter; upload's `analyze_meeting` has a fallback path.
4. FE polls `getAnalysis` every 2 seconds for 25 attempts after stop and treats 404 as not ready.
5. Transcript can complete while analysis remains failed/missing because analysis is a separate provider call and current recovery is bounded polling, not guaranteed retry.
6. Re-analyze works because it rebuilds transcript text from saved rows and calls the same realtime analysis path with force/manual semantics when Gemini may have recovered.
7. `getAnalysis` 404/not-ready is expected while analysis is pending/missing.
8. Fix should be hybrid: backend state/idempotency plus frontend visibility/bounded recovery.
9. F1-A may ship with manual retry only; F1-B can add bounded auto retry when backend marks retryable and cooldown permits.
10. Avoid repeat provider calls via existing locks, cooldowns, cache identity, and at-most-one FE auto retry.
11. Preserve 7U cache/idempotency by reusing analysis identity and avoiding unconditional force reruns for automatic recovery.
12. Tests should cover FE polling/UI, processing-service lazy trigger/cooldown, ai-service realtime failure/rerun, and upload regression.
