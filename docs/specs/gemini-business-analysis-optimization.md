# 7M - Gemini Business Analysis Optimization

## 1. Status
- SPEC-ONLY
- Branch: feature/gemini-business-analysis-spec
- Date: 2026-05-29
- No runtime changes

## 2. Background
- This phase follows 7K-pre Meeting History and 7L Realtime Pause/Resume.
- The current analysis stack already produces structured output for summary-first meeting analysis.
- Business and company meetings need a richer analysis shape with decisions, action items, risks, blockers, owners, deadlines, and next steps.
- The goal is to improve business analysis quality without changing STT routing, realtime pause/resume behavior, or rewriting the whole analysis pipeline.

## 3. Goals
- Improve Gemini analysis quality for business/company meetings.
- Reduce duplicate Gemini calls for the same unchanged meeting transcript.
- Stabilize JSON output and schema handling.
- Add prompt versioning and schema versioning to the analysis plan.
- Add transcript hash based cache/idempotency rules.
- Define a long transcript strategy with token counting and chunk/summarize fallback.
- Improve FE rendering for business-oriented analysis fields.

## MVP scope

MVP 7M should include:
- business-focused prompt/schema additions
- promptVersion + schemaVersion constants
- transcriptHash-based reuse decision
- cache hit must skip Gemini
- legacy-compatible FE display for business fields
- tests for cache hit, changed transcript, invalid JSON, and FE fallback

Later / not required for MVP:
- Batch API backfill
- context caching
- full DB migration for old records
- advanced chunk evidence storage
- manual rerun UX

## 4. Non-goals
- No STT optimization.
- No realtime pause/resume change.
- No auth redesign.
- No full AI provider rewrite.
- No Batch API for the immediate realtime demo path.
- No database redesign unless a blocking storage gap is proven.
- No contract-breaking change unless backward compatibility cannot be preserved.

## 5. Current system audit

### Backend / AI inventory
| Area | File/path | Current behavior | Gap |
| ---- | --------- | ---------------- | --- |
| Gemini analyzer wrapper | [demoRecordAUDIOMID/ai-service/app/services/gemini_analyzer.py](../demoRecordAUDIOMID/ai-service/app/services/gemini_analyzer.py) | Thin wrapper over `AIAnalyzer`; Gemini configuration is passed through from settings. | The wrapper itself is not the problem; business optimization lives in analyzer behavior and persistence, not in the wrapper. |
| Gemini prompt and schema | [demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py](../demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py) | Builds a structured JSON schema with `summary`, `keywords`, `technicalTerms`, `painPoints`, `actionItems`, and `domainMode`; uses Gemini structured output when available. | The prompt is still generic meeting analysis, not business-meeting-specific, and it does not yet express business-oriented sections like decisions, blockers, owners, deadlines, or next steps. |
| Structured output parsing | [demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py](../demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py) | Validates and normalizes Gemini JSON; retries transient HTTP errors and handles `MAX_TOKENS` / invalid JSON fallback paths. | JSON stability is good, but the schema is still too narrow for business analysis and has no explicit prompt/schema version envelope. |
| Analysis model shapes | [demoRecordAUDIOMID/ai-service/app/schemas.py](../demoRecordAUDIOMID/ai-service/app/schemas.py) | `AnalysisResponse` already exposes legacy and newer fields such as `technicalTerms`, `painPoints`, `actionItems`, and `domainMode`. | The response shape is mixed legacy/new and still lacks first-class business analysis fields for decisions, blockers, owners, deadlines, and next steps. |
| Analysis provider selection | [demoRecordAUDIOMID/ai-service/app/services/analysis_factory.py](../demoRecordAUDIOMID/ai-service/app/services/analysis_factory.py) | Routes to Gemini, OpenAI, or Ollama based on config. | Provider selection is fine; business optimization should not require a provider rewrite. |
| Batch analysis execution | [demoRecordAUDIOMID/ai-service/app/tasks.py](../demoRecordAUDIOMID/ai-service/app/tasks.py), [demoRecordAUDIOMID/ai-service/app/pipeline.py](../demoRecordAUDIOMID/ai-service/app/pipeline.py) | Upload processing runs STT, then analysis, then stores transcript/analysis into Redis job state and AI-service persistence. | The batch path is already centralized, but the analysis payload still needs a business-focused schema and a clearer idempotency policy. |
| Realtime lazy analysis trigger | [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java) | Computes `transcriptHash`, dedupes/locks via `JobStateStore`, and triggers realtime analysis when a read path needs it. | Cache/idempotency currently centers on meeting + transcript hash; prompt version and schema version are not part of the visible trigger contract. |
| Analysis read API | [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java) | Exposes `/processing/{meetingId}/analysis` and `/processing/{meetingId}/analysis/saved`. | The read path already exists, but the plan needs explicit rules for reuse versus reanalysis. |

### Data / cache inventory
| Data | Current storage | Cache key available? | Gap |
| ---- | --------------- | -------------------- | --- |
| Transcript text | AI-service transcript rows, plus Redis job-state result for batch flow | Partially, via `meetingId + transcriptHash` in the processing-service realtime path | No prompt/version envelope is attached to the reuse decision. |
| Analysis result | AI-service analysis table and Redis job-state result blob | Partially, if the stored result is still associated with the same meeting/transcript | There is no business-analysis cache contract that explicitly includes prompt/schema versioning. |
| Realtime analysis state | Redis-backed `JobStateStore` in processing-service | Yes, for lock/status/cooldown semantics | It is optimized for live polling and duplicate suppression, not for a richer business-analysis cache contract. |

### Frontend inventory
| Area | File/path | Current behavior | Gap |
| ---- | --------- | ---------------- | --- |
| Analysis panel | [FE-Audiomind/src/components/analysis/AnalysisPanel.tsx](../FE-Audiomind/src/components/analysis/AnalysisPanel.tsx) | Renders summary, keywords, technical terms, pain points, and action items. | It does not render decisions, blockers, owners, deadlines, next steps, or confidence. |
| Analysis normalization | [FE-Audiomind/src/types/index.ts](../FE-Audiomind/src/types/index.ts) | Normalizes legacy and structured analysis payloads, including `technicalTerms`, `painPoints`, and `actionItems`. | The FE can accept richer data later, but the current type model is still centered on the legacy analysis shape. |
| Analysis tests | [FE-Audiomind/src/components/analysis/AnalysisPanel.test.tsx](../FE-Audiomind/src/components/analysis/AnalysisPanel.test.tsx) | Covers rendering of the current structured sections and loading/empty/error states. | Tests do not yet assert business-oriented fields or fallback compatibility for a richer schema. |

## 6. Proposed business analysis schema

The business analysis payload should remain JSON-first and backward compatible.

Recommended fields:

- `summary`
- `meetingSummary`
- `keyDecisions[]`
- `actionItems[]`
- `risks[]`
- `blockers[]`
- `questions[]`
- `deadlines[]`
- `owners[]`
- `nextSteps[]`
- `businessImpact`
- `customerImpact`
- `technicalImpact`
- `confidence`

Recommended action item shape:

- `task`
- `owner`
- `dueDate`
- `priority`
- `status`
- `evidence`

Recommended supporting metadata:

- `transcriptHash`
- `promptVersion`
- `schemaVersion`
- `analysisVersion`
- `source`
- `tokenUsage`

Rules:

- Keep legacy fields readable for older records.
- Prefer an additive shape over a breaking response replacement.
- Normalize empty lists instead of omitting them when the model has no evidence.
- Avoid hallucinating owners or due dates when they are not explicitly present in the transcript.

## 7. Gemini optimization design

### Duplicate-call prevention
- Compute `transcriptHash` from the finalized transcript text.
- Persist or reuse `promptVersion` and `schemaVersion` alongside the analysis result.
- Cache key should be `meetingId + transcriptHash + promptVersion + schemaVersion`.
- If a completed analysis already matches the cache key, return the stored result and do not call Gemini again.
- If transcript text changes, treat it as a new analysis candidate only when the read path explicitly allows refresh or re-run.
- Changed transcriptHash should only create new work in the write/trigger path, not when a user opens history/detail in read-only mode.
- A failed analysis must never be counted as a completed cache hit.

### Structured output
- Keep strict JSON/schema validation where the current Gemini client supports it.
- Parse and validate before saving.
- Save raw provider response only if safe and useful for debugging, and never expose secrets or full transcript text.
- Return one stable business analysis shape to the FE.

### Long transcript strategy
- Count tokens before analysis.
- If the transcript fits the configured threshold, run one structured business-analysis pass.
- If it is too long, keep the MVP path conservative: document the threshold, guard the oversized case, and keep the existing truncate/chunk helper behavior from blocking the cache/schema/business-display work.
- Full chunk -> chunk summaries -> final synthesis can be a later slice if the implementation scope is too large.
- Preserve evidence references where possible, using chunk labels or segment indices instead of raw transcript duplication when chunking is later implemented.
- Keep the chunk path deterministic so the same transcript produces the same chunk boundaries.

### Retry / fallback
- Retry transient Gemini errors with a small capped retry budget.
- Retry JSON parse failure once with a repair prompt or a stricter schema path if that is already supported by the implementation.
- Mark analysis failed with a clear reason if the output remains invalid.
- Do not retry endlessly on invalid JSON.

### Cost controls
- Avoid repeated analysis for the same unchanged transcript.
- Avoid analysis on pause/resume.
- Avoid analysis on history-open or read-only detail navigation.
- Use context caching only if repeated large prompt instructions are demonstrably expensive.
- Consider Batch API only for non-urgent backfill or evaluation jobs, not for the realtime demo path.

## 8. FE plan

- Render business-oriented cards for summary, decisions, action items, risks/blockers, and next steps.
- Highlight owner, due date, and priority when available.
- Handle missing owner and missing due date gracefully.
- Keep older records readable when new fields are absent.
- Preserve the current analysis panel language and layout patterns rather than rewriting the whole UI.
- Legacy fields must continue to render when business fields are absent.
- New fields must stay additive and must not break `summary`, `keywords`, `technicalTerms`, `painPoints`, or `actionItems`.

## 9. Implementation slices

### Slice 1 - Audit + schema
- Confirm the current analysis shape and storage envelope.
- Define the business analysis schema and metadata fields.
- Add prompt/schema versioning rules to the spec.
- Order matters: add schema first, then version constants, then reuse rules, then display fallback.

### Slice 2 - Cache / idempotency
- Add `transcriptHash`, `promptVersion`, and `schemaVersion` to the reuse decision.
- Skip duplicate Gemini calls when the completed result already matches the cache key.
- Same `meetingId + transcriptHash + promptVersion + schemaVersion` must return stored completed analysis.

### Slice 3 - Structured output validation
- Enforce or validate JSON.
- Improve parse failure handling.
- Keep safe fallbacks for invalid or incomplete provider output.
- Keep `owner`, `dueDate`, and `confidence` conservative when the transcript does not support them.

### Slice 4 - Long transcript handling
- Add token counting.
- Define chunking and synthesis behavior for oversized transcripts.
- Long transcript synthesis stays later if it threatens MVP cache/schema/display delivery.

### Slice 5 - FE business display
- Render decisions, action items, risks/blockers, owners, deadlines, and next steps.
- FE must render legacy fields normally if business fields are absent.

### Slice 6 - Tests / validation
- Cache hit does not call Gemini.
- Changed transcript causes a new analysis path.
- Invalid JSON is handled safely.
- Long transcript path is covered.
- FE displays business fields and still accepts legacy records.
- Add coverage for read-only history/detail not calling Gemini.

## 10. Risk matrix

| Risk | Impact | Likelihood | Mitigation |
| ---- | ------ | ---------- | ---------- |
| Duplicate Gemini cost | Same meeting may be analyzed more than once. | High | Bind reuse to `meetingId + transcriptHash + promptVersion + schemaVersion`. |
| Invalid JSON | Analysis may fail or become partially saved. | Medium | Keep strict validation and safe fallback handling. |
| Over-strict schema | Useful free-form business info may be dropped. | Medium | Keep additive optional fields and a conservative fallback path. |
| Transcript too long | Gemini may truncate or fail on large meetings. | High | Use token counting and chunk/summarize synthesis. |
| Old analysis records incompatible | Historical meetings may lack new fields. | Medium | Keep legacy fields and show graceful empty states. |
| Owner/due date hallucination | Model may invent action-item metadata. | High | Require evidence and leave fields blank when the transcript does not support them. |
| Business summary too generic | The output may still feel like generic meeting notes. | Medium | Add business-specific prompt guidance and stronger output examples. |
| Retry loop increases cost | Retry policy can multiply token spend. | Medium | Cap retries and do not retry parse failures indefinitely. |

## 11. Acceptance criteria

- Existing completed analysis is reused when transcript, prompt version, and schema version are unchanged.
- Gemini is not called when opening history/detail for an unchanged meeting.
- Gemini is not called during realtime pause/resume.
- The new business schema is documented.
- JSON parse and validation failure are handled safely.
- A long transcript strategy is defined.
- The FE can display business meeting fields.
- STT routing, default language, and multi behavior remain unchanged.
- No realtime pause/resume behavior changes are introduced.
- Same `meetingId + transcriptHash + promptVersion + schemaVersion` returns stored completed analysis.
- Cache hit does not call Gemini.
- Changed transcriptHash allows new analysis only in write/trigger paths, not in read-only history/detail paths.
- Failed analysis is not treated as a completed cache hit.

## 12. Validation plan

Implementation commands to run later:

```bash
git diff --stat
git diff --name-only
git diff --check -- docs/specs/gemini-business-analysis-optimization.md docs/reports/gemini-analysis-audit-results.md
git status --short --untracked-files=all
```

If backend Python files are changed later:

```bash
python -m pytest -q demoRecordAUDIOMID/ai-service/tests
```

If FE display files are changed later:

```bash
cd FE-Audiomind
npm test -- src/components/analysis/AnalysisPanel.test.tsx
npm run build
```

If backend Java read-path files are changed later:

```bash
cd demoRecordAUDIOMID
.\mvnw test --no-transfer-progress
```

## 13. Open questions

- Should old analysis records be migrated or displayed with a legacy fallback?
- Should the user be able to rerun analysis manually from history/detail?
- Should action items support owner assignment later?
- Should due dates be extracted only when they are explicitly mentioned?
- Should context caching be used for repeated business prompt instructions?
