# Phase 7T - F8/Search-A/Export-A Integration Plan

Status: SPEC-ONLY

Branch: `docs/7t-qa-f6-start-resume-preroll-mic-sensitivity-spec`

Date: 2026-06-11

This document coordinates the spec-only plans for:

- 7T-QA-F8 - Analysis Prompt + Token Optimization
- 7T-Search-A - Transcript Evidence Search
- 7T-Export-A - Meeting Action Plan Export

No production code is implemented by this plan.

## 1. Dependency Order

Recommended dependency order:

1. F8
2. Search-A
3. Export-A
4. FE integration
5. Final manual test pass

Why:

- F8 defines stable saved analysis and action-item evidence fields.
- Search-A turns saved transcript segments into reusable evidence objects.
- Export-A combines saved analysis action items with Search-A evidence.
- FE integration should wait until backend contracts are stable.
- A final manual pass should verify F6 realtime and F7 Gemini fallback were not disturbed.

## 2. Shared Data Contract

### F8 action item contract

F8 should expose rich action items canonically in `action_items`, mirror the same rich list to `businessActionItems` for FE/report compatibility, and preserve legacy `actionItems` as a string list.

Required rich fields:

| Field | Type | Notes |
| ----- | ---- | ----- |
| `task` | string | Required after normalization. |
| `owner` | string or null | Only when transcript explicitly supports it. |
| `deadline` | string or null | Preferred new field. |
| `dueDate` | string or null | Compatibility alias. |
| `priority` | `low|medium|high` or null | Normalize invalid values safely. |
| `status` | `open|in_progress|blocked|done` | New output emits only these four values. Legacy `pending` normalizes to `open`, `completed` to `done`, `cancelled` to `blocked`, and invalid/unknown to `open`. |
| `evidenceKeywords` | string[] | Search-A query hints. |
| `evidenceQuote` | string or null | Legacy/unverified optional field only. New F8 prompt/schema should prefer `evidenceKeywords`. Do not log it. |
| `evidence` | string or null | Compatibility alias for existing report code; unverified unless Search-A resolves matching segment text. |

Versioning:

- F8 must set `PROMPT_VERSION=gemini-business-v2`.
- F8 must set `SCHEMA_VERSION=gemini-business-v2`.
- Existing saved analysis remains readable.
- New analysis and force re-analysis should produce F8-shaped output.
- The version bump prevents cache/idempotency confusion between older and F8 analysis shapes.

### Search-A evidence contract

Search-A should return reusable evidence objects:

| Field | Notes |
| ----- | ----- |
| `evidenceId` | Stable within meeting/query result. |
| `segmentId` or `index` | Links evidence to transcript segment. |
| `speaker` | Display speaker. |
| `startTime` / `endTime` | Numeric seconds. |
| `text` | Matching segment text. |
| `contextBefore` / `contextAfter` | Same-meeting context window. |
| `score` / `rank` | Deterministic ranking. |
| `transcriptMode` | `canonical` or `raw` at response level. |

Search-A response caps:

- Max `limit`: 50.
- Max `context`: 3.
- Max match text length: 800 characters.
- Max context row text length: 400 characters.
- Include `textTruncated` or equivalent truncation metadata when text/context is capped.
- Include `canonicalTranscriptHash` and `canonicalTranscriptVersion` when available.
- Do not expose deep raw sidecar metadata in MVP.

### Export-A reuse

Export-A should:

- Read saved analysis only.
- Use rich action items from F8.
- Resolve `evidenceKeywords` through Search-A service/helper when available.
- Prefer verified Search-A evidence over unverified Gemini-generated `evidenceQuote` when both exist.
- Treat Search-A verified segment text as the only trusted evidence.
- Use legacy `evidenceQuote`/`evidence` only as an unverified note when Search-A has no match.
- Use `"No transcript evidence available"` when no verified or unverified evidence exists.
- Return 200 with `actionItems=[]` and a clear note when saved analysis exists but contains no action items.
- Return 409 `ANALYSIS_REQUIRED` only when required saved analysis is missing.
- Never call Gemini during export.
- Never call lazy analysis, STT, Whisper, Ollama, or process/start paths during export.

## 3. Recommended Final Implementation Order

1. Specs now.
2. F8 backend:
   - Add/confirm prompt/schema constants.
   - Add evidence fields to parser/normalizer.
   - Add token/log safety tests.
3. Search-A backend:
   - Add app-level transcript evidence search service.
   - Add owner-scoped API endpoint.
   - Add search/auth tests.
4. Export-A backend:
   - Add action-plan DTO/builder.
   - Add DOCX generator.
   - Add JSON preview and DOCX export endpoints.
   - Add no-Gemini/no-lazy-analysis tests.
5. FE integration:
   - Add transcript evidence search helper and lightweight UI in meeting detail.
   - Add action-plan export helper/button.
   - Keep existing report and transcript export intact.
6. Full automated tests relevant to touched areas.
7. Docker/local manual test, but only when moving from spec to implementation.
8. Log collection review for metadata-only behavior.

Do not batch uncontrolled changes across gates. It is acceptable to implement sequentially in one agent session only if the agent reports progress by gate and runs the gate-specific tests before moving on.

## 4. Implementation Gates

### Gate 1 - F8 Backend Only

Scope:

- Prompt/schema version bump to `gemini-business-v2`.
- Canonical `action_items` rich field.
- `businessActionItems` and `actionItems` compatibility preservation.
- Evidence hint/note fields and parser/normalizer tests.
- Token guard remains current approximation/truncation; no `countTokens`.
- No F7 `GeminiKeyManager`/`GeminiClient` rewrite.

Tests after Gate 1:

- `rtk pytest demoRecordAUDIOMID/ai-service/tests/test_gemini_analyzer.py`
- `rtk pytest demoRecordAUDIOMID/ai-service/tests/test_realtime_analysis_endpoint.py`
- `rtk pytest demoRecordAUDIOMID/ai-service/tests/test_analysis_runs.py`

Definition of Done:

- No out-of-scope files changed.
- No F6/F7 regression or rewrite.
- Gate-specific tests pass.
- Existing related tests still pass.
- No raw prompt/transcript/key logs added.
- No open questions remain for F8 implementation.
- Agent reports files changed and tests run before moving to Gate 2.

### Gate 2 - Search-A Backend Only

Scope:

- `GET /processing/{meetingId}/transcript/search`.
- App-level processing-service search helper.
- Same readable transcript source as meeting detail: canonical first, raw/readable fallback.
- Case-insensitive and Vietnamese diacritic-insensitive matching.
- No DB migration, no PostgreSQL FTS, no vectors/embeddings.
- Internal helper usable by Export-A without HTTP loopback.

Tests after Gate 2:

- Processing-service unit tests for transcript search helper.
- Processing-service controller tests for endpoint validation/auth.
- Existing transcript retrieval/export tests touched by shared helpers.
- Suggested command shapes from `demoRecordAUDIOMID/processing-service` once implementation exists:
  - `rtk test .\mvnw.cmd -Dtest=*Transcript* test`
  - `rtk test .\mvnw.cmd -Dtest=ProcessingControllerReportTest test`
- If exact Maven wildcard syntax is uncertain, the agent must inspect existing Maven test command style before running.

Definition of Done:

- No out-of-scope files changed.
- No F6/F7 regression or rewrite.
- Gate-specific tests pass.
- Existing related transcript/controller tests still pass.
- No raw query/transcript/context/key logs added.
- No open questions remain for Search-A implementation.
- Agent reports files changed and tests run before moving to Gate 3.

### Gate 3 - Export-A Backend Only

Scope:

- JSON action-plan preview.
- DOCX action-plan export with dedicated `MeetingActionPlanDocxGenerator`.
- Missing saved analysis returns 409 `ANALYSIS_REQUIRED`.
- Missing evidence succeeds with `"No transcript evidence available."`
- Existing `/processing/{meetingId}/report` unchanged.
- No Gemini, lazy analysis, STT, Whisper, Ollama, or process/start calls.

Tests after Gate 3:

- Processing-service action-plan builder tests.
- `MeetingActionPlanDocxGenerator` tests.
- Controller tests for JSON preview, DOCX headers/filename, unsupported format, missing analysis 409, auth/ownership.
- Existing report export tests to prove `/processing/{meetingId}/report` remains unchanged.
- Suggested command shapes from `demoRecordAUDIOMID/processing-service` once implementation exists:
  - `rtk test .\mvnw.cmd -Dtest=*ActionPlan* test`
  - `rtk test .\mvnw.cmd -Dtest=ProcessingServiceTest test`
  - `rtk test .\mvnw.cmd -Dtest=ProcessingControllerReportTest test`
- If exact Maven wildcard syntax is uncertain, the agent must inspect existing Maven test command style before running.

Definition of Done:

- No out-of-scope files changed.
- No F6/F7 regression or rewrite.
- Gate-specific tests pass.
- Existing report/export tests still pass.
- No raw prompt/transcript/query/key logs added.
- No Gemini/lazy analysis/STT/Whisper/Ollama/process-start calls introduced for export.
- No open questions remain for Export-A implementation.
- Agent reports files changed and tests run before moving to Gate 4.

### Gate 4 - FE Integration

Scope:

- Add Search-A FE helper calling `/processing/{meetingId}/transcript/search`.
- Add lightweight evidence search UI in meeting detail.
- Add action-plan export helper/button.
- Keep existing transcript load path and existing report/transcript export behavior.

Tests after Gate 4:

- FE API helper tests.
- Focused component tests around button/search states if the repo has matching test harness coverage.
- Suggested command shape: `rtk npm test -- --run FE-Audiomind/src/services/api.test.ts` from the FE project once implementation exists.

Definition of Done:

- No out-of-scope files changed.
- No F6/F7 regression or rewrite.
- Gate-specific tests pass.
- Existing related FE API/component tests still pass.
- No raw prompt/transcript/query/key logs added.
- No open questions remain for FE integration.
- Agent reports files changed and tests run before moving to Gate 5.

### Gate 5 - Final Combined Test

Scope:

- Confirm F6 markers remain intact.
- Confirm F7 fallback tests remain green.
- Confirm F8/Search-A/Export-A tests pass together.
- Manual local check only after implementation, not during this spec-only task.

Tests after Gate 5:

- Focused ai-service tests from Gate 1.
- Focused processing-service tests from Gates 2 and 3.
- Focused FE tests from Gate 4.
- Manual log review for no prompts, full transcripts, raw Gemini response, API keys, Authorization headers, or env secrets.

Definition of Done:

- No out-of-scope files changed.
- No F6/F7 regression or rewrite.
- Gate-specific and existing related tests pass.
- No raw prompt/transcript/query/context/key logs added.
- No open questions remain for MVP implementation.
- Agent reports files changed, tests run, and any remaining risks before finishing.

## 5. Combined Test Matrix Outline

| Category | Coverage |
| -------- | -------- |
| F6 regression | Realtime recorder/VAD/WebSocket markers remain intact; no recorder/VAD/WebSocket behavior changes in these phases unless separately approved. |
| F7 fallback | Gemini key manager/client retry/cooldown/fail-fast tests continue to pass; no rewrite of F7 fallback. |
| F8 analysis stability | Structured JSON, rich action items, legacy compatibility, no invented owner/deadline, invalid JSON fallback, token guard, safe logs. |
| Search keyword/evidence | Exact match, case-insensitive, Vietnamese diacritic-insensitive, phrase/token match, context windows, no result, long transcript. |
| Export action plan | FE-facing JSON preview, DOCX content, missing analysis 409, no evidence fallback, no action items as 200 with note, Vietnamese/special characters, filename/content type. |
| Cross-meeting/user leakage | Search and export both validate meeting ownership before transcript/analysis access; no matches from another meeting. |
| No secrets in logs | No prompts, full transcripts, raw Gemini response, API keys, Authorization headers, or env secrets. |

## 6. Risk Register

| Risk | Impact | Mitigation |
| ---- | ------ | ---------- |
| Prompt/schema too complex | Gemini may reject structured output or produce incomplete responses. | Keep schema shallow; add fields additively; keep HTTP 400 retry without schema. |
| Token reduction truncates important content | Missing tasks/evidence in long meetings. | Log length/hash only; add long transcript tests; defer map-reduce until real quality data justifies it. |
| Transcript search cross-user leakage | Severe privacy/security issue. | Put Search-A in processing-service; require principal; call meeting-service access check before loading transcript. |
| Export calls Gemini accidentally | Cost/privacy/regression issue. | Use saved analysis helpers only; add tests that mock/fail Gemini/lazy-analysis paths if called. |
| DOCX formatting complexity | Slow implementation and brittle tests. | Use simple Apache POI tables/headings; keep PDF/template styling out of MVP. |
| F6 regression | Realtime recording quality regresses. | Do not touch F6 files in these phases except FE placement-only UI work after backend contracts. |
| F7 regression | Gemini fallback behavior regresses. | Do not rewrite `GeminiKeyManager` or `GeminiClient`; keep F8 changes in prompt/schema/normalizer layer. |
| Evidence quote hallucination | Export cites unsupported text. | Prefer Search-A verified segment text; treat Gemini `evidenceQuote` as nullable hint until verified. |
| Uncontrolled batching | Bugs are harder to isolate and F6/F7 regressions can slip in. | Implement by gates, report by gate, and run gate-specific tests before continuing. |

## 7. Final Recommendation

Implement F8 first because it stabilizes the saved analysis contract that Search-A and Export-A depend on. Keep the F8 MVP focused on structured output validation, rich action item evidence fields, and token/log safety.

Then implement Search-A in processing-service as app-level transcript evidence search. This preserves the current owner/auth boundary and avoids a migration.

Finally implement Export-A as a dedicated DOCX action-plan export plus JSON preview. It should reuse saved analysis and Search-A evidence only, never call Gemini during export, and keep the existing general meeting report export unchanged.

## 8. What Must Not Change

- Do not modify F6 realtime recorder/VAD/WebSocket behavior.
- Do not rewrite F7 Gemini fallback/key manager.
- Do not re-enable Whisper or Ollama.
- Do not add real API keys.
- Do not log prompts, full transcripts, raw Gemini response, API keys, Authorization headers, or env secrets.
- Do not introduce vector search or embeddings in MVP.
- Do not make Export-A call Gemini during export.
- Do not introduce large DB migrations for MVP Search-A.
- Do not change billing/admin/upload validation.
- Do not implement production code as part of this spec-only task.
