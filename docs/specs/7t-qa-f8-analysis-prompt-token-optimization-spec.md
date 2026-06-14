# Phase 7T-QA-F8 - Analysis Prompt + Token Optimization

Status: SPEC-ONLY

Branch: `docs/7t-qa-f6-start-resume-preroll-mic-sensitivity-spec`

Date: 2026-06-11

This document is a spec and implementation plan only. It does not implement production code.

External docs verification completed against official docs:

- Gemini structured outputs: https://ai.google.dev/gemini-api/docs/structured-output
- Gemini token counting: https://ai.google.dev/gemini-api/docs/tokens

Key external findings:

- Gemini can be configured to return structured JSON matching a provided schema, but the docs still recommend application-side validation for semantic correctness.
- Gemini structured output supports a subset of JSON Schema; schema complexity can be rejected, so the MVP schema must stay shallow.
- Gemini token docs describe `countTokens` for exact request-size checks. F8 MVP explicitly does not implement it; the repo should keep the current token guard/truncation behavior plus safe metadata logs. `countTokens` remains future work only if long transcript quality or provider-limit issues appear.

## 1. Problem Statement

Gemini analysis is now central to saved meeting detail, transcript evidence search, and export. The current system already has structured Gemini output, but several risks remain:

- Gemini output can still be unstable or semantically incomplete.
- Rich action item fields may be inconsistent across `actionItems`, `action_items`, and `businessActionItems`.
- Long transcripts can exceed the intended analysis budget or force lossy truncation.
- Search-A and Export-A need stable fields for evidence mapping.
- Logs must remain metadata-only and must not expose prompts, transcripts, raw Gemini response text, API keys, Authorization headers, or env secrets.

## 2. Current Implementation Audit

Files and symbols inspected:

| Area | File/symbol | Finding |
| ---- | ----------- | ------- |
| Gemini analyzer wrapper | `demoRecordAUDIOMID/ai-service/app/services/gemini_analyzer.py::GeminiAnalyzer` | Thin subclass over `AIAnalyzer`; default model is `gemini-2.5-flash`; passes F7 multi-key/retry/backoff settings through to the shared analyzer. Do not rewrite this F7 path. |
| Analyzer config | `demoRecordAUDIOMID/ai-service/app/config.py::Settings` | Defaults: `analysis_provider=gemini`, `local_whisper_enabled=False`, `ollama_enabled=False`, `gemini_analysis_max_input_tokens=12000`, `gemini_analysis_max_output_tokens=4096`, `gemini_analysis_thinking_budget=0`, `gemini_max_tokens_retry_enabled=True`, `gemini_max_single_request_chars=50000`. |
| Prompt builder | `AIAnalyzer._build_gemini_analysis_json_prompt` | Prompts for JSON only, Vietnamese values, list limits, no transcript copying, no owner/dueDate hallucination, `promptVersion`, `schemaVersion`, and `domainMode`. Realtime mode tightens counts and text lengths. |
| Gemini response schema | `AIAnalyzer._build_gemini_response_schema`, `_action_item_schema` | Sends Gemini `responseSchema` with `summary`, `meetingSummary`, `keywords`, `technicalTerms`, `painPoints`, `actionItems`, decisions/risks/blockers/questions/deadlines/owners/nextSteps, impacts, confidence, versions, and domainMode. Action items currently include `task`, `owner`, `dueDate`, `priority`, `status`, `evidence`; no `evidenceKeywords` yet. F8 MVP should not ask Gemini to produce trusted `evidenceQuote`. |
| Gemini request path | `AIAnalyzer._call_gemini_text` | Calls `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` through `GeminiClient`, sends `responseMimeType=application/json`, optional `responseSchema`, `maxOutputTokens`, and `thinkingConfig`. Retries without schema on HTTP 400 and can retry `MAX_TOKENS` without schema using a larger output budget. |
| JSON parser | `AIAnalyzer._loads_json_strict`, `_extract_json_candidate`, `_repair_json_string` | Requires a JSON object, can strip surrounding/fenced text, attempts limited JSON repair, and raises `AnalysisParseError` for invalid JSON/object shape. |
| Normalizer | `AIAnalyzer._normalize_gemini_structured_analysis` | Coerces structured terms/pain points/action items; writes rich action items to `businessActionItems` and `action_items`; writes legacy string tasks to `actionItems`. Removes technical terms from keywords. |
| Action item normalization | `AIAnalyzer._normalize_business_action_items` | Accepts map or string items. Produces `task`, `owner`, `dueDate`, `deadline`, `priority`, `status`, `evidence`. Dedupes by task. |
| Storage prep | `AIAnalyzer.prepare_analysis_for_storage` | For Gemini, normalizes rich action items and legacy strings, keeps structured terms/pain points, decisions, risks, blockers, questions, owners, deadlines, impacts, confidence, prompt/schema versions, and transcript hash. |
| Empty/fallback analysis | `AIAnalyzer.analyze_meeting`, `_default_structured_analysis` | Empty transcript returns default structured analysis. Config/parse/unavailable/rate-limit failures in batch return a default structured analysis rather than crashing. Realtime path can surface provider errors through endpoint mapping. |
| Token guard | `AIAnalyzer.analyze_meeting`, `_truncate_to_token_budget` | Uses a word-count approximation and truncates to `analysis_max_input_tokens`. Logs `GEMINI_ANALYSIS_INPUT_TRUNCATED` if truncated. No exact Gemini `countTokens` call yet. |
| Logging | `app/logging_utils.py`, `AIAnalyzer.analyze_meeting`, `_call_gemini_text` | Logs transcript length, approximate tokens, transcript hash prefix, response metadata, token usage metadata, finish reason, and counts. Existing safe error helper redacts likely secret-bearing messages. |
| Python response DTO | `demoRecordAUDIOMID/ai-service/app/schemas.py::AnalysisResponse`, `ActionItem` | Response includes rich `action_items`, legacy `actionItems`, `businessActionItems`, metadata, `technicalTerms`, `painPoints`, `domainMode`, retry metadata, and transcript/canonical transcript fields. `ActionItem` has `task`, `owner`, `dueDate`, `deadline`, `priority`, `status`, `evidence`. |
| Processing API DTO | `processing-service/controller/dto/AnalysisResponse.java` | Wraps `meetingId` plus arbitrary `Map<String,Object> data`; compatible with additive fields. |
| Processing analysis read | `ProcessingService.getAnalysisInternal` | Enforces meeting access, returns state analysis first, falls back to ai-service saved analysis, and lazy-triggers only when `allowLazyTrigger=true`. `/analysis/saved` uses read-only behavior. |
| Frontend normalization | `FE-Audiomind/src/types/index.ts::normalizeAnalysisResponse` | Normalizes nested `data`, `technicalTerms`, `painPoints`, `actionItems`, `businessActionItems`, decisions, risks, blockers, owners, deadlines, metadata, and domain mode. Current `AnalysisActionItem` has `task`, `owner`, `dueDate`, `deadline`, `priority`, `status`, `evidence`. |
| Frontend detail UI | `FE-Audiomind/src/components/features/MeetingHistoryScene.tsx` | Loads meeting detail, transcript, and saved analysis; renders `AnalysisPanel` and existing export controls. |
| Tests | `test_gemini_analyzer.py`, `test_realtime_analysis_endpoint.py`, `test_analysis_runs.py`, FE `api.test.ts` | Gemini tests cover valid JSON, missing fields, invalid JSON, no invented owner/dueDate, schema and output budget, realtime compaction, schema 400 fallback, `MAX_TOKENS` retry/disable behavior, safe HTTP preview logging, no API key logging, response metadata logging, and long transcript truncation. Realtime tests cover empty transcript, parse failures, rate-limit metadata, idempotency, cooldown, and in-progress guards. |

Likely implementation file targets:

- `demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py`
- `demoRecordAUDIOMID/ai-service/app/schemas.py`
- `demoRecordAUDIOMID/ai-service/app/services/analysis_runs.py` only if version metadata handling needs test support
- `demoRecordAUDIOMID/ai-service/tests/test_gemini_analyzer.py`
- `demoRecordAUDIOMID/ai-service/tests/test_realtime_analysis_endpoint.py`
- `FE-Audiomind/src/types/index.ts` for additive type/normalizer support
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java` only if report/action extraction needs additive compatibility, not for Gemini/F7 behavior

F8 must not modify or rewrite `GeminiKeyManager`, `GeminiClient`, key cooldown, retry/backoff, or fail-fast behavior from F7.

## 3. Chosen Direction

Options considered:

| Option | Summary | Benefits | Risks |
| ------ | ------- | -------- | ----- |
| Simple prompt tuning | Only rewrite prompt text and examples. | Lowest code change. | Does not stabilize contracts enough for Search-A/Export-A; leaves action item evidence inconsistent. |
| Structured output plus validation | Keep Gemini structured output, tighten the schema, add semantic validation/normalization, and preserve compatibility aliases. | Matches current architecture and official Gemini guidance; low blast radius; supports Search-A/Export-A. | Schema can become too large; needs careful fallback behavior. |
| Chunk/map-reduce | Split long transcripts and merge partial analyses. | Better long-transcript recall. | More Gemini calls, more failure modes, higher F7 pressure, harder evidence consistency. |

Recommended MVP: structured output plus schema validation plus token guard/C-lite.

Meaning of C-lite:

- Keep one Gemini analysis request for normal transcripts.
- Keep the existing shallow response schema.
- Add richer action-item evidence fields additively.
- Strengthen validation and logging around long inputs and schema failures.
- Do not implement full map-reduce unless real long transcript tests show the current guard loses unacceptable content.

## 4. Proposed Output Schema

Canonical saved analysis should remain backward-compatible with current consumers.

Product decision: `action_items` is the canonical backend rich action item field. `businessActionItems` remains a compatibility alias for FE/report consumers, and `actionItems` remains the legacy string-list field. New F8 analysis and force re-analysis must preserve all three fields.

```json
{
  "summary": "string",
  "meetingSummary": "string",
  "keywords": ["string"],
  "technicalTerms": [
    {
      "term": "string",
      "meaning": "string",
      "category": "string"
    }
  ],
  "painPoints": [
    {
      "title": "string",
      "evidence": "string",
      "severity": "low|medium|high"
    }
  ],
  "actionItems": ["legacy task string"],
  "action_items": [
    {
      "task": "string",
      "owner": null,
      "deadline": null,
      "dueDate": null,
      "priority": "low|medium|high",
      "status": "open|in_progress|blocked|done",
      "evidence": null,
      "evidenceKeywords": ["string"]
    }
  ],
  "businessActionItems": [
    {
      "task": "string",
      "owner": null,
      "deadline": null,
      "dueDate": null,
      "priority": "low|medium|high",
      "status": "open|in_progress|blocked|done",
      "evidence": null,
      "evidenceKeywords": ["string"]
    }
  ],
  "domainMode": "general|it|business|education",
  "promptVersion": "string",
  "schemaVersion": "string",
  "confidence": 0.0
}
```

Action item rules:

- `task` is required after normalization. Drop items with blank task.
- `action_items` is canonical for backend storage and backend-to-backend contracts.
- `businessActionItems` must mirror `action_items` as a compatibility alias for FE/report code.
- `actionItems` must remain a legacy string list derived from rich item `task` values.
- `owner` is nullable and must be present only when explicitly supported by transcript/speaker content.
- `deadline` and `dueDate` are aliases. Keep both for compatibility; prefer `deadline` in new docs and map it to `dueDate` for existing FE/report code.
- `priority` enum: `low`, `medium`, `high`. If uncertain, normalize to `medium` or null based on current UI compatibility.
- New F8 output must emit only these statuses: `open`, `in_progress`, `blocked`, `done`.
- Parser/normalizer must accept legacy statuses safely:
  - `pending` -> `open`
  - `completed` -> `done`
  - `cancelled` -> `blocked`
  - unknown/invalid -> `open`
- `open` is the least risky repo-compatible fallback for unknown status because it preserves visibility without falsely marking work complete or blocked.
- `evidenceKeywords` is an additive list of Search-A query hints. It is not trusted evidence and must not be treated as proof by Export-A.
- F8 MVP should not ask Gemini to produce trusted `evidenceQuote`.
- `evidenceQuote` may be accepted only as a legacy/unverified optional field if already present in old payloads.
- Search-A verified segment text is the only trusted evidence for Export-A.
- Do not log `evidenceQuote` because it may contain transcript text.
- Keep `evidence` as the current compatibility alias for a legacy/unverified evidence note, not as trusted proof.
- Logging rule: implementation must never serialize or log full action item objects because they may contain `evidence`, `evidenceQuote`, task text, owner text, or deadline text copied from the transcript.
- Safe logs may include only action item counts, field presence booleans, normalized status counts, prompt/schema version, transcript hash prefix, and validation error codes.
- Tests must assert that `evidence`, `evidenceQuote`, full task text, and full action item payloads do not appear in logs.
## 5. Versioning and Cache/Idempotency

F8 must bump analysis versions:

- `PROMPT_VERSION=gemini-business-v2`
- `SCHEMA_VERSION=gemini-business-v2`

Existing saved analysis remains readable through current compatibility aliases and FE normalizers. New analysis and force re-analysis should produce the F8-shaped output with canonical `action_items`, `businessActionItems`, and legacy `actionItems`.

The version bump prevents cache/idempotency confusion between old and new analysis shapes:

- Existing cache entries keyed by older prompt/schema versions should not be mistaken for F8 results.
- Force re-analysis should write F8-shaped payloads and metadata.
- Read-only saved-analysis paths should continue returning older payloads without forcing migration.
- Search-A and Export-A should accept older payloads through compatibility normalization, but richer evidence behavior depends on F8-shaped `action_items`.

## 6. Token Optimization Plan

MVP behavior:

- Keep `gemini_analysis_max_input_tokens=12000` as the default guard unless quality tests prove it should change.
- Keep `gemini_analysis_max_output_tokens=4096` for non-realtime. Do not raise globally without cost/failure data.
- Keep realtime output compacting and realtime prompt limits.
- Limit normal analysis action items to 5 unless product requirements expand.
- Limit keywords/technicalTerms to 8 and painPoints to 5 for normal analysis.
- Keep prompt/schema shallow to avoid structured-output schema rejection.
- Log only input char count, approximate token count, transcript hash prefix, response char count, provider token usage metadata when returned by Gemini, finish reason, and item counts.
- Do not log prompt text, transcript text, full Gemini response text, Authorization headers, API keys, or env values.

Future exact counting, not MVP:

- Do not add `GeminiClient.count_tokens` in the F8 MVP.
- Consider exact `countTokens` only if approximate truncation causes long transcript quality issues or provider-limit errors.
- If later implemented, treat count-token failures as non-fatal and fall back to current approximation.

Long transcript strategy:

- For MVP, prefer deterministic truncation with explicit metadata over silent over-budget calls.
- Add metadata such as `analysisInputMode=truncated` and original/used approximate tokens only if safe and not user-confusing.
- Future map-reduce should be a separate phase if truncation creates unacceptable omissions.

## 7. Error/Fallback Plan

| Case | Required behavior |
| ---- | ----------------- |
| Gemini HTTP 400 with schema | Keep current retry once without schema. Log `schema_mode` and safe error metadata only. |
| Schema too complex | Simplify schema; do not broaden into nested evidence objects for MVP. |
| Invalid JSON | Raise `AnalysisParseError` in direct Gemini path; batch may return default structured analysis as it does today. Add tests for no crash and no raw response logging. |
| Missing `summary` | Keep current parse/fallback behavior; do not log raw response. |
| Missing `actionItems` | Normalize to empty arrays; do not fabricate tasks. |
| String-only action items | Normalize to rich items with null owner/deadline/priority/status/evidence. |
| Long transcript | Truncate within guard and log counts/hash only. Do not send unlimited input. |
| Empty/no-task transcript | Return stable empty arrays and short summary/default reason. |
| Owner/deadline not explicit | Leave owner/deadline null; existing test `test_gemini_analyzer_does_not_invent_owner_or_due_date` must remain. |
| `MAX_TOKENS` finish reason | Keep current metadata logging and one retry behavior; ensure no `GEMINI_ANALYSIS_RESPONSE_PARSED` success log on incomplete response. |

## 8. Implementation Slices

### F8-1 - Prompt/schema constants + parser tests

- Set `AIAnalyzer.PROMPT_VERSION` and `AIAnalyzer.SCHEMA_VERSION` to `gemini-business-v2`.
- Move or document the output schema as named constants near `AIAnalyzer`.
- Add `evidenceKeywords` to the new F8 prompt/schema as Search-A hints.
- Accept legacy `evidenceQuote`/`evidence` in normalization only as unverified optional fields.
- Make `action_items` the canonical backend rich field and mirror it into `businessActionItems`.
- Keep `evidence` as compatibility alias.
- Add parser/normalizer tests for rich action items, legacy strings, null owner/deadline, invalid priority/status, duplicate tasks, and evidence fields.

### F8-2 - Gemini payload structured output if supported

- Keep current `responseMimeType=application/json` and `responseSchema`.
- Validate schema field names and nullable handling against Gemini docs. If current REST schema rejects type arrays/nulls, keep string fields optional and normalize empty strings to null application-side.
- Keep existing HTTP 400 retry without schema.

### F8-3 - Token guard + long transcript behavior

- Add explicit tests around `analysis_max_input_tokens` and truncation metadata/logs.
- Do not implement `countTokens` in MVP.
- Validate no prompt/transcript/raw response is logged during truncation or parse failure.

### F8-4 - Response compatibility + docs/tests

- Update Python and FE action item types only as additive fields.
- Confirm processing-service `Map<String,Object>` wrappers pass through new fields.
- Keep existing `businessActionItems` alias and `actionItems` string list for current UI/report code.
- Document the contract for Search-A and Export-A.

## 9. Test Plan

Unit tests:

- Valid Gemini structured JSON with canonical `action_items` evidence fields.
- `action_items` mirrors to `businessActionItems` and derives legacy `actionItems`.
- Legacy `actionItems` strings normalize into rich `action_items` and `businessActionItems`.
- `action_items` with `deadline` maps to both `deadline` and `dueDate`.
- New analysis uses `gemini-business-v2` prompt/schema versions.
- Older saved analysis payloads remain readable.
- Invalid status/priority normalizes safely.
- Legacy statuses normalize safely: `pending` to `open`, `completed` to `done`, `cancelled` to `blocked`, invalid to `open`.
- Owner/deadline are not invented when absent.
- New F8 schema/prompt prefers `evidenceKeywords` and does not require Gemini-generated `evidenceQuote`.
- Legacy `evidenceQuote` is accepted as unverified text and is not logged.
- Full action item payloads are not logged, including `task`, `owner`, `deadline`, `evidence`, and `evidenceQuote` values.
- Safe logging tests should assert counts/metadata are logged, not transcript-derived field values.
- Missing action items returns empty arrays, not a crash.
- Invalid JSON and missing summary do not log raw response.
- Long transcript truncates and logs only counts/hash.
- Schema HTTP 400 retries once without schema.
- `MAX_TOKENS` retry behavior remains covered.

Integration tests:

- Realtime analysis endpoint persists new action item fields and remains idempotent by transcript hash/prompt/schema.
- Saved analysis endpoint returns new fields through processing-service wrapper.
- FE `normalizeAnalysisResponse` preserves new evidence fields while keeping legacy `actionItems`.

Manual checks:

- Run a short Vietnamese meeting transcript with explicit owner/deadline.
- Run a transcript with action items but no owner/deadline.
- Run a long transcript near budget and inspect only safe metadata logs.

## 10. Acceptance Criteria

- Gemini analysis returns stable JSON-compatible saved fields for summary, keywords, technicalTerms, painPoints, canonical `action_items`, compatibility `businessActionItems`, legacy `actionItems`, and domainMode.
- Rich action items expose `task`, nullable `owner`, nullable `deadline`, `priority`, `status`, and `evidenceKeywords`.
- New F8 output emits only `open`, `in_progress`, `blocked`, and `done` statuses; legacy statuses normalize safely.
- `evidenceQuote` is not trusted and is accepted only as a legacy/unverified optional field.
- Existing FE/report consumers still work with legacy `actionItems` and `dueDate`.
- New F8 analysis uses `PROMPT_VERSION=gemini-business-v2` and `SCHEMA_VERSION=gemini-business-v2`.
- Invalid/missing action item data does not crash parsing or persistence.
- Long transcripts are guarded before Gemini calls.
- F8 MVP does not implement Gemini `countTokens`.
- Logs contain no prompt, full transcript, raw Gemini response, API keys, Authorization headers, env secrets, full action item payloads, `evidence`, or `evidenceQuote` values.
- F7 key manager/retry/backoff behavior remains untouched.
- F6 realtime recorder/VAD/WebSocket behavior remains untouched.

## 11. Non-goals

- No rewrite of F7 `GeminiKeyManager`, `GeminiClient`, cooldown, or retry/backoff behavior.
- No Gemini `countTokens` implementation in MVP.
- No Whisper/Ollama re-enable.
- No vector search or embeddings.
- No full map-reduce unless a later phase approves it.
- No real API keys.
- No billing/admin/upload validation changes.
- No production implementation in this spec task.

## 12. Future Work, Not Blocking MVP

- Evaluate exact Gemini `countTokens` only if the current token guard causes long transcript quality issues or provider-limit failures.
- Evaluate map-reduce only if deterministic truncation proves insufficient for long meetings.
