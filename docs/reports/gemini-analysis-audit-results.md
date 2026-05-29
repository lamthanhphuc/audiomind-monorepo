# Gemini Analysis Audit Results

## Scope
- Branch: feature/gemini-business-analysis-spec
- Target phase: 7M - Gemini Business Analysis Optimization
- Status: audit only, no runtime implementation

## Method
- Used CodeGraph context for the analysis and transcript surface.
- Used targeted file reads for ai-service, processing-service, and FE analysis components.
- Focused on the minimum surface needed to answer the business-analysis audit questions.

## Answers to the audit questions

1. Gemini is currently called from the ai-service analysis layer in [demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py](../demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py) through the Gemini text/schema path, and the batch upload pipeline reaches it via [demoRecordAUDIOMID/ai-service/app/tasks.py](../demoRecordAUDIOMID/ai-service/app/tasks.py) and [demoRecordAUDIOMID/ai-service/app/pipeline.py](../demoRecordAUDIOMID/ai-service/app/pipeline.py).
2. The current prompt is a generic meeting-analysis JSON prompt in [demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py](../demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py), not a business-meeting-specific prompt.
3. Yes, JSON/schema validation exists. Gemini structured output is requested when available, and the response is parsed and normalized before storage.
4. Analysis is stored in the ai-service analysis table and also in Redis job state for the batch flow.
5. Yes, there is partial cache/idempotency. Processing-service uses `meetingId + transcriptHash` style guards for realtime lazy analysis, but there is no visible promptVersion/schemaVersion reuse key in the current flow.
6. Opening a saved history/detail view can reuse stored analysis if present, but the current read path still has live-trigger behavior on some routes and therefore needs read-only guarding for archive navigation.
7. If the transcript changes, the current transcript hash changes, so the lazy trigger logic can treat it as new work. There is still no explicit prompt/schema version in the cache contract.
8. Yes, retry and parse fallback exist. The Gemini helper retries transient HTTP errors, handles `MAX_TOKENS`, and falls back safely on parse failures.
9. Long transcripts are handled by token-budget truncation and chunk summary helpers, but there is not yet a dedicated business-analysis chunk/summarize/synthesize plan.
10. FE currently shows analysis through [FE-Audiomind/src/components/analysis/AnalysisPanel.tsx](../FE-Audiomind/src/components/analysis/AnalysisPanel.tsx) and normalizes data in [FE-Audiomind/src/types/index.ts](../FE-Audiomind/src/types/index.ts).
11. Business meetings still lack first-class display for decisions, blockers, owners, deadlines, next steps, and confidence.
12. The current cost risk is repeated Gemini calls on unchanged meetings, plus oversized transcript calls that rely on truncation rather than a business-specific long-transcript synthesis strategy.

## Current flow summary
- Upload flow: batch processing runs STT, then analysis, then stores transcript and analysis for later reads.
- Realtime flow: transcript finalization already exists, and lazy analysis can be triggered from the read path when the transcript is missing in job state.
- FE analysis display: the UI can render structured summary/keywords/technical terms/pain points/action items, but it does not yet have business-first fields like decisions, blockers, owners, deadlines, or next steps.

## MVP vs later

MVP 7M should cover:
- business-focused prompt/schema additions
- promptVersion + schemaVersion constants
- transcriptHash-based reuse decision
- cache hit skipping Gemini
- legacy-compatible FE display for business fields
- tests for cache hit, changed transcript, invalid JSON, and FE fallback

Later / not required for MVP:
- Batch API backfill
- context caching
- full DB migration for old records
- advanced chunk evidence storage
- manual rerun UX

## Cache / idempotency gaps
- Reuse is centered on transcript hash, but prompt version and schema version are not part of the visible reuse key.
- The current runtime plan does not yet describe a durable business-analysis cache contract.
- The read-only analysis path should not launch new work when the user opens history/detail.
- Failed analysis must not be treated as a completed cache hit.

## Business schema proposal
- Keep summary as the primary headline.
- Add explicit business sections for decisions, action items, risks, blockers, owners, deadlines, and next steps.
- Represent action items as objects when possible, not as plain strings.
- Keep compatibility with legacy records by preserving the old fields.
- Owner should be filled only when the transcript or speaker evidence makes it explicit.
- DueDate should be filled only when a clear deadline or date is stated.
- If either field is not certain, leave it null or empty rather than guessing.
- Every action item should carry a short evidence snippet when possible.
- Confidence should reflect transcript certainty rather than defaulting high.

## Legacy compatibility
- Old analysis records do not need a migration in MVP.
- FE must render legacy fields normally if business fields are absent.
- New fields must remain additive and must not break `summary`, `keywords`, `technicalTerms`, `painPoints`, or `actionItems`.

## Long transcript strategy
- Count tokens first.
- Use one pass for short/medium transcripts.
- For long transcripts, document the threshold and keep the existing helper behavior from blocking cache/schema/business-display MVP work.
- A full chunk -> chunk summaries -> final synthesis flow can be a later slice if the implementation scope is too large.
- Keep chunk boundaries deterministic if chunking is later implemented.

## Recommended implementation plan
1. Add business schema plus prompt/schema version constants.
2. Add cache/idempotency guard with transcriptHash plus versions.
3. Add or adjust structured output normalization.
4. Add FE business display with legacy fallback.
5. Add tests.
6. Long transcript synthesis only if feasible after MVP.

## Open questions / blockers
- Should old records be migrated or shown with a legacy fallback?
- Should manual rerun be available from history/detail?
- Should owners and due dates remain optional until the transcript explicitly supports them?
- Should chunk-level evidence be stored or only displayed transiently?

## Confirmation
- Spec-only.
- No runtime changes.
- No commit.
