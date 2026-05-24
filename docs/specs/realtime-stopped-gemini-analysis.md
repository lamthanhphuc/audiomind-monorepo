# Realtime Stopped Gemini Analysis

## Goal
After realtime recording stops and the final transcript is saved and hydrated, run Gemini structured analysis exactly once and render the same structured analysis panel used by upload.

## Current Flow
- Realtime FE opens a websocket through `useRealtimeMeetingStream`, sends `auth.init`, and receives `session.ready` before streaming audio. See [FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts](FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts#L28) and [FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts](FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts#L430).
- Live audio chunks are sent from the recorder to the websocket, and the server streams transcript partial/final events back to the FE.
- The realtime websocket close path is already lifecycle-aware: `stream.stop` is handled in `MeetingWebSocketHandler`, which finalizes STT before closing the socket, and `afterConnectionClosed` also finalizes if the session received audio and has not already been finalized. See [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java](demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java#L209) and [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java](demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java#L434).
- Final realtime transcript persistence happens through a synthetic final chunk in `finalizeSttSession`, which caches the final transcript for fallback delivery and broadcasts the final transcript event when possible. See [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java](demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java#L502).
- FE hydration happens after stop in `handleLiveRecordingComplete`: it waits for transcript stability, merges persisted fragments with live segments, then disconnects and marks the UI as stopped. See [FE-Audiomind/src/App.tsx](FE-Audiomind/src/App.tsx#L974).
- The FE currently renders transcript plus analysis together only for upload. The upload path calls `getTranscript(meetingId)` and `getAnalysis(meetingId)` after batch processing completes. See [FE-Audiomind/src/App.tsx](FE-Audiomind/src/App.tsx#L758).
- The shared structured analysis panel already exists in the FE and renders `summary`, `keywords`, `technicalTerms`, `painPoints`, `actionItems`, and `domainMode`. See [FE-Audiomind/src/App.tsx](FE-Audiomind/src/App.tsx#L1235) and [FE-Audiomind/src/components/FeatureAnalysis.tsx](FE-Audiomind/src/components/FeatureAnalysis.tsx#L23).
- The current processing analysis endpoint exists at `/processing/{meetingId}/analysis`, but it reads analysis from the Redis job-state result, which is populated by batch upload processing. See [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java](demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java#L118) and [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java](demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java#L280).
- The batch worker already performs Gemini analysis in ai-service, then stores transcript + analysis in the DB and job state. See [demoRecordAUDIOMID/ai-service/app/tasks.py](demoRecordAUDIOMID/ai-service/app/tasks.py#L123) and [demoRecordAUDIOMID/ai-service/app/pipeline.py](demoRecordAUDIOMID/ai-service/app/pipeline.py#L626).

## Current Gap
- Upload already produces structured Gemini analysis, but realtime stopped sessions do not currently trigger structured analysis after transcript persistence.
- The FE does not currently fetch analysis after realtime stop, so it can show transcript without `summary`, `keywords`, `technicalTerms`, `painPoints`, `actionItems`, or `domainMode`.
- Realtime analysis should happen once after the transcript is stable, not per segment and not per audio chunk.
- The public FE path for `getAnalysis` currently depends on batch job-state storage, so realtime meetings do not have a guaranteed analysis payload today.

## Realtime Analysis Input
- The analysis input must be the final persisted or hydrated realtime transcript text, or the final transcript fragments assembled into text.
- Do not call batch STT again for realtime analysis.
- Do not call `/api/process` or any audio-by-path processing flow for realtime analysis.
- Do not require an uploaded audio file or audio path for this phase.
- Gemini should receive formatted final transcript text only.

## MVP Implementation Decision
- processing-service owns the post-stop trigger because it owns realtime websocket finalization and transcript persistence.
- processing-service should collect the final transcript text or fragments after finalization.
- processing-service should call an ai-service direct transcript-analysis endpoint or equivalent internal service method.
- ai-service should reuse the Phase 6B Gemini structured analyzer.
- ai-service should persist analysis by `meeting_id` using the existing analysis storage.
- processing-service `/processing/{meetingId}/analysis` should return realtime analysis by bridging to ai-service if the batch job-state is empty.
- FE should poll the existing `getAnalysis(meetingId)` after realtime stop and hydration.
- Do not use upload batch STT, `/api/process`, audio path processing, or a Celery audio-processing job for realtime analysis.
- New endpoints, if needed, should be internal, additive, and backward-compatible.
- No DB migration unless implementation proves the existing analysis storage cannot support realtime analysis.
- Prefer bridging the existing `getAnalysis` flow over adding a new public FE contract.

## Options Considered
1. FE calls Gemini or the analysis service directly after stop.
- Pros: simple FE wiring.
- Cons: exposes lifecycle concerns to the client, risks duplicate calls on reconnect or refresh, and makes stop completion depend on analysis plumbing.
- Decision: not preferred.

2. WebSocket cleanup waits for Gemini before closing.
- Pros: automatic at the stop site.
- Cons: can block or slow stop, increases risk in the cleanup path, and couples socket lifetime to model latency.
- Decision: not preferred.

3. Backend post-stop async hook after transcript persistence.
- Pros: reusable, non-blocking, better ownership boundary, and can reuse the existing structured Gemini analyzer and FE rendering.
- Cons: needs careful idempotency and status handling.
- Decision: preferred.

4. Manual Analyze button as fallback.
- Pros: easy debug/retry path.
- Cons: not ideal for the main demo flow.
- Decision: optional fallback only if existing UX already supports it.

## Chosen Approach
- Trigger Gemini analysis once after the realtime transcript has been persisted and is stable enough to read back.
- Use a processing-service post-stop hook that collects final transcript text, then calls an ai-service realtime analyze-transcript style endpoint or equivalent internal service method.
- Let ai-service reuse the Phase 6B Gemini analyzer and persist analysis by `meeting_id`.
- Keep the analysis work asynchronous or otherwise non-blocking so stop recording completes immediately.
- Keep the FE rendering path shared with upload, ideally by continuing to use the existing analysis result shape.
- Avoid a DB migration unless the existing storage path cannot represent realtime analysis safely.
- Add an idempotency guard so stop/reconnect/retry cannot launch multiple analysis jobs for the same meeting.
- Prefer reusing an existing direct-text analysis endpoint if one already exists; otherwise add a small additive internal ai-service endpoint.

## Trigger Point
- Preferred safe trigger: after final realtime transcript persistence has completed and the final transcript is available for hydration or direct readback.
- Do not trigger inside per-segment websocket events.
- Do not trigger before the final transcript is available.
- Do not block socket close or recorder stop while Gemini runs.
- WebSocket finalization may trigger or enqueue analysis, but it must not wait for Gemini.
- Stop recording and socket close must complete even if analysis enqueue fails.
- Any Gemini work must happen async or in the background.
- If no safe single hook exists, stage it:
  - Phase 6D-1: backend trigger + existing analysis fetch path.
  - Phase 6D-2: move trigger to the final stop/finalization hook once the transcript path is proven stable.

## Idempotency / Duplicate Prevention
- Minimum viable idempotency is meetingId + transcriptHash or equivalent transcript version, if available.
- One analysis per meeting and transcript version.
- If analysis already exists and the transcript is unchanged, reuse it.
- If analysis is already in progress, do not start another request.
- If analysis failed, allow one explicit retry path only if safe.
- If no persistent transcriptHash exists, use a conservative in-memory or Redis guard and document that limitation.
- Do not launch duplicate Gemini requests on duplicate stop, reconnect, hydration retry, or page refresh.
- Log duplicate skips so the lifecycle is auditable.

Suggested logs:
- `REALTIME_ANALYSIS_TRIGGERED meetingId=...`
- `REALTIME_ANALYSIS_SKIPPED reason=already_exists|in_progress|empty_transcript|not_final`
- `REALTIME_ANALYSIS_SAVED meetingId=...`
- `REALTIME_ANALYSIS_FAILED meetingId=... reason=...`

## Gemini Analysis Reuse
- Reuse the same structured JSON fields from Phase 6B:
  - `summary`
  - `keywords`
  - `technicalTerms`
  - `painPoints`
  - `actionItems`
  - `domainMode`
- Keep `domainMode` defaulted to `it`.
- Keep Gemini structured output / response schema mode.
- Keep `thinkingBudget=0` for Gemini 2.5 Flash structured extraction.
- Keep `maxOutputTokens=4096` and the existing `MAX_TOKENS` retry path.
- Keep the existing HTTP 400 schema retry path.
- Keep token usage logging from `countTokens` or `usageMetadata` when available.
- Treat `finishReason=MAX_TOKENS` as incomplete, not success.
- Malformed Gemini output must fall back safely.
- Never log full transcript content or secrets.

## Data / Persistence Plan
- Current analysis persistence already uses `meeting_id` as the unique key in ai-service, so a new table is likely unnecessary.
- Current realtime STT finalization already persists transcript fragments and caches the final transcript; that is enough to derive analysis without a DB schema redesign.
- Preferred plan is to reuse the existing upload analysis storage shape for realtime as well, but not by reusing the upload batch job-state path as the only storage location.
- No DB migration is likely needed if realtime analysis can be stored in the existing analysis row or a compatible realtime result record.
- If an explicit realtime-analysis status must be persisted, any migration should be additive and backward compatible.
- Existing upload analysis must remain compatible.

## API / Contract Plan
- The current `/processing/{meetingId}/analysis` endpoint is batch job-state oriented today.
- Phase 6D should decide whether to:
  - populate the existing job-state/result shape for realtime,
  - bridge the existing endpoint to ai-service analysis by `meeting_id`, or
  - add a compatible new endpoint.
- Preferred order is existing shape or bridge before a new endpoint.
- If a new endpoint is needed, keep it additive and backward compatible.
- Do not introduce new required fields in existing responses.
- If contracts change, update source OpenAPI first and regenerate clients, then validate with:
  - `npm run validate:schema`
  - `npm run check:openapi`
  - `npx tsc --noEmit -p tsconfig.generated.json`

## FE Plan
- After realtime stop and transcript hydration complete, the FE should show analysis loading state rather than silently staying empty.
- The FE should fetch or poll the existing analysis result path after stop, with a timeout or max attempts.
- Polling should stop once analysis is completed or failed.
- Refresh should fetch any already-saved analysis if available.
- The FE should render the same `FeatureAnalysis` / analysis panel used by upload.
- If analysis fails, transcript must remain visible and the UI should show a non-blocking error or empty state.
- Do not redesign the panel.
- Do not introduce per-segment or per-chunk Gemini calls.
- Upload analysis UI must not regress.

## Error Handling / Fallback
- Empty transcript: skip analysis and log it clearly.
- Gemini timeout or API error: do not fail transcript completion.
- Gemini malformed JSON: return a safe structured fallback.
- `MAX_TOKENS`: retry as in Phase 6B.
- Refresh or reconnect: FE should be able to read the already-saved result.
- Stop recording must complete even if analysis fails.

## Tech Debt Included In Scope
- Consolidate reuse of the upload Gemini analyzer path for realtime.
- Standardize analysis status and logging for realtime versus upload.
- Add idempotency protection for analysis launch.
- Add loading/error state for analysis after realtime stop.
- Add tests proving no per-segment or per-chunk Gemini call.
- Avoid misleading logs such as parse-fallback success when the output was actually incomplete.

## Tech Debt Out Of Scope
- Deepgram or STT quality changes.
- Diarization changes.
- Upload language routing changes.
- Upload transcript grouping changes.
- IT term highlighting.
- Analysis panel redesign.
- Deepgram paragraphs or utterances.
- Realtime segment grouping changes.
- Global log cleanup.

## Testing Plan
Backend / AI:
- Final transcript triggers async analysis enqueue once.
- Duplicate finalization does not enqueue twice.
- Empty transcript skips analysis.
- Enqueue failure does not fail transcript finalization.
- Analysis endpoint returns realtime analysis if available.

AI service:
- Analyze final transcript text reuses the Gemini structured analyzer.
- Does not run STT.
- Persists by `meeting_id`.
- Duplicate meeting/transcript hash is idempotent if implemented there.

- Gemini failure does not fail transcript persistence.
- Gemini fallback result is safe.
- No Gemini call per realtime segment or chunk.
- Upload analysis still works.

Processing / meeting service if applicable:
- Post-stop final transcript state triggers analysis job.
- Status or result endpoint returns realtime analysis.
- Idempotency behavior works across stop, reconnect, refresh, and retry.

FE:
- After stop, analysis loading appears and polling starts.
- Completed analysis renders summary, keywords, terms, pain points, action items, and domainMode.
- Failed or pending analysis does not hide transcript.
- Upload analysis UI still works.
- Realtime transcript rendering remains unchanged.
- No analysis call occurs during live segment updates.

Contract:
- Schema validation passes.
- OpenAPI check remains non-breaking if any contract is touched.

## Manual Test Plan
1. Realtime Vietnamese, single speaker.
- Record IT-related content.
- Stop.
- Transcript persists.
- Analysis appears after stop.

2. Realtime English, single speaker.
- Same expected behavior.

3. Realtime multiple speakers smoke.
- No crash.
- No duplicate analysis.

4. Upload smoke.
- Upload analysis still works.

Expected logs:
- `REALTIME_ANALYSIS_TRIGGERED`
- `GEMINI_ANALYSIS_REQUEST`
- `GEMINI_ANALYSIS_RESPONSE_PARSED`
- `REALTIME_ANALYSIS_SAVED`
- No per-segment Gemini request logs

## Acceptance Criteria
- Realtime stopped transcript gets structured Gemini analysis.
- Gemini is called once per stopped realtime transcript, not per segment or chunk.
- Stop recording is not blocked by Gemini analysis.
- Transcript persists even if analysis fails.
- FE renders analysis after stop.
- Upload analysis still works.
- No STT, Deepgram, diarization, or upload-grouping regression.
- Tests and validation pass.

## Risks / Known Limitations
- Race between transcript hydration and analysis trigger.
- Duplicate stop or reconnect events.
- Long realtime transcripts may still need truncation or chunking later.
- Gemini latency may require a loading or polling state.
- Fallback analysis may be sparse when the model output is incomplete.
- IT highlighting is intentionally deferred.

## Likely Implementation Files
- [FE-Audiomind/src/App.tsx](FE-Audiomind/src/App.tsx)
- [FE-Audiomind/src/services/api.ts](FE-Audiomind/src/services/api.ts)
- [FE-Audiomind/src/types.ts](FE-Audiomind/src/types.ts)
- [FE-Audiomind/src/components/FeatureAnalysis.tsx](FE-Audiomind/src/components/FeatureAnalysis.tsx)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java](demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java](demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java](demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java)
- [demoRecordAUDIOMID/ai-service/app/pipeline.py](demoRecordAUDIOMID/ai-service/app/pipeline.py)
- [demoRecordAUDIOMID/ai-service/app/main.py](demoRecordAUDIOMID/ai-service/app/main.py)
- [demoRecordAUDIOMID/ai-service/app/tasks.py](demoRecordAUDIOMID/ai-service/app/tasks.py)

## Notes From Current Code
- `meeting_id` is already unique in the ai-service `analysis` table, which favors reuse over schema expansion. See [demoRecordAUDIOMID/ai-service/app/models.py](demoRecordAUDIOMID/ai-service/app/models.py#L35).
- Gemini structured analysis settings already exist in config and factory code, including `gemini-2.5-flash`, `thinking_budget=0`, and `max_output_tokens=4096`. See [demoRecordAUDIOMID/ai-service/app/config.py](demoRecordAUDIOMID/ai-service/app/config.py#L32) and [demoRecordAUDIOMID/ai-service/app/services/analysis_factory.py](demoRecordAUDIOMID/ai-service/app/services/analysis_factory.py#L3).
- The Gemini analyzer already handles `MAX_TOKENS`, schema retry, and token usage logging, so Phase 6D should reuse that path instead of introducing a new prompt or parser. See [demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py](demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py#L895).
