# Upload/Batch Language Mode

## Goal
Phase 5E completes language routing for uploaded audio so batch transcription can use the selected language end-to-end.

## Current Flow
The active upload flow is split across the FE upload action and the backend job pipeline:

1. `FE-Audiomind/src/App.tsx` handles the current upload action with `uploadToMeetingApi(selectedFile.name, selectedFile)`.
2. `FE-Audiomind/src/services/api.ts` sends multipart form-data to `MEETING_API_BASE/meetings/upload` with `title` and `file`.
3. `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/MeetingController.java` receives the upload, persists the file, and creates a meeting record.
4. `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java` starts processing for the meeting.
5. `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java` forwards the job payload to ai-service.
6. `demoRecordAUDIOMID/ai-service/app/main.py` queues the batch job via `/api/process` and the batch pipeline uses `DeepgramSTTAdapter.batch_transcribe_file(...)`.
7. `demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py` sends the prerecorded Deepgram request with `language=<selected language>` when the batch language reaches it.

There is also a standalone FE upload component in `FE-Audiomind/src/components/FeatureUpload.tsx`, but its local language dropdown is not connected to the live upload request path.

## Current Gap
The current upload/batch path does not reliably carry the user-selected language from the UI to batch STT.

- The FE upload screen has a local language dropdown, but the active upload request does not consume it.
- The meeting upload payload currently sends `title` and `file` only.
- The meeting record does not store language today.
- The by-path processing flow currently hardcodes the upload language to `vi`.
- The batch STT pipeline can accept a language value, but the upload route does not consistently provide one.
- Persisted upload transcript output does not currently record the selected upload language as part of the meeting record shape.

Preferred implementation direction for this phase:

- FE sends the selected upload language with the meeting upload request.
- meeting-service accepts and normalizes the language.
- meeting-service persists language on the Meeting record if needed.
- processing-service reads or receives the selected meeting language and forwards it to ai-service.
- ai-service batch STT uses the selected language in the Deepgram prerecorded/batch request.

This direction is preferred over introducing a parallel upload flow.

## Scope
- Upload/batch audio only.
- Add or reuse a language selector for upload if the current upload screen lacks one.
- Update the upload request contract so language can travel with the uploaded meeting/job.
- Forward and normalize language in the backend upload/processing path.
- Update ai-service batch Deepgram calls to use the selected language.
- Add targeted tests only.
- Add a manual browser/upload verification checklist.

## Out Of Scope
- Realtime WebSocket behavior.
- Speaker mode changes.
- Phase 5G endpointing tuning.
- Gemini summary, keywords, or pain-point behavior.
- IT term highlighting.
- SSE.
- Broad upload architecture refactors.
- Deepgram multi-language quality improvements.

## Language Contract
Allowed upload language values:

- `vi`
- `en`
- `multi`

Rules:

- Missing, null, or invalid language must fall back safely.
- Preferred fallback is `vi`.
- This preserves the current upload behavior because the existing by-path processing flow already defaults to `vi`.
- Upload must not crash on invalid language.
- `multi` is experimental.
- Language values should match the realtime contract where possible.

## FE Plan
- Add or reuse the upload language selector.
- Keep the upload UI small; avoid a redesign.
- Default the upload language consistently with realtime if that is already the product default.
- Send the selected language with the upload flow.
- Treat the `multi` label as experimental or clearly secondary.

## Backend Plan
- Accept language from the upload request path that currently creates the meeting/job.
- Validate and normalize language before forwarding it downstream.
- Persist language if the current model/schema already supports it, or add the smallest required field if the upload flow depends on it.
- If a Meeting language field is added, keep it backward compatible.
- Existing meeting records must continue to work.
- Prefer a nullable field or a safe default.
- Avoid destructive database/schema migrations.
- Do not require backfilling historical meetings for this phase.
- Forward language to ai-service batch STT.
- Preserve backward compatibility for old upload clients that do not send language.

## AI Service Plan
- Accept language in the batch STT request path.
- Normalize language before calling Deepgram.
- Add the Deepgram prerecorded/batch `language` query parameter.
- Keep realtime endpointing logic separate from upload/batch logic.
- `DEEPGRAM_REALTIME_ENDPOINTING_*` must not affect upload/batch STT.
- Phase 5G realtime endpointing behavior must remain unchanged.
- Batch STT should only add or adjust the Deepgram language parameter.
- Do not add realtime endpointing parameters to batch requests.
- Keep batch model behavior unchanged except for the language parameter.

## API / Contract Plan
OpenAPI/client generation appears involved.

Current contract state:

- `packages/contracts/meeting-api.yaml` does not expose upload language today.
- `packages/contracts/processing-api.yaml` already carries `language` in `ProcessStartRequest`.
- `packages/contracts/ai-api.yaml` exposes `/api/process` and `/api/upload-audio`; the active batch path still needs to be checked against the chosen upload flow.
- `packages/api-clients/meeting.ts` and `packages/api-clients/processing.ts` are generated outputs that may need regeneration if request bodies change.

If the implementation keeps the meeting upload path, expect contract drift work in the meeting API and generated client. If the implementation switches to the existing processing start contract, the meeting upload contract may stay stable, but the FE wiring and processing-path tests still need updates.

If OpenAPI/contracts change, implementation should:

- update the source OpenAPI contract files first
- regenerate affected clients
- inspect generated diffs
- run the repo's schema/client validation commands, such as `npm run validate:schema`, `npm run generate:client`, `npm run check:openapi`, and `npx tsc --noEmit -p tsconfig.generated.json`
- avoid committing generated drift accidentally without matching source contract changes

If any of those commands do not exist in this repo variant, use the repo's actual package scripts or equivalent validation commands.

Likely files affected by contract work:

- `packages/contracts/meeting-api.yaml`
- `packages/contracts/processing-api.yaml`
- `packages/contracts/ai-api.yaml` if `/api/upload-audio` is extended
- `packages/api-clients/meeting.ts`
- `packages/api-clients/processing.ts`
- `packages/api-clients/ai.ts` if the ai contract changes

Contract checks to keep:

- generated client drift check
- schema/openapi validation

## Logging
Add targeted upload/batch logs:

- `FE_UPLOAD_LANGUAGE_SELECTED` with `language=vi/en/multi`
- `UPLOAD_REQUEST_SEND` with language
- `UPLOAD_LANGUAGE_EFFECTIVE`
- `BATCH_STT_EFFECTIVE_CONFIG` with model and language

Do not log API keys or raw long transcripts.

## Acceptance Criteria
- Upload UI can select `vi`, `en`, or `multi`.
- FE sends the selected language with the upload request.
- Backend receives and normalizes the selected language.
- Backend forwards the selected language to ai-service.
- ai-service batch STT sends the correct Deepgram language.
- Missing or invalid language falls back safely.
- Existing upload behavior without language still works.
- Realtime language, speaker mode, and endpointing behavior remain unchanged.
- Gemini analysis behavior remains unchanged.
- Targeted tests pass.
- No secrets or debug files are committed.

Targeted tests to add or update:

- FE: upload request includes language.
- meeting-service: upload accepts language.
- meeting-service: missing or invalid language falls back to `vi`.
- meeting-service: language is stored or included in response/job context.
- processing-service: processing job forwards language to ai-service.
- ai-service: batch STT receives `vi`, `en`, and `multi`.
- ai-service: invalid language fallback is `vi`.
- ai-service: Deepgram batch URL/request includes language.
- ai-service: batch request does not include realtime endpointing.
- regression: realtime `vi` + `single` still works.
- regression: Gemini behavior remains unchanged.

## Manual Test Checklist
For each case, record:

- selected UI language
- request payload/form-data language
- backend effective language log
- ai-service batch effective config log
- transcript output notes

Expected logs to verify during manual testing:

- `FE_UPLOAD_LANGUAGE_SELECTED language=vi/en/multi`
- `UPLOAD_REQUEST_SEND language=...`
- `UPLOAD_LANGUAGE_EFFECTIVE language=...`
- `BATCH_STT_EFFECTIVE_CONFIG model=... language=...`

Test cases:

1. Upload Vietnamese audio with `vi`.
   - Expected: batch STT config language is `vi`.
2. Upload English audio with `en`.
   - Expected: batch STT config language is `en`.
3. Upload mixed Vietnamese/English audio with `multi`.
   - Expected: batch STT config language is `multi`; quality may vary.
4. Upload without language if backward compatibility allows it.
   - Expected: safe fallback and no crash.
5. Upload with an invalid language if the UI or API can be forced to do so.
   - Expected: fallback and no crash.
6. Run a realtime smoke test with `vi` + `single`.
   - Expected: no regression in realtime language/speaker behavior.

Do not use this phase to validate Gemini enrichment, keywords, pain points, IT term highlighting, SSE, realtime WebSocket changes, or Deepgram multi-language quality improvements.

## Implementation Plan For Later
1. Analyze current upload endpoints and request DTOs.
2. Add or normalize the language type/constants shared with realtime if appropriate.
3. Add FE upload language selector or reuse the existing language selector.
4. Send language in the upload request.
5. Update backend upload DTO/controller/service/client.
6. Update ai-service batch request schema and Deepgram batch call.
7. Add logging.
8. Add or update targeted tests.
9. Run contract/client generation if required.
10. Run the manual upload tests.
11. Commit in logical commits.

Do not add a parallel upload flow; extend the current upload path end-to-end.

## Likely Files To Inspect
Start here, but verify during implementation:

- `FE-Audiomind/src/App.tsx`
- `FE-Audiomind/src/components/FeatureUpload.tsx`
- `FE-Audiomind/src/components/QuickActions.tsx`
- `FE-Audiomind/src/services/api.ts`
- `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/MeetingController.java`
- `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/entity/Meeting.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/dto/ProcessStartRequest.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java`
- `demoRecordAUDIOMID/ai-service/app/main.py`
- `demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py`
- `demoRecordAUDIOMID/ai-service/tests/test_batch_stt_provider.py`
- `demoRecordAUDIOMID/ai-service/tests/test_deepgram_stt_adapter.py`
- `demoRecordAUDIOMID/processing-service/src/test/java/com/example/processingservice/service/ProcessingServiceTest.java`
- `packages/contracts/meeting-api.yaml`
- `packages/contracts/processing-api.yaml`
- `packages/contracts/ai-api.yaml`
- `packages/api-clients/meeting.ts`
- `packages/api-clients/processing.ts`
- `packages/api-clients/ai.ts`

## Risks / Known Limitations
- `multi` quality may still be poor.
- Upload/batch Deepgram behavior may differ from realtime behavior.
- Contract/client drift can break CI if the request shape changes but generated files are not refreshed.
- Database or schema changes should be avoided unless they are required for the minimal language handoff.
