# 7T-QA-F9 - Gate 5 Realtime / Analysis / Search / Export Hardening Spec

Updated: 2026-06-12

This is an implementation-ready spec for closing Gate 5 after the latest realtime audio, Deepgram STT, frontend hydration, manual re-analysis, and export/action-plan smoke findings.

This pass is spec-only. Do not edit Java, TypeScript, Python, Docker, browser smoke scripts, environment files, or tests while updating this document.

## 1. Evidence And Provenance

The runtime findings below come from the attached request `C:\Users\ADMIN\.codex\attachments\2c94fd86-a064-4675-afc9-1259ac837fcd\pasted-text.txt`.

The request named these artifacts:

- `audiomind-rt-meetings-9-13-debug-20260612-123836.zip`
- `localhost-1781242706233.log`
- `audiomind-reanalyze-v1-downgrade-fixed-20260612-124632.zip`
- `audiomind-reanalyze-db-20260612-124659.zip`

Those exact files were not present in the repo root during this spec pass. The attachment directory for this turn contained only `pasted-text.txt`.

Additional untracked local debug artifacts with adjacent rerun evidence names were present in the repo root and were inspected only at filename/listing level:

- `audiomind-reanalyze-db-20260612-125424.zip`
- `audiomind-reanalyze-db-20260612-125424/`
- `audiomind-reanalyze-v1-downgrade-20260612-125443.zip`
- `audiomind-reanalyze-v1-downgrade-20260612-125443/`
- `audiomind-reanalyze-v1-downgrade-fixed-20260612-125359.zip`
- `audiomind-reanalyze-v1-downgrade-fixed-20260612-125359/`
- `audiomind-reanalyze-v1-downgrade-fixed-20260612-125433/`

Their visible contained filenames include safe metadata files such as `compose-ps.txt`, `git-status.txt`, `git-diff-stat.txt`, `db-analyses.txt`, `db-meetings.txt`, `docker-logs-reanalyze.txt`, and `filtered-reanalyze.txt`. Do not print or commit raw log bodies, DB dumps, raw transcript, raw audio, secrets, tokens, prompts, Gemini responses, or long evidence text from these artifacts.

Known runtime evidence to preserve:

- Meeting 9: user did not speak. Expected and acceptable result is no transcript rows and no analysis.
- Meeting 10: user spoke with high/normal sensitivity and noise suppression on, but no transcript appeared. Logs showed chunks around `71-72` bytes.
- Meeting 11: user spoke with noise suppression off. UI showed no realtime transcript, but backend eventually had transcript rows and realtime analysis saved.
- Meeting 12: user spoke with high sensitivity and noise suppression on. Transcript appeared but was unstable. Logs showed larger chunks around `2108-3880` bytes plus `STT_SOCKET_TERMINAL_CLOSE code=1011`, `STT_RECONNECT_BLOCKED_WEBM_CONTINUATION`, and `STT_TERMINAL_FAILURE`.
- Meeting 13: user spoke with high sensitivity and noise suppression off. Only first fragments appeared live; transcript appeared after stop. Backend logs showed transcript rows and analysis saved.
- Manual Re-analyze downgraded saved analysis from `gemini-business-v2` to `gemini-business-v1` through `path=/api/meeting/3/analysis/rerun`, `promptVersion=gemini-business-v1`, `schemaVersion=gemini-business-v1`, `source=rerun`.
- Meeting History has a known Gate 5 risk: realtime meetings can remain visually stuck as `processing` even after finalize/no-transcript/completed outcomes.
- Search-A previously allowed short-query substring noise such as `ea` matching inside `team`.
- Export-A previously allowed weak or wrong evidence to be treated as action-plan evidence.

## 2. CodeGraph Grounding

CodeGraph was used first for repo exploration. The following files and symbols were inspected or confirmed:

- `FE-Audiomind/src/app/App.tsx`
  - realtime lifecycle state, `activeRealtimeSessionToken`, `hydrationRunIdRef`, `analysisPollRunIdRef`, reset/reconnect handling, `useAudioRecorder`, `useVoiceActivityDetection`, `useRealtimeMeetingStream`.
- `FE-Audiomind/src/hooks/useAudioRecorder.ts`
  - `useAudioRecorder`, `recordingSessionId`, `RECORDER_MIME_TYPE = audio/webm; codecs=opus`, safe mic settings, RMS diagnostics, `ondataavailable`, rolling chunks.
- `FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts`
  - `RealtimeSessionToken`, `flushPendingMessages`, `clearQueuedAudio`, WebSocket auth, transcript event handling, `stream.status`, `stream.error`, stale queued audio drops.
- `FE-Audiomind/src/hooks/useVoiceActivityDetection.ts`
  - `resolveVadThresholds`, `normalizeMicSensitivityMode`, dynamic noise calibration, `VAD_PAUSED`, `VAD_RESUMED`.
- `FE-Audiomind/src/components/realtime/AudioRecorderButton.tsx`
  - `onChunkReady`, `onRecordingComplete`, lifecycle labels, stopped/no-transcript display.
- `FE-Audiomind/src/components/features/RealtimeDashboardScene.tsx`
  - realtime UI ownership and lifecycle display surface.
- `FE-Audiomind/src/components/transcript/RealtimeTranscript.tsx`
  - live segment rendering and empty transcript state.
- `FE-Audiomind/src/services/api.ts`
  - `getTranscript`, `getAnalysis`, `getSavedAnalysis`, `reanalyzeMeetingAnalysis`, `uploadAudio`, `processAudio`, `listMeetingsWithParams`, action plan/export API touchpoints.
- `FE-Audiomind/src/components/features/MeetingHistoryScene.tsx`
  - Meeting History status rendering surface; must not treat finalized realtime terminal statuses as endless processing.
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java`
  - `reanalyzeMeetingAnalysis`, `resolvePromptVersion`, `resolveSchemaVersion`, `processing.analysis.prompt-version`, `processing.analysis.schema-version`.
  - CodeGraph confirmed current defaults are `gemini-business-v1` at `@Value("${processing.analysis.prompt-version:gemini-business-v1}")` and `@Value("${processing.analysis.schema-version:gemini-business-v1}")`.
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java`
  - `handleTextMessage`, `handleBinaryMessage`, `finalizeSttSession`, transcript event broadcast, `AudioStreamResetRequiredException` handling, `resetRequired` event.
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java`
  - `rerunAnalysis`, `streamAudioChunk`, AI service request payload version forwarding.
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/JobStateStore.java`
  - status storage touchpoint for finalization/no-analysis semantics.
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/TranscriptEvidenceSearchService.java`
  - `matchSearchSegment`, `countTokenHits`, `countOccurrences`; CodeGraph showed short-query matching flows through substring occurrence counting.
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/report/MeetingActionPlanBuilder.java`
  - `build`, `resolveEvidence`, `deriveTaskQuery`; CodeGraph showed verified evidence currently depends on resolver output and model evidence fallback.
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/report/MeetingActionPlanDocxGenerator.java`
  - DOCX rendering surface for verified, unverified, and no-evidence action-plan output.
- `demoRecordAUDIOMID/ai-service/app/main.py`
  - realtime STT stream route, realtime analysis enqueue/persist path, rerun endpoint.
- `demoRecordAUDIOMID/ai-service/app/pipeline.py`
  - existing batch Deepgram STT path and safe batch diagnostics, useful for the final full-audio fallback contract.
- `demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py`
  - `AIAnalyzer.PROMPT_VERSION`, `AIAnalyzer.SCHEMA_VERSION`, `prepare_analysis_for_storage`, `analyze_meeting`.
  - Local grep confirmed current AI defaults are already `gemini-business-v2`.
- `demoRecordAUDIOMID/ai-service/app/services/gemini_analyzer.py`
  - Gemini analyzer inherits `AIAnalyzer` defaults.
- `demoRecordAUDIOMID/ai-service/app/services/gemini_client.py`
  - Gemini call boundary; no prompt/raw response logging should be added.
- `demoRecordAUDIOMID/ai-service/app/services/stt_session_actor.py`
  - `MeetingSessionActor`, `_connect_session`, `submit_chunk`, `finalize`, `_retry_failed_session`, retry guard fields including `_requires_new_stream`.
- `demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py`
  - Deepgram socket connect/send path, safe config logs, socket terminal behavior.
- `demoRecordAUDIOMID/ai-service/app/services/gemini_key_manager.py`
  - Gemini key management is not a Gate 5 change target.
- Config files to verify during implementation:
  - `infra/docker-compose.dev.yml`
  - `infra/docker-compose.mvp.yml`
  - `.env.example`
  - `.env.production.example`

Relevant existing or required tests are near:

- `FE-Audiomind/src/app/App.test.tsx`
- `FE-Audiomind/src/hooks/useRealtimeMeetingStream.test.tsx`
- `FE-Audiomind/src/hooks/useAudioRecorder.test.tsx`
- `FE-Audiomind/src/hooks/useVoiceActivityDetection.test.tsx`
- `FE-Audiomind/src/components/realtime/AudioRecorderButton.test.tsx`
- `FE-Audiomind/src/components/features/RealtimeDashboardScene.test.tsx`
- `demoRecordAUDIOMID/processing-service/src/test/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandlerTest.java`
- `demoRecordAUDIOMID/processing-service/src/test/java/com/example/processingservice/service/ProcessingServiceTest.java`
- `demoRecordAUDIOMID/processing-service/src/test/java/com/example/processingservice/client/AIServiceClientTest.java`
- `demoRecordAUDIOMID/ai-service/tests/test_realtime_analysis_endpoint.py`
- `demoRecordAUDIOMID/ai-service/tests/test_stt_stream_route.py`
- `demoRecordAUDIOMID/ai-service/tests/test_stt_session_actor.py`
- `demoRecordAUDIOMID/ai-service/tests/chaos/test_stt_chaos.py`

## 3. Current Gate 5 Blocker Summary

| Blocker ID | Runtime symptom | Evidence | Suspected root cause | Affected path/files | Severity | Required fix | Acceptance criteria |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F9-R1 | Manual Re-analyze changes saved analysis metadata from v2 to v1. | Meeting 3 rerun logs show `promptVersion=gemini-business-v1` and `schemaVersion=gemini-business-v1` after saved v2. | Processing service defaults still use v1 and rerun calls `resolvePromptVersion(null)` / `resolveSchemaVersion(null)`. | `ProcessingService.java`, `AIServiceClient.java`, `ai-service/app/main.py`, `ai_analyzer.py`, FE API/display tests. | P1 | Make `gemini-business-v2` canonical default; preserve existing v2 on rerun; block implicit v2 -> v1 downgrade. | Rerun of existing v2 meeting stores and displays v2; upload, realtime, rerun analysis all return v2 metadata by default; tests fail on default v1 writes. |
| F9-R2 | User speaks but chunks are only about `71-72` bytes and no transcript appears. | Meeting 10 logs from supplied findings. | FE MediaRecorder/VAD/mic constraints may send long runs of header/control/empty WebM fragments as speech audio; backend treats them as normal. | `useAudioRecorder.ts`, `AudioRecorderButton.tsx`, `useRealtimeMeetingStream.ts`, `MeetingWebSocketHandler.java`, `AIServiceClient.java`, `ai-service/app/main.py`. | P1 | Add safe chunk integrity instrumentation, tiny-chunk streak detection, controlled invalid-audio status, and user-facing actionable error. | Speech detected plus repeated tiny chunks produces safe status/error, not silent no-transcript; valid chunks still stream normally; no raw audio previews are logged. |
| F9-R3 | Deepgram closes mid-stream with `1011`; WebM continuation reconnect is blocked and live STT fails. | Meeting 12 logs include `STT_SOCKET_TERMINAL_CLOSE code=1011`, `STT_RECONNECT_BLOCKED_WEBM_CONTINUATION`, `STT_TERMINAL_FAILURE`. | Reconnecting a Deepgram socket with continuing WebM/Opus bytes is unsafe because the new socket lacks a fresh WebM header/container start. | `stt_session_actor.py`, `stt_adapter.py`, `main.py`, `MeetingWebSocketHandler.java`, `useRealtimeMeetingStream.ts`, `App.tsx`. | P1 | For MVP, do not reconnect a WebM continuation. Mark live STT partial/failed, keep local recording, and on stop run final full-audio fallback if available. | `1011` does not silently drop the meeting; finalization either produces fallback transcript or clear controlled audio/STT error; no Gemini runs on empty transcript. |
| F9-R4 | Backend has transcript rows and analysis, but live transcript is not visible until stop or not visible during recording. | Meetings 11 and 13 supplied findings. | Live transcript event delivery/rendering and FE state hydration timing are not reliable enough; persisted hydration is becoming the primary source. | `MeetingWebSocketHandler.java`, `RealtimeEventSubscriber`, `useRealtimeMeetingStream.ts`, `RealtimeTranscript.tsx`, `RealtimeDashboardScene.tsx`, `App.tsx`. | P1 | Make partial/final events render live; persisted transcript is fallback; late persisted rows must transition UI out of no-transcript. | Live transcript event appears before stop; backend rows cannot coexist with FE terminal no-transcript state. |
| F9-R5 | Hydration/no-transcript conclusion happens too early or against the wrong session. | Prior F9 evidence showed stale meeting transcript polling; new findings show transcript appears after stop despite missing live UI. | Hydration and analysis polling can outlive owning meeting/session; empty conclusion can be inferred before backend finalization confirms empty. | `App.tsx`, `useRealtimeMeetingStream.ts`, FE API calls, processing transcript/status endpoints. | P1 | Gate hydration by `sessionToken`, `hydrationRunId`, `analysisPollRunId`, backend finalized status, and row count. | FE ignores stale hydration/poll callbacks; no old meeting transcript fetch after new session; no terminal no-transcript without backend finalized empty confirmation. |
| F9-R6 | Mic sensitivity/noise suppression combinations are unreliable; high sensitivity seems required. | Meetings 10, 12, 13 varied by sensitivity and noise suppression. | VAD thresholds, pre-roll/resume buffer, MediaRecorder constraints, and browser noise suppression may produce weak signal or tiny chunks without clear feedback. | `useVoiceActivityDetection.ts`, `useAudioRecorder.ts`, `AudioRecorderButton.tsx`, `RealtimeDashboardScene.tsx`. | P2 | Treat VAD pause as UI-only soft pause, log safe RMS calibration, preserve pre-roll/resume, and surface weak signal/tiny chunk guidance. | Normal sensitivity with speech works or shows actionable error; high sensitivity is not required for basic speech; noise suppression on/off does not silently break recording. |
| F9-R7 | No-speech meeting must end with no transcript/no analysis, not failure. | Meeting 9 supplied finding; Slice A+B behavior appears acceptable. | Empty finalized transcript can be confused with failed STT or pending transcript if status contract is loose. | `MeetingWebSocketHandler.java`, `ProcessingService.java`, `ai-service/app/main.py`, `stt_session_actor.py`, `App.tsx`. | P1 | Preserve no-speech guard: no transcript rows, no Gemini, `NO_TRANSCRIPT_AFTER_FINALIZE` / `NO_ANALYSIS`, clear UI, not generic failure. | No-speech smoke has no transcript and no analysis; logs show skipped analysis reason; UI is clear and non-failed. |
| F9-R8 | Meeting History may keep finalized realtime meetings in `processing`. | New request context for meetings 9-13. | Processing/AI/meeting-service statuses are not synchronized after realtime finalization, fallback, no-transcript, or invalid audio. | `ProcessingService.java`, `JobStateStore.java`, meeting-service status update path, `MeetingHistoryScene.tsx`, `api.ts`. | P1 | Add explicit terminal/intermediate status mapping and FE rendering for realtime outcomes. | Meetings 9-13 are not stuck in `processing` after finalize; unknown/missing status is not infinite processing. |
| F9-R9 | Search-A short queries can match inside longer words. | Prior Gate 5 evidence: `ea` matched inside `team`. | Search uses substring/occurrence counting for short queries. | `TranscriptEvidenceSearchService.java`, search controller/service tests. | P2 | Token-boundary-aware matching for short queries with safe metadata logs only. | `ea` does not match `team`; `em` does not match inside `email`; `email FPT`, `ke hoach`, and `fpt` still work. |
| F9-R10 | Export-A can include weak/wrong evidence in action plan. | Prior Gate 5 evidence. | Action plan accepts resolver/model evidence without deterministic confidence strong enough for verified evidence. | `ProcessingService.java`, `MeetingActionPlanBuilder.java`, `MeetingActionPlanDocxGenerator.java`, action-plan/report tests. | P2 | Deterministic confidence gate against persisted transcript rows; no export-time Gemini. | Correct evidence verified; weak/wrong evidence rejected; no evidence says `No transcript evidence available.`; export after rerun remains v2. |

## 4. Analysis Versioning And Cache Guard

Canonical analysis version:

- Current canonical prompt version is `gemini-business-v2`.
- Current canonical schema version is `gemini-business-v2`.
- `gemini-business-v1` may remain only as backward-compatible read support.
- `gemini-business-v1` must not be the default write path for upload analysis, realtime analysis, or manual rerun analysis.

Required behavior:

- Manual Re-analyze must never downgrade an existing v2 analysis to v1.
- If existing saved analysis has v2 metadata, rerun must preserve v2 unless the request explicitly asks for a future supported version.
- If a rerun request omits `prompt_version` and `schema_version`, processing service and AI service must default to v2.
- Processing service defaults must be changed from v1 to v2.
- AI service must keep returning `promptVersion=gemini-business-v2` and `schemaVersion=gemini-business-v2` by default.
- FE must display the saved/rerun metadata returned by the backend and must not mask a backend downgrade.
- If a request attempts to downgrade an existing v2 meeting to v1, backend must block or ignore that downgrade and log `ANALYSIS_VERSION_DOWNGRADE_BLOCKED`.
- Cache identity, canonical transcript hash identity, and analysis idempotency keys must include `promptVersion` and `schemaVersion`.
- v1 cache/result must never satisfy a v2 write or rerun request.
- v2 cache may satisfy v2 rerun only when the transcript hash and canonical transcript version match.
- Rerun must log `RERUN_ANALYSIS_VERSION_PRESERVED` when existing v2 metadata is preserved.
- Version selection must log `ANALYSIS_VERSION_SELECTED` with only safe metadata: `meetingId`, `source`, `requestedPromptVersion`, `requestedSchemaVersion`, `selectedPromptVersion`, `selectedSchemaVersion`, and `reason`.

Exact acceptance tests:

- Processing service rerun passes v2 to AI service when request omits versions.
- Processing service rerun preserves v2 from existing saved analysis metadata.
- Processing service blocks implicit v2 -> v1 downgrade and records safe metadata.
- AI service default analyzer metadata is v2.
- AI service upload analysis response contains v2 metadata.
- AI service realtime analysis response contains v2 metadata.
- AI service rerun analysis response contains v2 metadata by default.
- FE Re-analyze on an existing v2 meeting still displays v2 after rerun.
- Export/action plan after rerun uses v2 saved analysis metadata.
- Tests fail if any rerun response stores v1 by default.
- Tests fail if a v1 cache result is reused for a v2 meeting.

## 5. Audio Chunk Integrity Contract

Goal: detect invalid audio capture early and safely without logging audio bytes or treating sustained tiny chunks as valid speech.

Safe FE metadata:

- `REALTIME_AUDIO_CHUNK_OBSERVED`
- `meetingId`
- `recordingSessionId`
- `attemptId`
- `connectionSeq`
- `seq`
- `mimeType`
- `chunk.size`
- `timesliceMs`
- `recorder.state`
- `noiseSuppressionEnabled`
- `micSensitivityMode`
- `vadState`
- safe RMS/peak buckets or rounded stats when available

Safe processing/AI metadata:

- `meetingId`
- `sessionId`
- `connectionSeq` when available
- `seq`
- declared size
- binary payload size
- MIME/encoding metadata
- transcript row count
- transcript length
- Deepgram close code/reason
- controlled error/status code

Forbidden metadata:

- raw audio
- base64 audio
- hex preview
- byte dumps
- `first16hex`
- device id
- Authorization header
- access token
- env secrets
- raw transcript text
- raw prompt or Gemini response

Speech and suspicious thresholds:

- `speechDetected` is true when safe RMS/VAD/client signal has recently indicated speech.
- `speechDetectedRecently` should remain true for a configurable grace window after speech, default `10_000ms`.
- RMS may be logged only as rounded values or buckets; never log raw samples, device id, or audio.
- Repeated chunks under about `128` bytes while user is speaking are suspicious.
- The implementation must distinguish isolated WebM header/control chunks from a long run of non-audio chunks.
- Track `consecutiveTinyChunks`, rolling median chunk size, and `speechDetectedRecently`.
- Default tiny threshold: `128` bytes.
- Default suspicious streak: at least `10` chunks under threshold while recorder state is active and `speechDetectedRecently=true`.
- A few tiny chunks are allowed and must not fail recording by themselves.
- Long runs of tiny chunks must not be sent or reported as healthy speech audio without a suspicious marker.

Required behavior:

- FE logs safe metadata for every observed chunk or sampled chunk according to debug settings.
- FE logs `REALTIME_AUDIO_CHUNK_OBSERVED` with safe metadata.
- FE logs `REALTIME_TINY_CHUNK_SUSPECTED` when sustained tiny streak criteria are met.
- FE must surface a user-facing actionable error when speech is detected but chunks are consistently non-audio/tiny.
- Processing service and AI service must surface controlled safe status/error if incoming chunks are consistently tiny/non-audio.
- Valid chunks are still sent normally.
- Chunk integrity failures must not be converted to generic no-speech.
- Invalid audio capture must use a controlled status such as `INVALID_AUDIO_CAPTURE` or `FAILED_AUDIO_CAPTURE`.
- No raw audio preview logs may remain in FE, processing service, or AI service.

Required tests:

- Tiny chunks are logged as safe metadata only.
- Raw audio preview strings such as `first16hex`, base64, or byte dumps are absent.
- Speech detected plus repeated tiny chunks leads to a controlled status, not silent no-transcript.
- Valid WebM/Opus chunks are still forwarded normally.
- User-facing UI shows a clear mic/audio capture problem when speech was detected but chunks were invalid.

## 6. Deepgram WebM/Opus Reconnect Decision

Decision for MVP: prefer deterministic fallback over unsafe reconnect.

Do not reconnect a Deepgram socket with a continuing WebM/Opus byte stream unless the browser recorder has been restarted and a fresh WebM header/container start is guaranteed.

Rejected MVP options:

- Blindly reconnect WebM continuation to a new Deepgram socket.
- Pretend live STT succeeded after `STT_RECONNECT_BLOCKED_WEBM_CONTINUATION`.
- Run Gemini analysis on empty transcript after live STT terminal failure.

Allowed options:

- Keep one Deepgram socket alive and fail live STT terminally if it closes.
- If `STT_RECONNECT_BLOCKED_WEBM_CONTINUATION` occurs, mark realtime transcript as partial or `failed-live-stt`.
- Keep recording locally if browser audio is still available.
- On stop, send final full audio to a batch/final STT fallback path if available.
- If fallback is unavailable or fails, finalize with a clear controlled no-transcript/audio error.

Required status/log markers:

- `STT_SOCKET_TERMINAL_CLOSE`
- `STT_RECONNECT_BLOCKED_WEBM_CONTINUATION`
- `STT_TERMINAL_FAILURE`
- `STT_FINAL_AUDIO_FALLBACK_STARTED`
- `STT_FINAL_AUDIO_FALLBACK_COMPLETED`
- `STT_FINAL_AUDIO_FALLBACK_FAILED`

UI contract:

- Show `Transcript có thể chưa đầy đủ` when live STT becomes partial.
- Do not silently show success with missing transcript when user spoke.
- Do not instruct the user that analysis is running unless transcript rows exist.

Acceptance criteria:

- Deepgram `1011` or continuation failure does not silently drop the meeting.
- Finalization either produces transcript from fallback or a clear controlled no-transcript/audio error.
- No Gemini analysis runs on empty transcript.
- Logs show safe status transitions and no raw audio.
- Tests cover reconnect blocked, partial live STT, fallback success, and fallback unavailable/failure.

### Deepgram KeepAlive Contract

Live Deepgram WebSocket must not timeout during legitimate silence.

Required behavior:

- If the Deepgram live socket is open and no audio has been sent recently, send Deepgram `KeepAlive` as a text WebSocket message.
- Default KeepAlive interval: `3-5` seconds.
- KeepAlive must be a text control message, not binary audio.
- Do not send KeepAlive after socket terminal close.
- Do not send KeepAlive after finalization starts.
- KeepAlive must not create transcript rows.
- KeepAlive must not enqueue analysis.
- KeepAlive logs must not include secret values or raw provider payloads.

Required markers:

- `STT_KEEPALIVE_SENT`
- `STT_KEEPALIVE_SKIPPED_SOCKET_CLOSED`
- `STT_KEEPALIVE_FAILED`

Acceptance:

- Long silence does not close the live socket purely because of inactivity.
- KeepAlive stops when finalization starts or the socket closes.
- KeepAlive does not trigger transcript rows or analysis by itself.

Tests:

- Actor sends KeepAlive while socket is open and silent.
- Actor does not send KeepAlive after terminal close.
- KeepAlive failure moves the stream into a controlled STT state, not silent success.

### Deepgram Finalize Contract

On user stop, if the Deepgram socket is still alive, the system must send `Finalize` before deciding transcript is empty or fallback is needed.

Required behavior:

- `Finalize` is used to flush unprocessed live audio.
- If final transcript rows arrive after `Finalize`, persist rows and allow v2 analysis.
- If no rows arrive after `Finalize` and there is no invalid-audio evidence, proceed to final fallback or no-transcript decision.
- If the socket already terminal-closed, skip `Finalize` and go to fallback or controlled error.
- Finalize must have a timeout and must not hang stop/finalization forever.
- No terminal no-transcript decision may happen before `Finalize` or backend finalized-empty confirmation.

Required markers:

- `STT_FINALIZE_SENT`
- `STT_FINALIZE_COMPLETED`
- `STT_FINALIZE_TIMEOUT`
- `STT_FINALIZE_SKIPPED_SOCKET_CLOSED`

Acceptance:

- No terminal no-transcript state before `Finalize` or backend finalized-empty confirmation.
- Rows flushed by `Finalize` override stale FE no-transcript state.
- Gemini only runs when `rowCount > 0`.

## 7. Final Full-Audio Fallback Contract

MVP decision: implement a deterministic final full-audio fallback instead of blind WebM continuation reconnect.

Fallback trigger:

- Live STT sees `STT_SOCKET_TERMINAL_CLOSE code=1011`.
- Live STT emits `STT_RECONNECT_BLOCKED_WEBM_CONTINUATION`.
- Live STT emits `STT_TERMINAL_FAILURE`.
- Live transcript is marked partial/failed-live-stt while browser recording can continue.

Required request path:

- FE keeps local `fullAudio` from `AudioRecorderButton.onRecordingComplete`.
- On user stop, if live STT is partial/failed or backend requests fallback, FE calls a processing-service final-audio fallback endpoint.
- MVP endpoint contract: `POST /processing/{meetingId}/realtime/final-audio-fallback`.
- Request format: multipart form data.
- Required fields:
  - `audio`: final local WebM/Opus blob.
  - `meetingId`.
  - `recordingSessionId`.
  - `sessionToken` containing `{meetingId, recordingSessionId, attemptId, connectionSeq}`.
  - `language`.
  - `speakerMode`.
  - `mimeType`.
  - `fallbackReason`.
  - `idempotencyKey`.
- Recommended idempotency key: `meetingId:recordingSessionId:attemptId:connectionSeq:final-audio-fallback:v1`.

Constraints:

- Accepted MIME types:
  - `audio/webm`
  - `audio/webm; codecs=opus`
- Reject unsupported MIME with `UNSUPPORTED_AUDIO_TYPE`.
- Max fallback upload size must use the central upload policy value.
- MVP default max fallback upload size is `200MB` unless the repo already has a different single source of truth.
- Reject oversized fallback with `UPLOAD_TOO_LARGE`.
- FE final fallback request timeout: default `60-120` seconds.
- AI final STT must have a timeout/deadline and must not leave a job hanging forever.
- Processing endpoint must verify the current user owns `meetingId`.
- Processing endpoint must reject stale `sessionToken`, mismatched `meetingId`, and old `recordingSessionId`.
- Temporary fallback audio files must be deleted after processing or governed by an explicit retention policy.
- Fallback cannot be called endlessly for the same meeting/session.
- Repeated failures for the same idempotency key must return the existing terminal error.

Processing-service behavior:

- Authenticate and authorize the meeting.
- Reject stale `sessionToken` or mismatched `meetingId`.
- Persist or stream the fallback audio only as needed; do not log raw audio.
- Forward to AI service via an internal final/batch STT endpoint.
- MVP AI endpoint contract: `POST /api/internal/meeting/{meetingId}/realtime-final-stt`.
- Forward safe metadata only: `meetingId`, `recordingSessionId`, `language`, `speakerMode`, `mimeType`, `fallbackReason`, `idempotencyKey`, byte length.
- Store fallback status in `JobStateStore` or existing status store so retries are idempotent.

AI-service behavior:

- Run final STT using Deepgram batch/final path with runtime default Deepgram.
- Do not enable Whisper/Ollama.
- Persist transcript rows with a deterministic fallback source such as `realtime_final_audio_fallback`.
- Return safe status payload:
  - `meetingId`
  - `status`
  - `rowCount`
  - `transcriptRows`
  - `finalized`
  - `analysisAllowed`
  - `idempotencyKey`
  - `errorCode` when applicable
- If transcript rows are `>0`, allow analysis enqueue/run using v2 version contract.
- If transcript rows are `0`, return controlled no-transcript or controlled audio/STT error and do not run Gemini.
- If invalid audio capture was already detected, do not label the result as no-speech.

Idempotency rules:

- Retrying stop/fallback with the same idempotency key must not duplicate transcript rows.
- Retrying stop/fallback must not enqueue duplicate analysis for the same transcript hash/version.
- Fallback terminal status must be stored in the status store, not only logged.
- If fallback already completed with rows `>0`, return the existing row count/status.
- If fallback already completed with terminal `INVALID_AUDIO_CAPTURE`, `NO_TRANSCRIPT`, or `STT_FALLBACK_FAILED`, return the existing terminal status unless an explicit new recording session starts.

Required markers:

- `STT_FINAL_AUDIO_FALLBACK_STARTED`
- `STT_FINAL_AUDIO_FALLBACK_COMPLETED`
- `STT_FINAL_AUDIO_FALLBACK_FAILED`
- `STT_FINAL_AUDIO_FALLBACK_IDEMPOTENT_REPLAY`
- `REALTIME_FINAL_AUDIO_FALLBACK_REQUESTED`
- `REALTIME_FINAL_AUDIO_FALLBACK_STATUS`

Acceptance tests:

- FE sends final audio fallback on stop after WebM continuation failure.
- Processing forwards safe multipart metadata to AI service without raw audio logs.
- AI service fallback persists rows and returns `rowCount>0`.
- `rowCount>0` allows v2 analysis enqueue.
- `rowCount=0` returns controlled no-transcript or audio/STT error and does not call Gemini.
- Retry with same idempotency key does not duplicate rows or analysis.

## 8. Live Transcript Event And UI Contract

Live transcript must be live.

Required behavior:

- Realtime partial/final transcript events must render in `RealtimeTranscript` during recording.
- Persisted transcript hydration is fallback, not the primary live display path.
- If backend has transcript rows, FE must not stay in no-transcript state.
- Hydration must not conclude no transcript until backend confirms finalization is complete and empty.
- FE must not poll old meeting transcript after a new session starts.
- Stale hydration and analysis polling must be ignored by `sessionToken`, `hydrationRunId`, and `analysisPollRunId`.
- `LIVE_TRANSCRIPT_EVENT_DELIVERED` must be logged by backend when a transcript event is broadcast.
- `LIVE_TRANSCRIPT_RENDERED` must be logged by FE when a segment is rendered or accepted into live state.

State contract:

| State | Meaning | Analysis allowed? |
| --- | --- | --- |
| `idle` | No active realtime session. | No |
| `connecting` | Recorder/socket setup in progress. | No |
| `recording` | Chunks and live transcript events may arrive. | No |
| `stopping` | User requested stop; finalization starting. | No |
| `finalizing_transcript` | Waiting for backend finalization and persisted rows. | No |
| `transcript_ready` | Finalized transcript rows are present. | Yes |
| `analysis_pending` | Analysis may be requested/polled for the transcript hash. | Yes |
| `analyzing` | Analysis request/poll is active. | Yes |
| `analysis_completed` | Structured analysis exists. | No new analysis unless explicit rerun |
| `no_transcript_after_finalize` | Backend confirmed finalized empty transcript. | No |
| `stopped_no_analysis` | Display alias for finalized no-transcript/no-analysis. | No |
| `analysis_failed` | Analysis failed for a non-empty transcript or finalization errored. | Explicit retry only |
| `error` | Recording/STT error requiring user action. | No |

Tests:

- Live transcript event appears before stop.
- `RealtimeTranscript` renders partial/final events while recording.
- If backend transcript rows appear late, UI transitions from `finalizing_transcript` to `transcript_ready` or `analysis_pending`, not `stopped_no_analysis`.
- Old meeting hydration does not update a new meeting.
- Old analysis poll does not update a new meeting.
- Backend `NO_TRANSCRIPT_AFTER_FINALIZE` is the only terminal no-transcript source after finalization.

## 9. Meeting Status Synchronization Contract

Goal: after realtime finalize, processing service, AI service, meeting service, and FE Meeting History must agree on the final or intermediate state.

### Fixed Gate-A Status Enum

All Gate-A realtime/search/export specs and tests must use these exact status names.

| Status | Meaning | Setter | Transition rule | FE Meeting History label | Analysis allowed? | Terminal? |
| --- | --- | --- | --- | --- | --- | --- |
| `RECORDING` | Realtime recorder/socket is accepting audio for an active session. | FE starts session; processing acknowledges stream start. | Start recording -> `RECORDING`; stop -> `FINALIZING_TRANSCRIPT`; invalid capture -> `FAILED_AUDIO_CAPTURE`. | Đang ghi âm | No | No |
| `FINALIZING_TRANSCRIPT` | User stopped; backend is finalizing live STT, sending Finalize, hydrating rows, or preparing fallback. | Processing service / AI service. | Stop accepted -> `FINALIZING_TRANSCRIPT`; rows -> `PROCESSING_ANALYSIS`; fallback live failure -> `PARTIAL_TRANSCRIPT`; no rows true silence -> `NO_TRANSCRIPT`; provider failure -> `FAILED_STT`. | Đang lưu transcript | No | No |
| `PARTIAL_TRANSCRIPT` | Live STT produced partial rows or failed mid-stream and final fallback is pending. | Processing service / AI service. | WebM continuation blocked or live STT failed with recoverable final fallback -> `PARTIAL_TRANSCRIPT`; fallback rows -> `PROCESSING_ANALYSIS`; fallback failure -> `FAILED_STT`. | Transcript có thể chưa đầy đủ | No until `rowCount > 0` finalized | No |
| `PROCESSING_ANALYSIS` | Transcript rows exist and v2 analysis is queued/running. | Processing service / AI service. | `rowCount > 0` after live/fallback/batch STT -> `PROCESSING_ANALYSIS`; analysis success -> `COMPLETED`; analysis failure -> `FAILED_ANALYSIS`. | Đang phân tích | Yes | No |
| `COMPLETED` | Transcript rows exist and analysis is complete or cached with matching v2 identity. | Processing service / AI service. | Analysis saved/cached successfully -> `COMPLETED`. | Hoàn tất | No new analysis except explicit rerun | Yes |
| `NO_TRANSCRIPT` | True no-speech finalized empty transcript. | Processing service / AI service. | Finalize/fallback confirms `rowCount=0` and no invalid-audio evidence -> `NO_TRANSCRIPT`. | Không có transcript | No | Yes |
| `FAILED_AUDIO_CAPTURE` | Client/browser captured invalid audio despite speech signal, for example sustained tiny chunks. | FE detects and backend confirms; processing may set after validation. | Tiny streak with `speechDetectedRecently=true` -> `FAILED_AUDIO_CAPTURE`. | Lỗi thu âm | No | Yes |
| `FAILED_STT` | Deepgram live/final STT provider failed or timed out after fallback path. | AI service / processing service. | Terminal provider failure, fallback unavailable, fallback timeout -> `FAILED_STT`. | Lỗi tạo transcript | No | Yes |
| `FAILED_ANALYSIS` | Transcript exists but Gemini analysis failed or timed out. | AI service / processing service. | Non-empty transcript analysis failure -> `FAILED_ANALYSIS`; explicit rerun may re-enter `PROCESSING_ANALYSIS`. | Lỗi phân tích | Retry only | Yes until retry |

Required mapping:

- No speech finalized empty -> `NO_TRANSCRIPT`.
- Invalid audio capture -> `FAILED_AUDIO_CAPTURE`.
- Deepgram/final STT provider failed -> `FAILED_STT`.
- Live transcript partial/fallback pending -> `PARTIAL_TRANSCRIPT` or `FINALIZING_TRANSCRIPT`.
- Transcript rows `>0`, analysis pending -> `PROCESSING_ANALYSIS`.
- Transcript + analysis done -> `COMPLETED`.
- Analysis failed on non-empty transcript -> `FAILED_ANALYSIS`.

Status synchronization mapping:

| Condition | Backend canonical status | FE Meeting History rendering |
| --- | --- | --- |
| No speech, no RMS/speech signal, no valid audio chunks, finalized empty | `NO_TRANSCRIPT` | Completed with no transcript/no analysis, not failed, not processing |
| Transcript rows `>0`, analysis done | `COMPLETED` | Completed |
| Transcript rows `>0`, analysis pending/running | `PROCESSING_ANALYSIS` | Analysis processing, not transcript processing |
| Live STT failed, final fallback pending | `FINALIZING_TRANSCRIPT` or `PARTIAL_TRANSCRIPT` | Finalizing transcript / partial transcript |
| Final fallback rows `>0`, analysis pending | `PROCESSING_ANALYSIS` | Analysis processing |
| Invalid audio capture | `FAILED_AUDIO_CAPTURE` | Needs user action, not no-speech |
| STT fallback failed without invalid audio proof | `FAILED_STT` | Failed transcript generation, not endless processing |

Required behavior:

- Realtime finalization must update the status source used by Meeting History.
- Meeting History must render terminal no-transcript and invalid-audio statuses distinctly.
- Unknown/missing status must not be displayed as infinite `processing` after finalization metadata says terminal.
- FE should prefer explicit backend status over heuristic local state once a meeting appears in history.
- Status updates must use safe metadata only and must not include raw transcript text.

Acceptance:

- Meetings 9-13 do not remain stuck in `processing` after finalize.
- Meeting 9 renders no transcript/no analysis as a completed no-transcript outcome.
- Meeting 10-like invalid audio renders a mic/audio capture problem, not no-speech.
- Meeting 11/13-like late transcript rows render completed or analysis-processing, not no-transcript.
- Meeting 12-like WebM continuation failure renders partial/fallback/final status, not silent success.
- Backend and FE tests use the exact enum names in this section.

## 10. Invalid Audio Vs No Speech Decision Table

| Runtime signal | Transcript rows | Required classification | Gemini analysis? | UI result | Required markers |
| --- | --- | --- | --- | --- | --- |
| User does not speak; no speech/RMS signal; no valid speech chunks; finalized empty | `0` | `NO_TRANSCRIPT` | No | Clear no transcript/no analysis, not failed | `HYDRATION_FINALIZED_EMPTY_CONFIRMED`, `REALTIME_ANALYSIS_SKIPPED reason=no_transcript` |
| User speaks or RMS/VAD indicates speech; chunks are sustained `71-72` bytes or tiny streak | `0` | `INVALID_AUDIO_CAPTURE` / `FAILED_AUDIO_CAPTURE` | No | Mic/audio guidance | `REALTIME_TINY_CHUNK_SUSPECTED`, `REALTIME_AUDIO_SIGNAL_STATS` |
| Deepgram `1011` or WebM continuation failure before final rows | unknown or `0` | `PARTIAL_TRANSCRIPT` / `FINALIZING_TRANSCRIPT` then fallback result | No until fallback rows `>0` | Partial transcript/fallback in progress | `STT_RECONNECT_BLOCKED_WEBM_CONTINUATION`, `STT_FINAL_AUDIO_FALLBACK_STARTED` |
| Backend transcript rows appear late | `>0` | `TRANSCRIPT_READY` then analysis state | Yes, v2 only | Transition to transcript/analysis states | `LIVE_TRANSCRIPT_EVENT_DELIVERED` or hydration row-count marker |
| FE already showed no-transcript but backend rows become visible | `>0` | Correct stale state to transcript-ready | Yes, v2 only | Must leave no-transcript state | `LIVE_TRANSCRIPT_RENDERED` or hydration correction marker |
| Final fallback returns `0` rows and no invalid-audio proof | `0` | Controlled no-transcript or STT error, depending provider status | No | Clear terminal status | `STT_FINAL_AUDIO_FALLBACK_COMPLETED` or `STT_FINAL_AUDIO_FALLBACK_FAILED` |

Rules:

- Invalid audio capture is not no-speech.
- Backend transcript rows `>0` always override terminal no-transcript UI.
- Persisted rows appearing late must move FE to `transcript_ready` / `analysis_pending`.
- Gemini must never run on empty transcript text or `rowCount=0`.

## 11. VAD, Mic Sensitivity, And Noise Suppression Contract

Required behavior:

- VAD pause is UI-only soft pause for messaging and capture diagnostics.
- VAD must not stop/finalize the recorder.
- VAD must not drop the first words after resume.
- Pre-roll/resume buffer must preserve first words.
- High sensitivity must not be the only mode that works.
- Noise suppression on/off must not silently break recording.
- RMS calibration logs must be safe and rounded.
- User-facing controls must explain weak mic signal or suspicious chunk capture.

Acceptance criteria:

- Normal sensitivity with speech produces valid chunks or a controlled actionable error.
- High sensitivity is not required for basic speech.
- Noise suppression on and off both preserve recording path.
- VAD state changes do not finalize a meeting.
- No raw mic/audio/device info appears in logs.

## 12. Backend Finalization And No-Analysis Guard

Preserve Slice A+B requirements:

- No-speech meeting can end in `NO_TRANSCRIPT_AFTER_FINALIZE` / `NO_ANALYSIS`.
- No Gemini analysis enqueue if transcript rows are `0`.
- No Gemini analysis enqueue if normalized transcript text is blank.
- No lazy analysis should start after finalized empty transcript.
- No stale meeting transcript fetch after retry wait.
- No raw audio preview logs.
- No-speech must not be marked generic failed.
- Existing Slice A+B tests must remain.

Required status semantics:

| Condition | Transcript rows | Finalized? | Analysis enqueue? | UI state | Required marker |
| --- | --- | --- | --- | --- | --- |
| Pending transcript | `0` | No or unknown | No | `finalizing_transcript` | `TRANSCRIPT_NOT_READY` |
| Finalized no speech | `0` | Yes | No | `no_transcript_after_finalize` / `stopped_no_analysis` | `NO_TRANSCRIPT_AFTER_FINALIZE`, `NO_ANALYSIS` |
| Finalized transcript | `>0` | Yes | Yes, once per transcript hash/idempotency key | `transcript_ready` -> analysis states | `REALTIME_ANALYSIS_ENQUEUED` |
| Live STT failed but final audio exists | maybe `0` before fallback | Yes after fallback attempt | Only if fallback transcript rows `>0` | partial/fallback status | `STT_FINAL_AUDIO_FALLBACK_*` |
| Invalid audio chunks with speech detected | `0` | Yes | No | controlled audio error | `REALTIME_TINY_CHUNK_SUSPECTED` |

## 13. Search-A Boundary Matching Contract

Search-A is a dedicated Gate 5 slice, not carry-over.

Requirements:

- Short query matching must respect token boundaries.
- `ea` must not match inside `team`.
- `em` must not match inside `email` unless `em` is a whole token.
- `email` must still match `email FPT`.
- `ke hoach` must match `kế hoạch`.
- `fpt` must match `FPT`.
- Two-character query: exact token match only, after normalization.
- Three-character query: exact token or token-prefix match only.
- Query length `>=4`: exact phrase, all-token match, and deterministic token-overlap match may be allowed.
- Do not log raw query text if it can reveal transcript content.
- Safe search logs may include `queryLength`, `normalizedTokenCount`, `resultCount`, and `meetingId`.

Tests:

- `ea` does not match `team`.
- `em` does not match inside `email`.
- `email` matches `email FPT`.
- `ke hoach` matches `kế hoạch`.
- `fpt` matches `FPT`.
- Empty/no-result state still works.
- Search logs do not contain raw query text.

## 14. Export-A Evidence Confidence Contract

Export-A is a dedicated Gate 5 slice, not carry-over.

Requirements:

- Export must use saved v2 analysis after rerun.
- Export must not trigger Gemini/lazy analysis at export time.
- Evidence must match persisted transcript rows through deterministic search/confidence.
- Model-provided `evidenceQuote` is not trusted unless it matches transcript.
- Verified evidence requires at least one high-confidence deterministic match:
  - exact normalized phrase match,
  - all important `evidenceKeywords` matched,
  - high token-overlap score above threshold.
- Default token-overlap confidence threshold: `0.70`.
- Weak or unrelated evidence must be unverified or absent.
- If no confident evidence exists, DOCX must say `No transcript evidence available.`
- DOCX/action plan must not put wrong evidence into a task.
- Export after Re-analyze must use saved v2 analysis metadata.

Tests:

- Correct evidence is marked verified.
- Weak/wrong evidence is rejected.
- No evidence renders `No transcript evidence available.`
- Model-provided `evidenceQuote` remains unverified when it does not match persisted transcript.
- Export/action plan does not trigger Gemini or lazy analysis.
- Export after rerun remains v2.

## 15. Implementation Slices And Stop Points

### Slice R1 - Re-analyze v2 Version And Cache Guard

Likely files:

- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java`
- `demoRecordAUDIOMID/ai-service/app/main.py`
- `demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py`
- `demoRecordAUDIOMID/ai-service/app/services/analysis_runs.py`
- FE API/display tests where rerun metadata is surfaced

Exact behavior:

- Default write version is v2 for upload, realtime, and rerun.
- Existing saved v2 analysis is preserved on rerun when request omits versions.
- v2 -> v1 downgrade request is blocked or ignored.
- Cache/idempotency identity includes prompt/schema version.
- v1 cache cannot satisfy v2 rerun/write.

Required tests:

- Processing service rerun passes v2.
- AI service default analyzer metadata is v2.
- FE rerun keeps displaying v2.
- Export/action plan uses v2 saved analysis after rerun.
- Rerun cannot write v1 by default.
- v1 cache is not reused for v2.

Acceptance:

- Manual Re-analyze cannot implicitly downgrade v2 to v1.
- Saved analysis, UI metadata, and export metadata all show v2 after rerun.

Risk/rollback notes:

- Risk is cache misses increasing because version becomes part of identity.
- Rollback must not restore v1 default writes.
- Stop after this slice passes.

### Slice R2 - Audio Chunk Integrity Instrumentation And Guard

Likely files:

- `FE-Audiomind/src/hooks/useAudioRecorder.ts`
- `FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts`
- `FE-Audiomind/src/hooks/useVoiceActivityDetection.ts`
- `FE-Audiomind/src/components/realtime/AudioRecorderButton.tsx`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java`
- `demoRecordAUDIOMID/ai-service/app/main.py`

Exact behavior:

- Track `speechDetectedRecently`, `consecutiveTinyChunks`, and rolling median chunk size.
- Detect default `>=10` tiny chunks under `128` bytes while speech was detected.
- Emit `INVALID_AUDIO_CAPTURE` / controlled status for sustained tiny chunks.
- Keep valid chunks streaming normally.
- Remove/forbid raw previews including `first16hex`, base64, and byte dumps.

Required tests:

- Safe tiny-chunk logs only.
- No raw audio preview strings.
- Speech plus repeated tiny chunks produces controlled status.
- Valid chunks still stream.

Acceptance:

- Sustained `71-72` byte chunks during speech are flagged and surfaced.
- Invalid audio is not treated as no-speech.
- User sees mic/audio guidance.

Risk/rollback notes:

- Risk is false positive tiny-chunk classification on browser header/control chunks.
- Rollback threshold changes only; do not reintroduce raw audio logs.
- Stop after this slice passes.

### Slice R3 - Deepgram WebM Continuation And Final Full-Audio Fallback

Likely files:

- `demoRecordAUDIOMID/ai-service/app/services/stt_session_actor.py`
- `demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py`
- `demoRecordAUDIOMID/ai-service/app/main.py`
- `demoRecordAUDIOMID/ai-service/app/pipeline.py`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java`
- `FE-Audiomind/src/app/App.tsx`
- `FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts`
- `FE-Audiomind/src/services/api.ts`

Exact behavior:

- Do not blind reconnect WebM continuation after terminal socket close.
- Mark live transcript partial/failed-live-stt.
- On stop, FE sends local full audio fallback to `POST /processing/{meetingId}/realtime/final-audio-fallback`.
- Processing forwards to `POST /api/internal/meeting/{meetingId}/realtime-final-stt`.
- Fallback is idempotent by meeting/session/attempt/connection.
- `rowCount>0` enables v2 analysis.
- `rowCount=0` returns controlled no-transcript or audio/STT error; no Gemini.

Required tests:

- Deepgram `1011` / reconnect blocked path.
- Live STT partial status.
- Final audio fallback success.
- Final audio fallback unavailable/failure.
- Final audio fallback idempotent retry.
- No Gemini on empty transcript.

Acceptance:

- WebM continuation is not blindly reconnected.
- Fallback produces rows or controlled error.
- Stop/retry does not duplicate transcript rows or analysis.

Risk/rollback notes:

- Risk is endpoint shape mismatch between FE, processing, and AI.
- Rollback must keep blind reconnect disabled for WebM continuation.
- Stop after this slice passes.

### Slice R4 - Live Transcript Visibility, Hydration Timing, And Meeting Status Sync

Likely files:

- `FE-Audiomind/src/app/App.tsx`
- `FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts`
- `FE-Audiomind/src/components/transcript/RealtimeTranscript.tsx`
- `FE-Audiomind/src/components/features/RealtimeDashboardScene.tsx`
- `FE-Audiomind/src/components/features/MeetingHistoryScene.tsx`
- `FE-Audiomind/src/services/api.ts`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/JobStateStore.java`

Exact behavior:

- Live partial/final transcript events render during recording.
- Hydration is fallback and must not terminal no-transcript before backend finalized empty confirmation.
- Late persisted rows move UI to `transcript_ready` / `analysis_pending`.
- Meeting History renders `NO_TRANSCRIPT`, `PROCESSING_ANALYSIS`, `FINALIZING_TRANSCRIPT`, `PARTIAL_TRANSCRIPT`, `FAILED_AUDIO_CAPTURE`, `FAILED_STT`, and `FAILED_ANALYSIS`.
- Unknown/missing status does not mean processing forever after finalize.

Required tests:

- Live event appears before stop.
- Backend rows appearing late move UI to transcript-ready states.
- Old meeting hydration and analysis polling are ignored.
- `NO_TRANSCRIPT_AFTER_FINALIZE` is the only terminal no-transcript source.
- Meeting History statuses for meetings 9-13 outcomes do not stick in processing.

Acceptance:

- Meetings like 11 and 13 show live transcript or a controlled partial/fallback state.
- Meeting History agrees with backend terminal/intermediate statuses.

Risk/rollback notes:

- Risk is stale callbacks incorrectly overriding active session.
- Rollback must preserve session/run-id guards.
- Stop after this slice passes.

### Slice R5 - Search-A Boundary Matching

Likely files:

- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/TranscriptEvidenceSearchService.java`
- search controller/service tests.
- FE search UI tests only if UI state changes.

Exact behavior:

- Token-boundary-aware short query matching.
- Safe metadata logging only: query length, normalized token count, result count.
- No raw query/transcript logs.

Required tests:

- `ea` does not match `team`.
- `em` does not match inside `email`.
- `email` matches `email FPT`.
- `ke hoach` matches `kế hoạch`.
- `fpt` matches `FPT`.

Acceptance:

- Short-query noise fixed without breaking normal useful search.

Risk/rollback notes:

- Risk is reducing legitimate partial matches.
- Rollback may adjust token rules but must not restore broad two-character substring matching.

Stop after this slice passes.

### Slice R6 - Export-A Evidence Confidence

Likely files:

- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/report/MeetingActionPlanBuilder.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/report/MeetingActionPlanDocxGenerator.java`
- action-plan/report tests.

Exact behavior:

- Export/action-plan uses saved analysis only.
- No export-time Gemini/lazy analysis.
- Deterministic evidence confidence against persisted transcript rows.
- Weak/wrong evidence is unverified or absent.
- Export after rerun uses saved v2 metadata.

Required tests:

- Correct evidence verified.
- Weak/wrong evidence rejected.
- No evidence renders `No transcript evidence available.`
- No export-time Gemini.
- Export after rerun remains v2.

Acceptance:

- DOCX/action plan never labels wrong evidence as verified.

Risk/rollback notes:

- Risk is fewer verified evidence items.
- This is acceptable when confidence is weak; do not relax by trusting model quote text alone.

Stop after this slice passes.

### Slice R7 - Full Gate 5 Docker/UI Smoke

Manual cases:

1. No speech meeting.
2. Normal sensitivity + noise suppression on + speech.
3. Normal sensitivity + noise suppression off + speech.
4. High sensitivity + noise suppression on + speech.
5. High sensitivity + noise suppression off + speech.
6. Re-analyze existing v2 meeting.
7. Export action plan after re-analyze.
8. Search `ea`, `email FPT`, `ke hoach`, `fpt`.

Required log assertions:

- No raw audio/secret/transcript/prompt logs.
- Version markers show v2.
- Live/fallback/no-transcript markers match the case.
- No Gemini analysis on empty transcript.
- Meeting History is not stuck in processing after finalize.
- Search/Export acceptance checks pass.

Stop after smoke results are recorded.

Risk/rollback notes:

- Risk is cross-service smoke instability.
- Do not merge by waiving smoke failures without recording exact failed case and owner.

## 16. Implementation Must Be Full-Stack

- R1 is not done until FE displays v2 after rerun and backend/cache cannot write or reuse v1 for v2.
- R2 is not done until FE shows invalid-audio guidance and backend/AI expose controlled invalid-audio status.
- R3 is not done until FE stop sends fallback audio and processing/AI complete idempotently.
- R4 is not done until live transcript UI and Meeting History both render the correct statuses.
- R5 is not done if backend tests pass but FE still sends invalid one-character or unsafe short search requests.
- R6 is not done if backend evidence confidence is correct but FE export/loading/error state is wrong.
- Every slice must include FE, processing, AI, and UX acceptance where applicable; do not mark a slice done because only backend tests pass.

## 17. Failure Injection / Regression Tests

| Test | Setup | Action | Expected backend state | Expected FE state | Forbidden behavior | Expected marker |
| --- | --- | --- | --- | --- | --- | --- |
| Deepgram socket close `1011` | Fake live socket closes mid-stream with `1011`. | Continue recording, then stop. | `PARTIAL_TRANSCRIPT` then fallback result or `FAILED_STT`. | Partial/fallback UI, no silent success. | Blind WebM continuation reconnect; Gemini on empty rows. | `STT_SOCKET_TERMINAL_CLOSE`, `STT_RECONNECT_BLOCKED_WEBM_CONTINUATION` |
| Deepgram inactivity / KeepAlive | Open socket, long silence, no audio chunks. | Wait beyond inactivity threshold. | Socket remains open or controlled STT state on failure. | Recording/listening without failure. | Binary KeepAlive; transcript rows from KeepAlive. | `STT_KEEPALIVE_SENT` |
| Deepgram Finalize timeout | Live socket open but Finalize never returns. | User stops recording. | `FINALIZING_TRANSCRIPT` then fallback or `FAILED_STT` after timeout. | Finalizing/fallback status. | Terminal no-transcript before Finalize timeout. | `STT_FINALIZE_TIMEOUT` |
| Final audio fallback success | Live STT failed; valid full audio exists. | Stop recording, send fallback. | Rows persisted, `PROCESSING_ANALYSIS` then `COMPLETED`. | Transcript ready, analysis progress/done. | Duplicate rows; no status update. | `STT_FINAL_AUDIO_FALLBACK_COMPLETED` |
| Final audio fallback `rowCount=0` | Fallback completes with no rows and no invalid-audio evidence. | Stop recording. | `NO_TRANSCRIPT` or `FAILED_STT` by provider status; no analysis. | Clear terminal no-transcript/STT error. | Gemini call. | `STT_FINAL_AUDIO_FALLBACK_COMPLETED` |
| Final audio fallback duplicate idempotency key | Existing terminal fallback result stored. | Retry same fallback request. | Existing result returned; no duplicate rows/analysis. | Same terminal result. | New provider call for same idempotency key. | `STT_FINAL_AUDIO_FALLBACK_IDEMPOTENT_REPLAY` |
| FE double stop | Recording active. | User triggers stop twice. | One finalization/fallback path. | One finalizing state, no duplicate toasts. | Duplicate final audio upload. | `REALTIME_STOP_RECEIVED` duplicate ignored |
| Re-analyze double click | Existing v2 analysis and transcript rows. | Click Re-analyze twice. | One v2 rerun/idempotent result. | Button disabled or second click ignored. | Two Gemini calls; v1 write. | `RERUN_ANALYSIS_VERSION_PRESERVED` |
| Re-analyze v2 meeting with v1 request | Existing v2 saved analysis. | Submit rerun request asking v1. | Downgrade blocked/ignored; v2 stored. | v2 displayed. | v1 saved result. | `ANALYSIS_VERSION_DOWNGRADE_BLOCKED` |
| Meeting switch during hydration 404 retry wait | Meeting A hydration retries; user starts Meeting B. | A retry resolves late. | A callback ignored. | Meeting B state unchanged. | A transcript/status updates B. | stale hydration marker |
| Export when analysis missing | Meeting has transcript but no saved analysis. | Request export/action plan. | Structured error, no Gemini. | Analysis required message. | Lazy analysis during export. | `EXPORT_ANALYSIS_REQUIRED` |
| Export with weak/wrong evidence | Saved analysis has weak model evidence. | Build action plan/DOCX. | Evidence rejected/unverified. | No wrong verified evidence. | Wrong verified evidence. | evidence confidence marker |
| Search one-character query | Query length `1`. | Search from FE/API. | `QUERY_TOO_SHORT`, no raw query logs. | Validation message, no API call from FE when possible. | Broad substring search. | validation marker |
| Search short query `ea` | Transcript contains `team`. | Search `ea`. | No `team` substring result. | Empty/no noisy result. | Raw query/transcript logs. | safe search metadata |
| Backend rows appear after FE no-transcript UI | FE reached no-transcript before late rows. | Hydration/status returns rows `>0`. | `PROCESSING_ANALYSIS` or `COMPLETED`. | Leaves no-transcript state. | Stale terminal no-transcript. | `LIVE_TRANSCRIPT_RENDERED` |
| Invalid audio capture vs true no speech | One run has speech signal + tiny chunks; one run has silence. | Stop both. | Speech+tiny -> `FAILED_AUDIO_CAPTURE`; silence -> `NO_TRANSCRIPT`. | Distinct guidance. | Treat invalid audio as no-speech. | `REALTIME_TINY_CHUNK_SUSPECTED` |

## 18. Do Not Merge Until

Use normal commands in this spec. Agents may use `rtk` internally for token-saving command output, but user-run commands below are plain commands.

Do not merge until all commands below pass and manual smoke is complete.

FE:

```powershell
cd D:\Bin\EXE101\phase3-worktree\FE-Audiomind
npm test -- --run src/app/App.test.tsx
npm test -- --run src/hooks/useRealtimeMeetingStream.test.tsx
npm test -- --run src/components/realtime/AudioRecorderButton.test.tsx
npm test -- --run src/components/features/RealtimeDashboardScene.test.tsx
npm test -- --run src/components/features/MeetingHistoryScene.test.tsx
npm test -- --run src/services/api.test.ts
npm test -- --run --silent
npm run build
```

Processing service:

```powershell
cd D:\Bin\EXE101\phase3-worktree\demoRecordAUDIOMID\processing-service
.\mvnw.cmd "-Dtest=MeetingWebSocketHandlerTest,ProcessingServiceTest,AIServiceClientTest" test
.\mvnw.cmd test
```

AI service:

```powershell
cd D:\Bin\EXE101\phase3-worktree\demoRecordAUDIOMID\ai-service
python -m pytest tests -q
```

Docker smoke:

```powershell
cd D:\Bin\EXE101\phase3-worktree
docker compose --env-file infra/.env `
  -f infra/docker-compose.dev.yml `
  -f infra/docker-compose.mvp.yml `
  up -d --build --force-recreate web processing-api ai-api meeting-api
```

Additional targeted checks to add during implementation:

- Search-A short query boundary tests.
- Export/action-plan evidence confidence tests.
- Log safety tests for absence of `first16hex`, base64 audio, byte dumps, tokens, and secrets.

## 19. Manual Gate 5 Smoke Matrix

| Case | Expected UI result | Expected backend status | Expected log markers | Forbidden markers | Pass/fail criteria |
| --- | --- | --- | --- | --- | --- |
| Meeting A: no speech | Clear no transcript/no analysis; not failed; History not processing | `NO_TRANSCRIPT` | `HYDRATION_FINALIZED_EMPTY_CONFIRMED`, `REALTIME_ANALYSIS_SKIPPED reason=no_transcript` | Gemini request, `INVALID_AUDIO_CAPTURE`, raw audio | No transcript rows, no analysis, no processing hang |
| Meeting B: normal sensitivity + noise suppression on + speech | Live transcript or fallback/partial state with clear progress | `COMPLETED` or `PROCESSING_ANALYSIS` after rows; fallback statuses if needed | `REALTIME_AUDIO_CHUNK_OBSERVED`, `LIVE_TRANSCRIPT_RENDERED` or fallback markers | silent empty success, raw audio, v1 analysis | Transcript rows appear or controlled error explains why |
| Meeting C: normal sensitivity + noise suppression off + speech | Same as B | Same as B | Same as B | Same as B | Same as B |
| Meeting D: high sensitivity + noise suppression on + speech | Live transcript or fallback/partial state | `COMPLETED` / `PROCESSING_ANALYSIS` / fallback terminal | chunk sizes above tiny threshold after speech or fallback markers | endless processing, raw logs | Transcript or controlled fallback/error |
| Meeting E: high sensitivity + noise suppression off + speech | Live transcript or fallback/partial state | Same as D | Same as D | Same as D | Transcript or controlled fallback/error |
| Re-analyze existing v2 meeting | UI still shows v2 metadata after rerun | saved analysis v2 | `ANALYSIS_VERSION_SELECTED`, `RERUN_ANALYSIS_VERSION_PRESERVED` | `gemini-business-v1` write, downgrade success | Rerun cannot downgrade |
| Export action plan after rerun | DOCX/action plan downloads with saved v2 metadata | no new analysis job | export/action-plan safe metadata | export-time Gemini, wrong verified evidence | Correct evidence confidence behavior |
| Search `ea` | No noisy `team` substring result | normal search response | safe query metadata only | raw query/transcript logs | `ea` does not match `team` |
| Search `email FPT` | Relevant result appears | normal search response | safe query metadata only | raw query/transcript logs | `email FPT` still works |
| Search `ke hoach` | Diacritic-insensitive match appears | normal search response | safe query metadata only | raw query/transcript logs | matches `kế hoạch` |
| Search `fpt` | `FPT` match appears | normal search response | safe query metadata only | raw query/transcript logs | matches `FPT` |

## 20. Logging And Artifact Rules

Required markers:

- `REALTIME_AUDIO_CHUNK_OBSERVED`
- `REALTIME_TINY_CHUNK_SUSPECTED`
- `REALTIME_AUDIO_SIGNAL_STATS`
- `STT_SOCKET_TERMINAL_CLOSE`
- `STT_RECONNECT_BLOCKED_WEBM_CONTINUATION`
- `STT_TERMINAL_FAILURE`
- `STT_FINAL_AUDIO_FALLBACK_STARTED`
- `STT_FINAL_AUDIO_FALLBACK_COMPLETED`
- `STT_FINAL_AUDIO_FALLBACK_FAILED`
- `LIVE_TRANSCRIPT_EVENT_DELIVERED`
- `LIVE_TRANSCRIPT_RENDERED`
- `HYDRATION_FINALIZED_EMPTY_CONFIRMED`
- `ANALYSIS_VERSION_SELECTED`
- `ANALYSIS_VERSION_DOWNGRADE_BLOCKED`
- `RERUN_ANALYSIS_VERSION_PRESERVED`
- `REALTIME_ANALYSIS_SKIPPED`
- `INVALID_AUDIO_CAPTURE`
- `FAILED_AUDIO_CAPTURE`
- `MEETING_STATUS_SYNCED`
- `STT_FINAL_AUDIO_FALLBACK_IDEMPOTENT_REPLAY`
- `REALTIME_FINAL_AUDIO_FALLBACK_REQUESTED`
- `REALTIME_FINAL_AUDIO_FALLBACK_STATUS`
- `STT_KEEPALIVE_SENT`
- `STT_KEEPALIVE_SKIPPED_SOCKET_CLOSED`
- `STT_KEEPALIVE_FAILED`
- `STT_FINALIZE_SENT`
- `STT_FINALIZE_COMPLETED`
- `STT_FINALIZE_TIMEOUT`
- `STT_FINALIZE_SKIPPED_SOCKET_CLOSED`

Forbidden logs/artifacts:

- raw audio
- raw audio preview strings
- `first16hex`
- base64 audio
- byte dumps
- raw transcript text
- long evidence text
- prompt text
- raw Gemini response
- Authorization header
- access token
- API keys
- env secrets
- raw device id

Artifact rules:

- Do not commit debug zips, browser logs, local DB dumps, screenshots with secrets, or raw audio/transcript artifacts.
- If a debug artifact is required for manual review, cite filename and safe metadata only.
- Before any later commit, ensure debug artifacts are removed or ignored and not staged.

### Log-Safety Scan Requirements

Scan runtime logs and touched source for forbidden runtime logging patterns before Gate-A acceptance.

Forbidden strings to scan:

- `first16hex`
- `base64`
- `Authorization`
- `Bearer `
- `DEEPGRAM_API_KEY`
- `GEMINI_API_KEY`
- `raw transcript`
- `raw audio`
- `byte dump`
- `deviceId`
- `prompt text`
- `Gemini raw response`

Rules:

- `.env.example` and docs may mention variable names when no secret values are present.
- Runtime logs must not contain secret values or raw user content.
- Source may contain auth header constants where required, but must not log header values.
- Final Gate-A report must state whether log-safety scan passed.

## 21. Known Test Warnings / Deferred Cleanup

- React `act(...)` warnings are not a Gate 5 blocker if the relevant tests pass.
- Treat remaining `act(...)` warnings as test hygiene debt.
- Create a separate cleanup task after Gate 5 if CI cleanliness requires it.
- Do not mix `act(...)` warning cleanup into realtime audio, STT fallback, versioning, Search-A, or Export-A fixes unless a warning is causing a real failing test.

## 22. Final Gate 5 Acceptance Matrix

| Scenario | Required result | Pass/fail evidence |
| --- | --- | --- |
| No-speech meeting | No transcript, no analysis, clear UI, not failed. | `NO_TRANSCRIPT_AFTER_FINALIZE`, `NO_ANALYSIS`, `REALTIME_ANALYSIS_SKIPPED reason=no_transcript`, no Gemini request. |
| Speech, normal sensitivity, noise suppression on | Transcript appears live or controlled partial/fallback path explains issue. | Live transcript render marker or fallback markers; no silent empty success. |
| Speech, normal sensitivity, noise suppression off | Same as above. | Valid chunk stats or controlled mic/audio status. |
| Speech, high sensitivity, noise suppression on | Transcript appears live or controlled fallback. | Chunk sizes materially larger than tiny threshold after speech, or controlled error. |
| Speech, high sensitivity, noise suppression off | Transcript appears live or controlled fallback. | Backend rows and FE state agree. |
| Transcript after stop | Persisted transcript rows match FE transcript state. | `rowCount>0` transitions to `transcript_ready`; no stale no-transcript state. |
| Stale meeting/session | Old meeting transcript/analysis requests cannot update new meeting. | Session token, `hydrationRunId`, and `analysisPollRunId` guards proven by tests. |
| Deepgram `1011` / WebM continuation | No blind reconnect; partial/fallback/error state is explicit. | `STT_RECONNECT_BLOCKED_WEBM_CONTINUATION` plus fallback or controlled error markers. |
| Re-analyze existing v2 meeting | Rerun keeps v2. | `RERUN_ANALYSIS_VERSION_PRESERVED`, UI shows v2, saved metadata remains v2. |
| Upload/realtime/rerun analysis defaults | All default writes use v2. | Tests assert `gemini-business-v2` metadata. |
| Export action plan after rerun | Export uses saved v2 analysis and verified transcript evidence rules. | DOCX/action-plan tests; no export-time Gemini. |
| Search-A short query | No substring noise for short queries. | `ea` does not match `team`; `email FPT`, `ke hoach`, `fpt` still work. |
| Meeting History status | Finalized meetings do not remain stuck in processing. | Meetings 9-13 statuses map to completed/no-transcript/analysis/fallback/failure outcomes. |
| Log safety | No raw audio/transcript/prompt/secret logs. | Log scan/test confirms forbidden strings absent. |
| Test suites | FE, processing, and AI suites pass. | Commands in section 18 pass. |
| Docker smoke | Gate 5 manual cases pass. | Smoke notes with safe metadata only. |

## 23. Non-Goals And Constraints

- No Java/TypeScript/Python implementation in this spec pass.
- No test edits in this spec pass.
- No Docker/browser smoke script changes in this spec pass.
- No commit, push, or staging.
- Do not run or enable Whisper/Ollama.
- Runtime default remains Deepgram STT plus Gemini analysis.
- No DB migration unless a later implementation slice explicitly reopens the decision.
- No vector search or embeddings for Search-A.
- No PDF export.
- No UI redesign beyond states/copy required to explain realtime outcomes.
- Do not print or persist secrets, raw audio, raw transcript text, raw prompts, or long evidence text.

## 24. Open Questions Before Implementation

No major implementation decision is intentionally left open.

MVP decisions made in this spec:

- Use new final fallback contracts `POST /processing/{meetingId}/realtime/final-audio-fallback` and `POST /api/internal/meeting/{meetingId}/realtime-final-stt`.
- Continue recording after suspicious tiny chunks only long enough to surface controlled degraded status and finalization; do not call it healthy audio.
- Use invalid-audio UI copy: `Không nhận được âm thanh hợp lệ. Hãy kiểm tra microphone và thử lại.`
- Allow future analysis versions only through explicit backend allowlist; do not accept arbitrary client-provided version strings.

## 25. Final Output Checklist For This Spec Pass

When this spec pass is done, report only:

- Markdown file changed.
- Sections added or strengthened.
- Open questions, if any.
- Whether CodeGraph was used.
- Confirmation that no code/test/env/Docker files were changed.
- Confirmation that nothing was committed, staged, or pushed.

## 26. Next Implementation Prompt Recommendation

Use this order:

1. First implement R1 re-analyze v2 version and cache guard.
2. Then implement R2 audio chunk integrity and invalid-audio guard.
3. Then implement R3 Deepgram WebM continuation and final full-audio fallback.
4. Then implement R4 live transcript visibility, hydration timing, and meeting status sync.
5. Then implement R5 Search-A boundary matching.
6. Then implement R6 Export-A evidence confidence.
7. Finally run R7 full Gate 5 Docker/UI smoke.

Do not start R2/R3/R4 until R1 has passing targeted tests, because the v2 downgrade can corrupt saved F8 analysis and export/action-plan quality independently of realtime STT.
