# Phase 7U Analysis Cache Audit Results

## Files Read

- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/JobStateStore.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/report/MeetingReportData.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/report/MeetingReportDocxGenerator.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/dto/AnalysisResponse.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/dto/TranscriptResponse.java`
- `demoRecordAUDIOMID/ai-service/app/models.py`
- `demoRecordAUDIOMID/ai-service/app/main.py`
- `demoRecordAUDIOMID/ai-service/app/pipeline.py`
- `demoRecordAUDIOMID/ai-service/app/tasks.py`
- `demoRecordAUDIOMID/ai-service/app/schemas.py`
- `demoRecordAUDIOMID/ai-service/app/config.py`
- `demoRecordAUDIOMID/ai-service/app/services/analysis_factory.py`
- `demoRecordAUDIOMID/ai-service/app/services/gemini_analyzer.py`
- `demoRecordAUDIOMID/ai-service/app/services/analysis_errors.py`
- `demoRecordAUDIOMID/ai-service/app/services/stt_persistence.py`
- `demoRecordAUDIOMID/ai-service/app/services/transcript_canonicalizer.py`
- `demoRecordAUDIOMID/ai-service/alembic/versions/001_initial.py`
- `demoRecordAUDIOMID/ai-service/alembic/versions/003_analysis_glossary_reference.py`
- `demoRecordAUDIOMID/ai-service/alembic/versions/004_stt_fragments_checkpoints.py`
- `demoRecordAUDIOMID/ai-service/alembic/versions/005_transcript_canonical_sidecar.py`
- `FE-Audiomind/src/components/features/MeetingHistoryScene.tsx`
- `FE-Audiomind/src/services/api.ts`
- `FE-Audiomind/src/types/index.ts`
- `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/MeetingController.java`
- `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/entity/Meeting.java`
- `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/repository/MeetingRepository.java`
- `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/service/MeetingService.java`

Note: CodeGraph pointed at `FE-Audiomind/src/types.ts`, but that path was not present in this worktree. `FE-Audiomind/src/types/index.ts` contains the active type definitions.

## Current Analysis Flow Map

Batch upload:

- `MeetingController.upload` stores new audio, or reuses an active duplicate by `ownerUserId + audioHash`.
- `ProcessingController.process` and `processByPath` call `ProcessingService.startProcessing`.
- `ProcessingService.startProcessing` claims Redis idempotency by resolved file id, writes job state, then calls `AIServiceClient.processAudio`.
- AI service `/api/process` queues Celery `process_meeting`.
- `process_meeting` calls `ProcessingPipeline.process_meeting`.
- `ProcessingPipeline.process_meeting` calls `self.ai_analyzer.analyze_meeting(...)` during batch processing, then `_save_results`.
- `_save_results` persists transcript fragments and inserts one `Analysis` row for the meeting.
- Job state is updated with transcripts and, if available, analysis payload.

Meeting detail:

- FE `MeetingHistoryScene` loads detail with `getMeetingDetail`, `getTranscript`, and `getSavedAnalysis`.
- `getSavedAnalysis` calls `/processing/{meetingId}/analysis/saved`.
- `/analysis/saved` uses `ProcessingService.getAnalysisReadOnly`, which passes `allowLazyTrigger=false`.
- This path does not intentionally trigger Gemini.

Lazy analysis:

- `/processing/{meetingId}/analysis` uses `ProcessingService.getAnalysis` with `allowLazyTrigger=true`.
- It first checks job state analysis.
- It then fetches AI-service persisted analysis.
- If analysis is still missing, it builds transcript text from state/persisted transcript and calls `maybeTriggerRealtimeAnalysisLazy`.
- Lazy analysis posts to AI service `/api/internal/realtime-analysis`, which may call Gemini and overwrite/create the single `analysis` row.

DOCX/export:

- Transcript TXT/CSV export loads saved transcript payloads and does not call Gemini.
- DOCX report loads saved transcript payloads and extracts analysis only from processing job state.
- DOCX does not call Gemini, but it can miss DB-persisted analysis if Redis job state has expired or lacks analysis.

## Current Transcript/Hash/Version Findings

- 7Q sidecar columns exist on `Transcript`: `raw_transcript_hash`, `canonical_transcript_rows`, `canonical_transcript_version`, `canonical_transcript_hash`, `canonical_generated_at`, `canonical_stats`.
- Migration `005_transcript_canonical_sidecar.py` adds these sidecar columns.
- `transcript_canonicalizer.py` defines `CANONICAL_VERSION = "canonical-transcript-v2"`.
- `build_raw_transcript_hash` hashes normalized sorted speaker/start/end/text rows.
- `build_canonical_transcript_hash` hashes canonical rows plus canonical version.
- AI-service `get_transcript` prefers canonical sidecar rows when present and raw hash matches current raw rows.
- Processing-service `normalizeTranscriptPayload` preserves `transcriptMode`, `canonicalTranscriptVersion`, `canonicalTranscriptHash`, `canonicalGeneratedAt`, `rawTranscripts`, and readable rows.
- Lazy analysis currently computes `sha256(transcriptText)` over readable transcript text and uses that as part of a simplified key.
- Existing lazy analysis key does not use 7Q `canonicalTranscriptHash` directly when it is available.

## Current 7S Metadata Findings

- Processing-service has `speakerStabilizationVersion` config with default `speaker-stabilization-v1`.
- `buildTranscriptResponse` includes `speakerStabilizationVersion` and `speakerStats` when stabilization produces them.
- Stabilization output can add `providerSpeaker`, `originalSpeaker`, and `speakerStabilizationVersion` to rows in dry-run path, and returns `speakerStats` in normal path.
- This metadata is response-level/transient in processing-service, not durable cache metadata.
- If analysis input uses stabilized readable rows, `speakerStabilizationVersion` must be part of the cache key.

## Current DB/Entity/Repository Findings

- `Analysis` table has a unique `meeting_id`.
- Persisted columns are `summary`, `keywords`, `technical_terms`, `action_items`, `created_at`, glossary fields, and optional `transcript_id`.
- Prompt version, schema version, transcript hash, domain mode, and source are stored inside `technical_terms` JSON payload when available.
- Provider/model are not stored in `Analysis`.
- Analysis status/error/quota state are not first-class DB fields.
- AI service and processing service keep analysis lock/status/error/cooldown in Redis, not durable DB.
- Batch `_save_results` inserts a new `Analysis` row and does not upsert by cache identity.
- Realtime `_analyze_and_persist_realtime_transcript` creates the row if missing or updates the existing row for the meeting.

## Current Gemini Retry/Quota Findings

- Gemini is selected by default through `analysis_provider=gemini`.
- `GeminiAnalyzer` default analysis model is `gemini-2.5-flash`.
- Analysis factory wires retry/rate-limit settings such as retry attempts, rate-limit retry base/max seconds, quota-exceeded retry flag, and max token retry.
- AI-service exception handling maps Gemini parse failure to `GEMINI_ANALYSIS_FAILED` and unavailable/config errors to `GEMINI_UNAVAILABLE`.
- Processing-service maps downstream lazy-analysis failures and keeps failure cooldown/retry state in Redis.
- There is no durable `QUOTA_BLOCKED` or `RATE_LIMITED` DB status.
- Rate/quota details are not currently preserved as first-class analysis metadata for FE/export.

## Current Export/DOCX Behavior Findings

- `generateMeetingReportDocx` does not call `getAnalysis` and does not trigger lazy analysis.
- It uses `extractAnalysisFromState(state)` only.
- `MeetingReportDocxGenerator` writes analysis metadata fields: status, prompt version, schema version, transcript hash, confidence, domain mode, and source.
- DOCX does not include provider/model or canonical transcript version.
- If analysis is missing, sections render "Analysis not available" or "N/A".
- There is no DB fallback for report analysis, so a completed DB analysis may be omitted from DOCX after job-state TTL.

## Current Duplicate Upload Reuse Findings

- Meeting upload computes SHA-256 over audio bytes.
- Meeting-service finds the latest active duplicate by `ownerUserId + audioHash`.
- If duplicate status is completed, response has `duplicate=true`, `reused=true`, and `existingMeetingId`.
- If duplicate exists but is still processing/failed, response has duplicate metadata but `reused=false`.
- Processing-service batch idempotency also maps `fileId` to job id in Redis.
- Duplicate upload reuse is meeting-level, not analysis-cache-level. There is no cross-meeting analysis cache reuse beyond returning the existing meeting.

## Gaps

- Cache identity is split across text hash, JSON payload fields, Redis state, and settings.
- No durable analysis cache table with provider/model/status/error/idempotency metadata.
- Existing cache key omits owner/user scope, provider, model, transcript language, recognition mode, canonical transcript version, speaker stabilization version, and analysis input mode.
- `canonicalTranscriptHash` exists but lazy analysis does not use it as the primary cache input.
- Analysis provider/model are not returned by API responses.
- DB cannot store multiple analysis versions for the same meeting because of unique `meeting_id`.
- Batch analysis always calls provider during processing; no durable cache hit path exists before Gemini.
- DOCX report does not use DB-persisted analysis if Redis job state is missing.
- FE has `idle/processing/completed/failed/missing`, but no explicit cached/stale/quota/rate-limited status.

## Recommended MVP Decisions

- Add a new versioned `meeting_analysis_runs` or `analysis_runs` table for 7U cache history.
- Keep the existing `analysis` table as a compatibility/current projection for the first implementation slice.
- Do not remove or relax the existing unique `meeting_id` constraint on `analysis` in the first implementation slice unless a later implementation explicitly requires it.
- Scope cache reuse to `meetingId + ownerId` or equivalent user/tenant scope.
- Do not support cross-meeting analysis reuse in 7U MVP, including same-owner reuse for identical canonical transcript/config.
- Use `canonicalTranscriptHash + canonicalTranscriptVersion` as the cache source of truth.
- If Gemini input is rendered from readable or 7S stabilized rows, include `speakerStabilizationVersion` and `analysisInputMode` in the cache key.
- Do not rewrite the 7Q canonicalizer, change 7S speaker stabilization, or change Deepgram/Gemini defaults for 7U.
- `force` rerun should create a new run/version, preserve historical runs, and allow the latest successful compatible run to become current.
- Store `requested_by` and `rerun_reason` for forced reruns and manual retries.
- Existing `analysis` rows may be imported best-effort as `legacy_import` or `fallback_identity`; full backfill is optional for the first MVP implementation.
- New analyses must use full cache identity fields going forward.

## Implementation Blockers

- No durable table currently exists for versioned analysis runs, provider/model identity, status, error, quota/rate-limit, or idempotency metadata.
- The current unique `analysis.meeting_id` model cannot represent historical forced reruns or multiple compatible/incompatible analysis identities for one meeting.
- AI service does not currently persist provider/model as first-class analysis fields.
- Lazy analysis uses readable transcript text hash instead of 7Q `canonicalTranscriptHash + canonicalTranscriptVersion`.
- Owner/user scope is owned outside AI service, so cache writes need a trusted owner id source or a gateway-provided value.
- DOCX/report analysis read path depends on Redis job state and needs a durable DB fallback.
- Redis analysis locks/state are keyed by simplified meeting/cache values, not the full 7U cache identity.

## First Implementation PR Scope

Recommended first PR after this docs polish:

- Add the new versioned analysis run model/table and migration.
- Add first-class fields for status, provider, model, prompt/schema version, canonical transcript hash/version, analysis input mode, speaker stabilization version, owner scope, errors, idempotency, `requested_by`, and `rerun_reason`.
- Keep existing `analysis` reads working as the compatibility/current projection.
- Introduce response DTO metadata for `analysisStatus`, `cacheHit`, `stale`, `staleReason`, provider/model, prompt/schema, canonical transcript identity, input mode, `lastAnalyzedAt`, and `retryAfterSeconds`.
- Do not centralize provider-call logic, rerun concurrency, DOCX fallback, or FE UI in the same PR unless the implementation remains small.

7U-B implementation note:

- The first foundation table is `meeting_analysis_runs`; the existing unique `analysis.meeting_id` projection is unchanged.
- Batch and realtime completed analysis writes now persist provider/model, prompt/schema, transcript identity, input mode, payload, summary, idempotency, and timestamps.
- `owner_id` remains nullable until owner/user scope is passed into AI-service safely.
- Cache hit/miss service logic, stale detection, durable failure/quota transitions, retry/rerun modes, and DOCX DB fallback remain deferred to 7U-C/7U-D/7U-E.

7U-C implementation note:

- Cache hit/miss service logic is implemented in AI-service for both batch processing and realtime/lazy analysis.
- Completed `meeting_analysis_runs` are reused only when the full current identity matches; hits skip Gemini/provider calls, refresh the compatibility projection when needed, expose `cacheHit=true`, and do not create duplicate run rows.
- Misses keep the existing provider path and persist a completed run with the 7U-B metadata write helper.
- Provider/model/prompt/schema and canonical hash/version mismatches are treated as misses, not silent reuse.
- Full rerun/idempotency policy and explicit stale lifecycle responses remain deferred to 7U-D.
- DOCX/export DB fallback remains deferred to 7U-E.

7U-D implementation note:

- AI-service now implements `auto`, `cache_only`, `force`, and `failed_retry` mode policy around `meeting_analysis_runs`.
- `cache_only` is provider-safe: it returns matching completed analysis, stale metadata, or no-analysis metadata without Gemini calls.
- Same full identity double-submit is guarded by durable `ANALYZING` runs; callers receive in-progress metadata rather than a second provider call.
- `force` reruns bypass completed cache hits and create a distinct run row while preserving older completed history; the compatibility `analysis` projection updates after successful completion.
- Stale metadata now reports identity mismatch reasons for transcript hash, canonical version, provider, model, prompt/schema versions, input mode, and speaker stabilization version.
- Realtime/lazy analysis keeps the existing Redis lock/cooldown guard, but uses the full durable analysis identity as the cache/idempotency key once resolved.
- A minimal AI-service rerun endpoint was added at `POST /api/meeting/{meeting_id}/analysis/rerun`.
- DOCX/export DB fallback is still deferred to 7U-E; FE status/reanalyze UI is still deferred to 7U-F.

## Risks If Extending Existing `analysis` Table

- Relaxing unique `meeting_id` early can break existing readers that assume one current analysis row per meeting.
- Keeping unique `meeting_id` while adding cache fields still cannot preserve forced rerun history.
- Mixing cache history, current projection, provider status, and legacy compatibility in one table increases migration and rollback risk.
- Composite identity constraints on the existing table would need careful current-run semantics before they can be trusted.
- Backfilling incomplete legacy rows into the same table may make it harder to distinguish canonical cache hits from `legacy_import` or `fallback_identity` records.

## Recommended Implementation Order

1. Add durable analysis metadata model/table and response fields.
2. Centralize cache key construction in AI service, using canonical transcript hash/version where available.
3. Add cache lookup before batch and lazy provider calls.
4. Replace simplified Redis lock keys with full analysis identity idempotency.
5. Add rerun modes and status transitions.
6. Update DOCX/read-only export to use durable cached analysis and status metadata.
7. Add minimal FE state display and re-analyze entry point.
8. Add targeted tests for cache hit, miss, stale, failure cooldown, quota/rate limit, force rerun, and DOCX no-provider-call behavior.

## Risk Notes

- The single-row `analysis` table will constrain 7U unless a new versioned table is added.
- If 7U changes batch input from raw aligned text to canonical rows, historical hashes will not match; treat those records as stale/fallback.
- Redis analysis state TTL can erase status that export/detail may need.
- Owner scope must be handled carefully because AI service currently does not own meeting tenancy data.
- Provider/model changes will silently reuse old analysis unless they become first-class key fields.
- Canonical sidecar trust depends on the raw hash check.

## Open Questions

- Should batch analysis wait for canonical sidecar generation before calling Gemini?
- Should `analysis_provider` and model be persisted by AI service from settings/analyzer, or passed through from processing-service?
- Should DOCX display stale analysis payload content, or only transcript plus stale status metadata?
- Should the compatibility/current projection in `analysis` be updated synchronously when a run completes, or reconciled separately?
