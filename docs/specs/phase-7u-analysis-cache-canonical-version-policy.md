# Phase 7U: Analysis Cache + Canonical Version Policy

## Problem Statement

Analysis is currently coupled to "whatever transcript text is available when the request runs". Batch upload calls the analysis provider during processing, while the lazy meeting analysis path can call Gemini again from `GET /processing/{meetingId}/analysis` when saved analysis is missing. The existing identity check uses transcript hash, prompt version, and schema version, but those values are partly stored inside JSON payloads and Redis analysis state rather than as durable, queryable database fields.

This creates three risks:

- Repeated Gemini calls for the same canonical transcript and analysis configuration.
- Stale or inconsistent analysis when transcript canonicalization, speaker stabilization, prompt/schema, provider, or model changes.
- Export/report behavior that cannot reliably explain whether analysis is fresh, missing, stale, cached, failed, or quota blocked.

## Goals

- Cache analysis against a deterministic canonical transcript input and explicit analysis configuration.
- Reuse cached analysis on cache hit without calling Gemini.
- Prevent stale analysis from being mistaken for current analysis after transcript hash/version or analysis configuration changes.
- Make rerun behavior explicit: automatic reuse, cache-only lookup, forced rerun, and retry of failed/quota-blocked analysis.
- Preserve current 7Q canonical transcript behavior and 7S speaker stabilization behavior.
- Keep DOCX/export paths from triggering Gemini.
- Define a DB/data model that can represent status, cache identity, errors, provider/model, prompt/schema, and rerun metadata.

## Non-goals

- No implementation in 7U-A.
- No DB migration in this task.
- No 7V transcript search.
- No 7W paragraph mode.
- No rewrite of the 7Q canonicalizer.
- No rewrite of 7S speaker stabilization.
- No change to Deepgram/Gemini defaults.
- No broad FE redesign.
- No full transcript/export rewrite.

## Current Flow Summary

Batch upload path:

- `meeting-service` creates or reuses a meeting from `POST /meetings/upload`.
- `processing-service` starts processing through `POST /processing/start` or `/processing/start/{meetingId}`.
- `ProcessingService.startProcessing` claims a Redis file idempotency mapping and calls AI service `/api/process`.
- AI service queues `process_meeting` in Celery.
- `ProcessingPipeline.process_meeting` runs STT, formats transcript, calls `self.ai_analyzer.analyze_meeting(...)`, then saves transcripts and one `analysis` row.
- The saved `analysis` row is unique by `meeting_id`.

Meeting detail path:

- The FE meeting detail scene calls `getMeetingDetail`, `getTranscript`, and `getSavedAnalysis`.
- `getSavedAnalysis` calls `/processing/{meetingId}/analysis/saved`.
- `analysis/saved` calls `ProcessingService.getAnalysisReadOnly(..., allowLazyTrigger=false)`.
- The read-only path checks processing job state and AI-service persisted analysis, but it does not trigger lazy Gemini analysis.

Lazy analysis path:

- `GET /processing/{meetingId}/analysis` calls `ProcessingService.getAnalysis(..., allowLazyTrigger=true)`.
- If job state and AI-service analysis are missing, `maybeTriggerRealtimeAnalysisLazy` builds readable transcript text and triggers `/api/internal/realtime-analysis`.
- The lazy cache key is currently `sha256(transcriptText)|promptVersion|schemaVersion`.
- The lazy guard uses Redis analysis state and locks, then AI service persists/overwrites the single `analysis` row for that meeting.

DOCX/export path:

- Transcript TXT/CSV exports use saved job state and AI-service persisted transcript data.
- DOCX report uses saved transcript data and `extractAnalysisFromState(state)`.
- DOCX does not call Gemini, but it can miss DB-persisted analysis if the Redis job state has expired or does not contain analysis.

## Target Architecture

Introduce a durable analysis cache record with explicit cache identity and lifecycle state. Processing, detail, lazy analysis, rerun, and export should all resolve analysis through a single cache service.

The service should:

- Resolve the canonical transcript input for the requested meeting.
- Build a stable cache key from transcript identity, analysis configuration, tenant/user scope, language/mode, and speaker/input-mode dimensions.
- Lookup a durable `analysis`/`analysis_runs` record by that key.
- Return cache hit data without provider calls.
- Start provider work only when the API mode allows it.
- Persist status transitions and provider errors.
- Return clear metadata to FE/export callers.

Recommended ownership:

- AI service owns analysis persistence and provider execution.
- Processing service may keep gateway/rerun orchestration, but should not independently invent a different cache key.
- Meeting service remains owner/user scope source and duplicate upload gate.

## MVP Decisions

7U MVP should make these decisions explicit before implementation:

- Use a new versioned analysis table, preferably `meeting_analysis_runs` or `analysis_runs`.
- Keep the existing `analysis` table as the compatibility/current projection for existing readers during the first implementation slice.
- Do not remove or relax the existing unique `meeting_id` constraint on `analysis` in the first implementation slice unless a later implementation explicitly proves that it is required.
- Scope cache reuse to `meeting_id + owner_id` or equivalent user/tenant scope.
- Do not perform cross-meeting analysis reuse in 7U MVP.
- Same-owner cross-meeting reuse for identical canonical transcripts is out of scope and can be reconsidered after meeting-scoped caching is proven.
- Treat `canonical_transcript_hash + canonical_transcript_version` as the analysis cache source of truth.
- If Gemini input is built from readable or 7S stabilized rows, include `speaker_stabilization_version` and `analysis_input_mode` in the cache key.
- Do not rewrite the 7Q canonicalizer to support 7U.
- `force` rerun creates a new run/version and does not overwrite historical runs.
- The latest successful compatible run may become the current projection served through existing compatibility paths.
- Store `requested_by` and `rerun_reason` for forced reruns and manual retries.

## Cache Key Policy

Minimum cache identity fields:

- `meeting_id`
- `owner_id` or equivalent tenant/user scope
- `canonical_transcript_hash`
- `canonical_transcript_version`
- `analysis_prompt_version`
- `analysis_schema_version`
- `analysis_provider`
- `analysis_model`
- `transcript_language`
- `recognition_mode`
- `speaker_stabilization_version`, when the stabilized/readable rows are analysis input
- `analysis_input_mode`, such as `canonical`, `raw`, or `readable`

Recommended key normalization:

- Lowercase provider, model, hashes, language, recognition mode, and input mode.
- Preserve prompt/schema version strings after trimming unless repo conventions require lowercase.
- Use `canonical_transcript_hash` from the 7Q sidecar when available.
- Fall back to a deterministic hash of the actual analysis input text only when canonical sidecar data is unavailable, and mark `analysis_input_mode=readable_fallback` or equivalent.
- Include `canonical_transcript_version` even when the hash is present, because the same row shape may be interpreted differently after policy changes.
- Include `speaker_stabilization_version` if the input text uses 7S stabilized display rows rather than raw canonical rows.

Avoid using only `meeting_id` as the cache identity. Avoid using only raw transcript text hash because it hides canonicalizer version, speaker stabilization, provider/model, and language decisions.

MVP cache scope:

- Cache entries are meeting-scoped and owner/user-scoped.
- A cache hit requires the same `meeting_id`, same `owner_id` or equivalent tenant/user scope, and the same full cache identity.
- No 7U MVP path should reuse analysis across different meetings, even for the same owner and identical canonical transcript.

## Canonical Version Policy

Current 7Q stable input:

- `canonical_transcript_version` is `canonical-transcript-v2`.
- `canonical_transcript_hash` is SHA-256 over canonical rows plus the canonical version.
- `raw_transcript_hash` is SHA-256 over sorted raw speaker/start/end/text rows.
- `canonical_transcript_rows`, `canonical_generated_at`, and `canonical_stats` are sidecar fields on `transcripts`.

Policy:

- Treat `canonical_transcript_hash + canonical_transcript_version` as the preferred transcript identity.
- Use canonical transcript identity as the cache source of truth for new analyses.
- Do not recompute or rewrite the canonicalizer in 7U.
- If the sidecar is unavailable, compute a fallback hash from the exact analysis input and mark it as non-canonical/fallback.
- If `raw_transcript_hash` no longer matches the current raw rows, do not trust the sidecar for cache hits.
- If the canonical version changes, existing analysis is `STALE` unless the new implementation explicitly proves compatibility.

Analysis input mode:

- Prefer canonical transcript rows for cache identity even if the provider prompt uses readable text.
- If the provider input is rendered from readable rows or 7S stabilized rows, store `analysis_input_mode` and include `speaker_stabilization_version` in the cache key.
- Do not change 7Q canonical row generation, sorting, normalization, or hash policy as part of 7U.

## Analysis Status Model

Use an explicit status field. Recommended statuses:

- `NO_ANALYSIS`: no cache record exists for the requested identity.
- `ANALYZING`: provider work is in progress.
- `COMPLETED`: analysis payload is available and matches the requested identity.
- `FAILED`: provider work failed for a non-quota reason.
- `STALE`: analysis exists for the meeting but not for the current transcript/config identity.
- `QUOTA_BLOCKED` or `RATE_LIMITED`: provider quota/rate limit blocked execution.
- `CACHED`: optional response metadata flag for a cache hit; do not require it as a stored status if `COMPLETED + cacheHit=true` is clearer.

Response metadata should include:

- `analysisStatus`
- `cacheHit`
- `stale`
- `staleReason`
- `retryAfterSeconds`
- `lastAnalyzedAt`
- `provider`
- `model`
- `promptVersion`
- `schemaVersion`
- `canonicalTranscriptHash`
- `canonicalTranscriptVersion`
- `analysisInputMode`

## API Contract Proposal

Read-only saved analysis:

`GET /processing/{meetingId}/analysis/saved`

- Does not call Gemini.
- Returns the current compatible cached analysis if present.
- Returns stale/missing/quota/rate-limit metadata when analysis cannot be served as current.
- Intended for meeting detail initial load and DOCX/export support.

Analysis lookup with mode:

`GET /processing/{meetingId}/analysis?mode=auto|cache_only`

- `mode=cache_only` never calls Gemini and returns only durable cache state.
- `mode=auto` returns a matching cache hit or starts/continues analysis when provider execution is allowed.
- Default should remain compatible with existing callers, but implementation should make the chosen mode explicit in service code.

Manual rerun:

`POST /processing/{meetingId}/analysis/rerun`

Request body proposal:

```json
{
  "reason": "User requested updated action items",
  "mode": "force"
}
```

Response metadata proposal:

```json
{
  "analysisStatus": "COMPLETED",
  "cacheHit": true,
  "stale": false,
  "staleReason": null,
  "provider": "gemini",
  "model": "gemini-2.5-flash",
  "promptVersion": "analysis-prompt-v1",
  "schemaVersion": "analysis-schema-v1",
  "canonicalTranscriptHash": "sha256:...",
  "canonicalTranscriptVersion": "canonical-transcript-v2",
  "analysisInputMode": "canonical",
  "lastAnalyzedAt": "2026-06-03T00:00:00Z",
  "retryAfterSeconds": null
}
```

The response payload may also include existing `summary`, `keywords`, `technicalTerms`, and `actionItems` fields for compatibility.

## Rerun Policy

Supported modes:

- `auto`: return matching cache hit; on miss, start analysis if provider execution is allowed.
- `reuse` or `cache_only`: return only cached analysis; never call Gemini. Missing or stale cache returns `NO_ANALYSIS` or `STALE`.
- `force`: user-requested reanalysis. Create a new run/version and mark the latest successful compatible run current after success. Do not overwrite historical runs.
- `failed_retry`: retry a failed, quota-blocked, or rate-limited record after cooldown or user action.

Forced reruns must store:

- `requested_by`
- `rerun_reason`
- the full cache identity used for the rerun
- parent or previous current run id when available

When transcript hash changes:

- Never reuse old analysis as current.
- Return `STALE` for cache-only/read-only calls if old analysis exists.
- In `auto`, either enqueue a new analysis or return `ANALYZING`, depending on synchronous/asynchronous design.
- Preserve old analysis for audit/history unless the retention policy says otherwise.

## Idempotency / Double-submit Guard

Current guards:

- Meeting upload dedupes by `owner_user_id + audio_hash` and returns the latest non-deleted duplicate meeting.
- Processing service uses Redis `idem:{fileId}` to avoid duplicate batch processing starts.
- Processing service and AI service both have Redis analysis locks/state keyed by meeting and current simplified analysis cache key.
- AI-service realtime path checks the single `analysis` row for matching transcript hash, prompt version, and schema version before rerunning.

Target guard:

- Use one idempotency key derived from the full analysis cache identity.
- Store lock owner, requested_by, rerun mode, and started_at.
- Lock on the durable cache identity, not only meeting id.
- Treat duplicate submit for the same identity as `ANALYZING` or cache hit.
- Allow `force` to create a new run/version with a distinct `idempotency_key` or `rerun_reason`.

## Export/DOCX Behavior

Export must never call Gemini.

Policy:

- On cache hit, DOCX/report uses cached analysis.
- On missing/stale analysis, DOCX exports transcript plus analysis metadata status.
- DOCX should include `analysisStatus`, provider/model, prompt/schema version, canonical transcript hash/version, input mode, and last analyzed timestamp when available.
- If no analysis exists, use "Analysis not available" sections as today, but include the reason/status.
- If Redis job state lacks analysis but DB/cache has it, report generation should use the durable cache record.

7U should not rewrite raw/full transcript export behavior.

## FE Behavior

Initial FE behavior should be minimal:

- Display whether analysis is cached/up to date.
- Display stale analysis state.
- Display quota blocked/rate limited state and retry timing when available.
- Display last analyzed at.
- Display provider/model metadata only where it helps debugging/support.
- Provide a re-analyze button wired to the future rerun API.

The current FE already calls `getSavedAnalysis` for meeting detail, which avoids lazy Gemini calls. 7U-F can extend the existing analysis state model rather than replace the view.

## Database / Data Model Proposal

Current database:

- `analysis` has `id`, unique `meeting_id`, `summary`, `keywords`, `technical_terms`, `action_items`, `created_at`, `transcript_id`, glossary fields.
- Prompt/schema/transcript hash/source are stored inside `technical_terms` JSON payload, not first-class columns.
- There is no durable analysis status/error/provider/model/idempotency record.

Preferred MVP proposal: add a new versioned `meeting_analysis_runs` or `analysis_runs` table. Keep the existing `analysis` table as a compatibility/current projection for now, populated from the latest successful compatible run where needed.

Do not remove or relax the unique `meeting_id` constraint on the existing `analysis` table in the first implementation slice. That table should continue to serve single-current-row readers until a later implementation explicitly chooses a different compatibility strategy.

Suggested fields:

- `id`
- `meeting_id`
- `owner_id`
- `status`
- `provider`
- `model`
- `prompt_version`
- `schema_version`
- `canonical_transcript_hash`
- `canonical_transcript_version`
- `speaker_stabilization_version`
- `recognition_mode`
- `transcript_language`
- `analysis_input_mode`
- `analysis_payload_json`
- `summary`
- `error_code`
- `error_message`
- `idempotency_key`
- `created_at`
- `updated_at`
- `completed_at`
- `requested_by`
- `rerun_reason`

Suggested indexes:

- Unique active/current key: `unique(meeting_id, canonical_transcript_hash, prompt_version, schema_version, provider, model)` plus the other cache dimensions if represented as columns.
- If owner scope is required for tenancy: include `owner_id` in lookup and index predicates.
- Status lookup index: `(meeting_id, status, updated_at)`.
- Idempotency index: unique `idempotency_key`.

If extending the existing `analysis` table instead:

- Remove or relax unique `meeting_id` only after defining current-run semantics.
- Add first-class cache/status/provider/model columns.
- Add a composite uniqueness constraint for the cache identity.
- Accept that this is higher risk for MVP because it mixes compatibility projection, cache history, rerun state, and current-row semantics in one table.

## Migration / Backfill Strategy

First MVP implementation can ship the new table without requiring a full historical backfill.

Policy:

- New analyses must write the full cache identity going forward.
- Existing `analysis` rows may be imported best-effort into the new runs table.
- If transcript hash, provider, model, prompt version, or schema version is missing, mark the imported row with `analysis_input_mode=legacy_import` or an equivalent `identity_quality=legacy_import`.
- If a deterministic identity must be generated from incomplete data, mark it as `fallback_identity` and do not treat it as equivalent to a canonical cache hit.
- Imported legacy rows may be served as compatibility/current analysis for their meeting, but should not be reused as fresh cache hits for a full 7U identity unless all required identity fields match.
- Backfill is optional for the first MVP implementation slice.

## Implementation Slices

- `7U-A Audit + spec`: this document and audit report.
- `7U-B DB/model metadata`: add durable columns/table and response DTO metadata.
- `7U-C Cache key + hit/miss service logic`: centralize cache identity building and lookup.
- `7U-D Gemini job idempotency/rerun guard`: align Redis locks with durable cache identity and rerun modes.
- `7U-E Export/DOCX integration`: use durable cache/read-only status, never lazy provider calls.
- `7U-F FE status/reanalyze minimal`: expose cached/stale/quota states and re-analyze entry point.
- `7U-G Tests/smoke checklist`: targeted service tests for cache hit/miss/stale/rerun/export.

7U-B implementation note:

- The foundation table is named `meeting_analysis_runs`.
- `analysis` remains the compatibility/current projection with its unique `meeting_id`.
- `owner_id` is nullable for the MVP because AI-service does not currently own user tenancy.
- New batch and realtime completed analyses write durable run metadata; full cache hit/miss, stale, retry, and rerun policy is deferred to 7U-C/7U-D.

7U-C implementation note:

- AI-service now centralizes cache identity construction and completed-run lookup in `analysis_runs.py`.
- Batch processing and realtime/lazy analysis check `meeting_analysis_runs` before calling the analysis provider; matching completed runs return `cacheHit=true` metadata and do not create duplicate run history.
- Cache misses preserve existing provider behavior and persist a completed run through the 7U-B write path.
- Identity matching is meeting-scoped and includes provider, model, prompt/schema, canonical transcript hash/version when available, fallback input mode, recognition mode, transcript language, and speaker stabilization version when provided.
- Full rerun/idempotency policy, explicit stale lifecycle responses, and durable failed/quota transitions remain deferred to 7U-D.
- DOCX/export DB fallback remains deferred to 7U-E.

## Test Matrix

- Cache hit does not call Gemini.
- Transcript hash change returns `STALE` in `cache_only` mode or starts/continues new analysis in `auto` mode.
- Provider, model, prompt version, or schema version change misses cache.
- `force` rerun creates a new run/version and preserves the historical run.
- Quota/rate-limit provider failures store `QUOTA_BLOCKED` or `RATE_LIMITED`.
- DOCX/export does not call Gemini.
- Redis job state expiry still allows DB cached analysis to be served.
- Double-submit rerun for the same identity does not start two provider calls.

## Acceptance Criteria

- Reopening meeting detail does not call Gemini when matching completed analysis exists.
- DOCX/report export does not call Gemini.
- Cache hit is determined by the full cache key policy, not just `meeting_id`.
- Transcript hash/version changes result in `STALE` or a new analysis request, never silent reuse.
- Prompt/schema/provider/model changes result in miss/stale, never silent reuse.
- Failed/quota/rate-limit states are visible to API callers.
- Duplicate analysis submissions for the same cache identity do not start concurrent provider calls.
- Existing 7Q and 7S behavior remains unchanged.

## Risks / Migration Notes

- Current `analysis` unique `meeting_id` blocks versioned analysis history.
- Extending `analysis` directly for versioned history risks breaking existing readers that assume one row per meeting.
- Current batch `_save_results` creates a new `Analysis` row and can fail on duplicate meeting processing unless upstream idempotency prevents it.
- Current DOCX report depends on Redis job state for analysis and may omit DB-persisted analysis after TTL.
- Provider/model are known in settings/analyzer but are not stored in analysis payloads or DB rows.
- Owner scope lives in meeting-service, not AI-service DB, so cache lookup may need a passed-through owner id or trusted meeting metadata fetch.
- Canonical sidecar may be absent for older meetings; fallback identity must be explicit.

## Rollback Plan

- Keep existing single-row `analysis` reads working while introducing new cache records.
- Gate new cache lookup/write behavior behind a config flag if needed.
- On rollback, continue serving the latest compatible `analysis` row and disable new rerun modes.
- Preserve old analysis rows/cache records during rollback; do not delete historical records as part of rollback.
- Leave 7Q canonical transcript and 7S stabilization untouched.

## Open Questions

- Where should owner scope be sourced for AI-service cache rows: passed from processing-service, copied from meeting-service, or omitted for MVP because meeting id is globally unique?
- Should provider/model metadata be returned by AI-service directly or enriched by processing-service from settings?
- Should the compatibility/current projection in `analysis` be updated synchronously when a run completes, or by a small reconciliation step?
