# Realtime Speaker Mode / Speaker Smoothing

## Goal
Add a realtime speaker mode toggle that maps to Deepgram diarization and smooth duplicate final transcript segments without changing the WebSocket architecture, SSE behavior, or batch upload paths.

## Current Flow
- FE sends `auth.init` from `FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts`.
- `processing-service` stores realtime websocket session state in `MeetingWebSocketHandler` session attributes, including language.
- `processing-service` forwards every `audio.chunk` binary payload to `AIServiceClient.streamAudioChunk(...)`.
- `ai-service` receives `/api/v1/stt/stream`, logs `STT_STREAM_EFFECTIVE_CONFIG`, and passes streaming audio to `DeepgramSTTAdapter`.
- Realtime transcript segments are normalized and merged in `FE-Audiomind/src/utils/transcript.ts`, then displayed by `RealtimeTranscript` and `App.tsx`.
- Duplicate handling already exists for exact IDs, timing matches, and hydration/live reconciliation, but it does not explicitly smooth near-duplicate final speaker updates.

## Desired Behavior
- Speaker mode selection:
  - `Single speaker` => `diarize=false`
  - `Multiple speakers` => `diarize=true`
- Default speaker mode is `single`.
- Speaker mode must be propagated end-to-end through realtime auth/session config, then into ai-service Deepgram realtime URL construction.
- Realtime auth contract:
  - `auth.init` payload includes `language` and `speakerMode`
  - `language` values: `vi`, `en`, `multi`
  - `speakerMode` values: `single`, `multiple`
- Backend normalization:
  - missing, null, or invalid `speakerMode` => `single`
  - `single` => `diarize=false`
  - `multiple` => `diarize=true`
- Smoothing rule:
  - Apply only to transcript segments or events explicitly marked final by the realtime pipeline.
  - Do not apply smoothing to interim or partial transcript text.
  - Near-same start time means `<= 0.75s`.
  - Matching text means normalized text is equal or one normalized text contains the other.
  - Update the existing segment speaker instead of inserting a duplicate segment.
  - Preserve the existing final transcript content and timing; prefer the final segment as the source of truth when it improves the existing entry.
  - Preserve stable ordering.
  - Do not merge unrelated segments from different time windows.

## Smoothing Candidate Selection
- If multiple existing final segments match the near-duplicate rule, update the closest segment by startTime.
- If still tied, prefer the most recently inserted matching final segment.

## Text Replacement Safety
- Only replace existing transcript text when the new final text is non-empty and longer or more complete.
- Do not replace meaningful existing text with empty, shorter, or obviously lower-quality text.
- Speaker update may still be applied when timing and text match strongly.

## Implementation Plan
1. Analyze the current realtime speaker and diarization flow end to end.
2. Update FE speaker mode state and selector.
3. Send `speakerMode` in `auth.init`.
4. Store `speakerMode` in the processing-service WebSocket session.
5. Forward `speakerMode` to the ai-service stream STT route.
6. Normalize `speakerMode` in ai-service.
7. Convert `speakerMode` to Deepgram `diarize`.
8. Add final segment smoothing in `FE-Audiomind/src/utils/transcript.ts`.
9. Add or update targeted tests.
10. Run targeted validation.

## Logging Requirements
Add or update targeted logs only:
- `FE_REALTIME_SPEAKER_MODE_SELECTED`
- `REALTIME_AUTH_INIT_SEND` with `speakerMode`
- `REALTIME_SPEAKER_MODE_SELECTED`
- `AUDIO_CHUNK_SPEAKER_MODE_EFFECTIVE`
- `STT_STREAM_EFFECTIVE_CONFIG` with `diarize`

## Logging Clarification
- `AUDIO_CHUNK_SPEAKER_MODE_EFFECTIVE` must not be logged for every audio chunk.
- Log it only once per realtime session or when the effective speaker mode changes.
- Avoid noisy per-chunk logs.

## Implementation Notes
- Keep the current realtime WebSocket handshake and session lifecycle intact.
- Avoid any refactor that changes the existing auth/session flow shape.
- Reuse existing transcript merge helpers where possible; add a small smoothing branch for final duplicate reconciliation rather than rewriting the merger.
- Keep language routing unchanged except for compatibility with the new speaker mode plumbing.

## Smoothing Clarification
- Apply smoothing only to transcript segments or events explicitly marked final by the realtime pipeline.
- Do not apply smoothing to interim or partial transcript text.
- Use the near-same start time threshold `<= 0.75s`.
- Treat text as matching when normalized text is equal or when one normalized text contains the other.
- Avoid smoothing very short text unless timing clearly matches.
- If multiple existing final segments match the near-duplicate rule, update the closest segment by startTime.
- If still tied, prefer the most recently inserted matching final segment.
- Only replace existing transcript text when the new final text is non-empty and longer or more complete.
- Do not replace meaningful existing text with empty, shorter, or obviously lower-quality text.
- Speaker update may still be applied when timing and text match strongly.
- Prefer implementation in `FE-Audiomind/src/utils/transcript.ts`.
- Avoid backend transcript rewriting unless necessary.
- Preserve stable ordering.
- Never merge unrelated segments from different time windows.

## Manual Test Checklist
- Single speaker + Vietnamese:
  - Expected Deepgram URL has `language=vi` and `diarize=false`.
  - Expected no incorrect split into multiple speakers for one audio source.
- Multiple speakers + Vietnamese:
  - Expected Deepgram URL has `language=vi` and `diarize=true`.
- English:
  - Expected Deepgram URL has `language=en`.
- Multi-language:
  - Expected Deepgram URL has `language=multi`.
  - Existing multi quality issues are not blocking this phase.
- Final segment smoothing:
  - Near-duplicate final speaker update should update existing segment instead of creating duplicate.

## Acceptance Criteria
- Single speaker sends `diarize=false` to Deepgram.
- Multiple speakers sends `diarize=true` to Deepgram.
- Missing or invalid `speakerMode` falls back to `single`.
- `vi`, `en`, and `multi` language routing still works.
- Near-duplicate final speaker updates do not create duplicate segments.
- Existing hydration/live reconciliation behavior remains stable.
- Logging is not noisy per audio chunk.

## Known Limitation
- Multi-language transcript quality is not guaranteed in Phase 5F.
- Quality tuning and broader transcript quality improvements belong to Phase 5G.

## Files Likely In Scope
- `FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts`
- `FE-Audiomind/src/utils/transcript.ts`
- `FE-Audiomind/src/App.tsx`
- `FE-Audiomind/src/hooks/useRealtimeMeetingStream.test.tsx`
- `FE-Audiomind/src/App.test.tsx`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java`
- `demoRecordAUDIOMID/processing-service/src/test/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandlerTest.java`
- `demoRecordAUDIOMID/processing-service/src/test/java/com/example/processingservice/client/AIServiceClientTest.java`
- `demoRecordAUDIOMID/ai-service/app/main.py`
- `demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py`
- `demoRecordAUDIOMID/ai-service/tests/test_deepgram_stt_adapter.py`
- `demoRecordAUDIOMID/ai-service/tests/test_stt_stream_route.py`
