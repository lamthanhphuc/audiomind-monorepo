# Gemini Structured Analysis

## Goal
Phase 6B enriches transcript analysis with structured JSON for both upload-completed transcripts and realtime-stopped transcripts.

The target is to keep the existing transcript pipeline stable while expanding Gemini output from legacy summary-first analysis into a richer, machine-readable analysis payload.

## Current Flow

### Upload completed flow
1. `FE-Audiomind/src/App.tsx` uploads the file with `uploadToMeetingApi(...)` and starts batch processing with `startProcessingByPath(...)`.
2. `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java` forwards the request to the AI service.
3. `demoRecordAUDIOMID/ai-service/app/main.py` accepts `/api/process` and queues `app.tasks.process_meeting` through Celery.
4. `demoRecordAUDIOMID/ai-service/app/tasks.py` runs the async worker, calls `pipeline.process_meeting(...)`, then writes transcript and analysis into Redis job state via `set_job_status(...)`.
5. `demoRecordAUDIOMID/ai-service/app/pipeline.py` performs STT, optional diarization, then calls `self.ai_analyzer.analyze_meeting(formatted_transcript)`.
6. `demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py` currently uses a Gemini/Ollama/OpenAI abstraction, with the Gemini path returning legacy structured-lite JSON that is later normalized for storage.
7. `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java` reads the stored analysis from job state and serves it back through `/processing/{meetingId}/analysis`.
8. `FE-Audiomind/src/App.tsx` fetches transcript and analysis after completion and renders the batch result summary.

### Realtime stopped flow
1. `FE-Audiomind/src/App.tsx` stops the realtime recorder in `handleLiveRecordingComplete(...)`.
2. The FE hydrates transcript only through `getTranscript(...)` and `hydrateLiveTranscriptSegments(...)`.
3. The FE does not call `getAnalysis(...)` for realtime completion.
4. `FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts` handles live transcript events only; it does not trigger Gemini analysis.
5. `demoRecordAUDIOMID/ai-service/app/main.py` finalizes the realtime STT session and returns transcript data, but there is no post-stop Gemini analysis hook in the current realtime path.

### FE analysis render path
1. The batch result view in `FE-Audiomind/src/App.tsx` currently shows transcript plus summary.
2. `FE-Audiomind/src/components/FeatureAnalysis.tsx` and `FE-Audiomind/src/components/FeatureMindmap.tsx` already know how to display a limited structured analysis, but they only cover the current legacy fields.
3. The main user-facing batch flow does not yet render pain points, domain mode, or technical-term meaning/category objects.

## Current Gap

- Gemini output is still legacy and summary-first, not the target structured analysis shape.
- The current public analysis response only exposes summary, keywords, technical terms, action items, and timestamp metadata.
- There is no `painPoints` field.
- There is no `domainMode` field.
- Technical terms are currently treated as strings, not as objects with `term`, `meaning`, and `category`.
- The FE batch result screen currently emphasizes transcript and summary; richer analysis panels are not wired to the target contract yet.
- Realtime stop currently saves transcript, but it does not yet run the same Gemini analysis completion path as the upload flow.

## Scope

- Structured analysis JSON schema for Gemini output.
- Phase 6B-1: upload-completed analysis generation, parsing, validation, fallback, FE structured rendering, and backward-compatible API/contract/persistence.
- Phase 6B-2: realtime-stopped analysis only if a safe post-stop hook already exists and can be reused without changing realtime streaming behavior.
- Safe Gemini prompt update.
- Parsing and validation of Gemini JSON.
- Persistence strategy that preserves backward compatibility with summary-only records.
- FE rendering for structured analysis when the API/contract is updated.
- Targeted tests.
- Manual test checklist.

## Out of Scope

- No Gemini per realtime segment.
- No Gemini per audio chunk.
- No Deepgram/STT quality tuning.
- No speaker diarization improvement.
- No upload language routing changes.
- No realtime WebSocket architecture changes.
- No IT term highlighting in transcript text.
- No major UI redesign.
- No SSE.
- No vector database or RAG.
- No STT changes.
- No Deepgram changes.
- No diarization changes.

## Analysis JSON Contract

Target shape:

```json
{
  "summary": "string",
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
  "actionItems": ["string"],
  "domainMode": "general|it|business|education"
}
```

Rules:

- `summary` is required.
- `keywords`, `technicalTerms`, `painPoints`, and `actionItems` may be empty arrays.
- `domainMode` defaults to `it` for this project unless a user selection is added later.
- `severity` must be normalized to `low`, `medium`, or `high`.
- Malformed Gemini JSON must not crash the pipeline.
- Fallback behavior must preserve the current summary-first behavior.

## Gemini API Strategy

Preferred strategy:

- Use Gemini Structured Outputs / response schema when the current SDK or client supports it.
- Define the target response schema explicitly in code and keep it aligned with the analysis contract above.
- Prefer Pydantic-style validation in Python if the implementation layer exposes it cleanly.

Fallback strategy:

- If the current Gemini SDK or client cannot set a response schema, use prompt-only JSON plus a strict parser/validator.
- Do not rely only on prompt text that says “return JSON”.
- Validate prompt-only responses against the same schema as structured-output responses.
- Malformed output must not crash processing.
- Any fallback must preserve legacy summary behavior.

## Gemini Prompt Requirements

The prompt should:

- Instruct Gemini to return valid JSON only.
- Include the transcript text.
- Include `domainMode` in the prompt context.
- Ask for concise but useful output.
- Ask for IT terms when `domainMode=it`.
- Avoid hallucinating evidence that is not present in the transcript.
- Output empty arrays when there is not enough evidence.
- Avoid markdown fences in the response.

## Backend / AI Service Plan

Expected change points:

- Update the Gemini prompt and JSON expectations in `demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py`.
- Keep `GeminiAnalyzer` as a thin wrapper; the real behavior change belongs in `AIAnalyzer`.
- Extend response parsing and normalization where Gemini output is currently coerced for storage.
- Add validation for `summary`, `keywords`, `technicalTerms`, `painPoints`, `actionItems`, and `domainMode`.
- Preserve a safe fallback path if Gemini returns invalid JSON or the API is unavailable.
- Keep analysis asynchronous so transcript generation and stop/realtime cleanup are not blocked.
- Continue to cap long transcripts and use chunking or truncation rules for very large inputs.

Model and env config requirements:

- `GEMINI_ANALYSIS_MODEL`
- `GEMINI_ANALYSIS_DOMAIN_MODE=it`
- `GEMINI_ANALYSIS_TIMEOUT_SECONDS`
- `GEMINI_ANALYSIS_MAX_INPUT_TOKENS`
- `GEMINI_ANALYSIS_MAX_OUTPUT_TOKENS` if the current Gemini client supports it
- `GEMINI_ANALYSIS_RETRY_MAX_ATTEMPTS` if the current retry infrastructure supports it

Config rules:

- The Gemini model must remain configurable.
- The default domain mode is `it` for this project.
- Do not hardcode preview or experimental models unless the repo already does so today.
- Preserve the current Gemini/Ollama/OpenAI provider fallback if the abstraction already supports it.

Required logs:

- `GEMINI_ANALYSIS_REQUEST domainMode=...`
- `GEMINI_ANALYSIS_RESPONSE_PARSED keywords_count=... terms_count=... pain_points_count=... action_items_count=...`
- `GEMINI_ANALYSIS_FALLBACK reason=...`
- `ANALYSIS_SAVED meetingId=...`
- `GEMINI_ANALYSIS_TOKEN_USAGE input_tokens=... output_tokens=... total_tokens=...`
- `GEMINI_ANALYSIS_RATE_LIMIT_RETRY attempt=... reason=...`
- `GEMINI_ANALYSIS_TIMEOUT timeout_seconds=...`

Logging guardrails:

- Do not log API keys.
- Do not log the full transcript body.
- Do not log secrets or token-like payloads.

Token and rate-limit guardrails:

- Count input tokens before calling Gemini if the SDK exposes token counting.
- Log token usage from `usage_metadata` if the response exposes it.
- Add an explicit timeout for Gemini analysis calls.
- Add only small retry/backoff for transient 429, 5xx, or timeout failures if the current infra already supports retries.
- Do not retry invalid JSON endlessly.
- Call Gemini once per upload-completed transcript.
- Call Gemini once per realtime-stopped transcript.
- Never call Gemini per segment or per audio chunk.

## Persistence Plan

Current storage facts:

- The AI service persists analysis in the `analysis` SQL table.
- The current SQL model stores `summary`, `keywords`, `technical_terms`, `action_items`, and glossary metadata.
- The processing service also stores a JSON `result` blob in Redis job state, which is what the FE reads through the processing API.

Decision:

- Prefer a backward-compatible response shape first; do not add a DB migration unless implementation confirms the existing job-state/API response cannot safely carry the structured analysis.
- Keep existing `summary`, `keywords`, `technical_terms`, and `action_items` columns populated if they already exist.
- Existing summary-only records must still load and render.
- Old rows without structured JSON must fall back to the current summary/keyword/action-item behavior.
- FE should prefer `structured_analysis` when present and fall back to legacy fields.
- Add a nullable `structured_analysis` JSON/text column only if persistent historical structured analysis is required.
- Any migration must be additive and non-destructive.
- No backfill required.

Guardrails:

- Preserve existing analysis reads for all historical meetings.
- If a schema migration is needed, it must be additive and non-destructive.

## API / Contract Plan

If the public analysis shape changes, update contracts first and regenerate clients.

Likely affected files:

- `packages/contracts/ai-api.yaml`
- `packages/contracts/processing-api.yaml`
- `packages/api-clients/ai.ts`
- `packages/api-clients/processing.ts`

Plan:

1. Update the source OpenAPI YAML.
2. Regenerate the TypeScript clients.
3. Inspect the generated diff.
4. Run the repository-supported schema/client validation.
5. Avoid generated drift without a matching contract update.

Transition rules:

- New fields should be optional for backward compatibility while the rollout is in progress.
- `painPoints` may default to an empty array.
- `domainMode` may default to `"it"`.
- `technicalTerms` may accept legacy `string[]` and new object-based entries during transition if needed.

## FE Plan

Expected FE changes:

- Render summary.
- Render keyword chips.
- Render technical-term cards with meaning and category.
- Render pain points with severity badges.
- Render action items.
- Render a domain-mode badge or text if the API includes it.
- Preserve summary-only fallback for older records.
- Show empty states when arrays are missing or empty.
- Do not change the transcript readability component in this phase unless required by the new data shape.

Likely FE files:

- `FE-Audiomind/src/App.tsx`
- `FE-Audiomind/src/services/api.ts`
- `FE-Audiomind/src/types.ts`
- `FE-Audiomind/src/components/FeatureAnalysis.tsx`
- `FE-Audiomind/src/components/FeatureMindmap.tsx`

## Upload Flow Plan

- After upload processing completes, structured Gemini analysis should be generated and saved.
- FE should fetch and render the structured analysis from the existing analysis endpoint path.
- Failure to analyze must not fail transcript generation.

## Realtime Stop Flow Plan

- Phase 6B-1 should stop at upload-completed structured analysis unless the repo already has a safe post-stop hook that can be reused without changing realtime streaming behavior.
- Phase 6B-2 covers realtime-stopped structured analysis only if that safe hook exists.

### Phase 6B-1

- Upload-completed structured analysis.
- FE structured rendering.
- Schema, persistence, and contract updates.

### Phase 6B-2

- Realtime-stopped structured analysis hook, only if the current architecture can add a safe post-stop hook.

Reason:

- The current repo does not yet show a realtime `getAnalysis(...)` call or backend analysis trigger after stop.
- Do not call Gemini per segment or per chunk.
- Failure to analyze must not break saved transcript output.

Safe staged path:

1. Persist the final transcript.
2. Queue or invoke a background analysis job.
3. Save the structured payload separately from transcript persistence.
4. Let FE poll or fetch analysis after transcript completion.

## Fallback / Error Handling

- Gemini unavailable: keep the transcript and completed status if transcript generation succeeded.
- Malformed JSON: fall back to summary text if possible.
- Empty transcript: return empty structured analysis with a clear summary or no-analysis fallback.
- Long transcript: use truncation or chunking strategy, documented and bounded.
- All failures must log safely.
- Analysis errors must not hide transcript results.

Long transcript handling:

- Use the final transcript only, not interim fragments.
- If the transcript exceeds the maximum input token budget, the first implementation may truncate safely and log the truncation.
- Staged chunk-summary-final-analysis is acceptable as a follow-up if it is already easy to implement.
- Do not silently cut text without logging.

## Acceptance Criteria

- Upload completed can produce structured analysis in Phase 6B-1.
- Realtime stopped can produce structured analysis in Phase 6B-2 only if a safe post-stop hook exists; otherwise it remains a documented follow-up.
- FE can render summary, keywords, technical terms, pain points, and action items.
- Existing summary-only analysis remains compatible.
- Gemini invalid JSON does not crash processing.
- Transcript generation remains independent from analysis failure.
- No Gemini per realtime segment or chunk.
- No STT or Deepgram changes.
- Targeted tests pass.
- No secrets or debug files are committed.

## Testing Plan

### AI / backend tests

- Structured output config/schema is passed to Gemini when the SDK supports it.
- Fallback parser works when response schema is unavailable.
- Valid Gemini JSON parses correctly.
- Invalid JSON falls back safely.
- Missing fields default to empty arrays.
- Severity normalizes to `low`, `medium`, or `high`.
- `usage_metadata` / token logging is handled when present.
- 429, timeout, or 5xx fallback does not fail transcript completion.
- Long transcript truncation or chunking logs safely.
- Analysis save supports structured result.
- Upload processing still completes if Gemini fails.
- Realtime stop analysis path, if implemented, is covered.

### FE tests

- Renders structured summary.
- Renders keyword chips.
- Renders technical-term objects.
- Renders legacy technical-term string arrays as fallback.
- Renders pain points.
- Renders pain-point empty state.
- Renders action items.
- Renders domain mode if included.
- Handles summary-only legacy response.
- Handles empty arrays.

### Manual tests

- Upload IT-related Vietnamese audio.
- Upload English audio.
- Stop realtime recording with IT-related content.
- Confirm structured analysis appears.
- Confirm transcript still appears even if analysis fails.

## Likely Files To Inspect

Start from these files and verify the final call graph before implementation:

- `demoRecordAUDIOMID/ai-service/app/pipeline.py`
- `demoRecordAUDIOMID/ai-service/app/tasks.py`
- `demoRecordAUDIOMID/ai-service/app/main.py`
- `demoRecordAUDIOMID/ai-service/app/models.py`
- `demoRecordAUDIOMID/ai-service/app/schemas.py`
- `demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py`
- `demoRecordAUDIOMID/ai-service/app/services/gemini_analyzer.py`
- `demoRecordAUDIOMID/ai-service/tests/test_ai_analyzer.py`
- `demoRecordAUDIOMID/ai-service/tests/test_gemini_analyzer.py`
- `demoRecordAUDIOMID/ai-service/tests/test_analysis_factory.py`
- `demoRecordAUDIOMID/ai-service/tests/test_stt_stream_route.py`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/JobStateStore.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/application/ProcessMeetingJobUseCase.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/dto/AnalysisResponse.java`
- `FE-Audiomind/src/App.tsx`
- `FE-Audiomind/src/services/api.ts`
- `FE-Audiomind/src/types.ts`
- `FE-Audiomind/src/components/FeatureAnalysis.tsx`
- `FE-Audiomind/src/components/FeatureMindmap.tsx`
- `packages/contracts/ai-api.yaml`
- `packages/contracts/processing-api.yaml`
- `packages/api-clients/ai.ts`
- `packages/api-clients/processing.ts`

## Implementation Plan For Later

1. Locate current Gemini summary generation.
2. Define the structured analysis schema and types.
3. Update the Gemini prompt to JSON-only output.
4. Add parser and validator with fallback.
5. Update persistence if needed.
6. Update API and contract files if needed.
7. Update FE analysis rendering.
8. Add upload-completed tests.
9. Add realtime-stopped tests or document a staged follow-up if the hook is missing.
10. Run targeted tests and build checks.
11. Validate upload and realtime manually.
12. Commit in logical slices.

## Risks / Known Limitations

- Gemini may return malformed JSON.
- Gemini may hallucinate unsupported technical terms.
- Long transcripts may exceed prompt limits.
- Analysis may be slower than transcript generation.
- Realtime stop analysis must not block stream cleanup.
- Existing summary-only records need fallback rendering.
- Domain-mode selection UI is not required in this phase; default can remain `it`.
- Scope remains intentionally narrow: no Gemini per realtime segment or chunk, no STT or Deepgram changes, no diarization changes, no transcript IT highlighting, no major UI redesign, no SSE, and no RAG/vector DB.
