# Phase 7T-QA-F6 - Realtime Start/Resume Pre-roll + Mic Sensitivity

## 1. Problem Statement

Status: SPEC-ONLY

Branch: `docs/7t-qa-f6-start-resume-preroll-mic-sensitivity-spec`

Date: 2026-06-10

This phase plans a production-safe fix for three realtime recording quality issues:

- First words can be lost when the user clicks Start and speaks immediately.
- First words can be lost when the user resumes speaking after a soft silence pause.
- Soft speech can miss VAD resume detection because microphone sensitivity and thresholds are too conservative for quiet speakers.
- Users need a safe way to choose browser microphone noise suppression because noisy rooms benefit from filtering, while some microphones preserve voice quality better with it disabled.

Constraints:

- Keep Deepgram as the realtime STT provider.
- Do not re-enable Whisper/Ollama paths.
- Do not rewrite the whole realtime pipeline unless manual validation proves the MVP cannot meet acceptance criteria.
- Pause remains a soft UI state. It must not stop/finalize the recorder, WebSocket, Deepgram stream, or meeting session.
- Audio capture must continue into a short rolling buffer while the UI is paused.
- Do not log API keys, JWTs, env values, audio content, or secrets.

## 2. Current Implementation Audit

| File | Current responsibility | Affects | Later change? |
| ---- | ---------------------- | ------- | ------------- |
| `FE-Audiomind/src/hooks/useAudioRecorder.ts` | Owns `getUserMedia`, `MediaRecorder`, audio chunks, duration, recorder state, and `AnalyserNode` RMS diagnostics. Uses `navigator.mediaDevices.getUserMedia({ audio: true })` and `recorder.start(1000)`. Exposes real `pauseRecording()` / `resumeRecording()` that call `MediaRecorder.pause()` / `resume()`. | Start first-word loss, resume first-word loss, mic sensitivity, noise suppression. | Yes. Main FE change point for explicit mic constraints, user-selected `noiseSuppression`, shorter chunks, rolling pre-roll buffer, debug logs, and soft-pause-safe capture semantics. |
| `FE-Audiomind/src/hooks/useVoiceActivityDetection.ts` | Polls RMS every 100ms. Defaults: silence threshold `0.012`, speech threshold `0.02`, silence duration `2000ms`, resume duration `300ms`, resumed label `900ms`. Emits `listening`, `silent_paused`, `listening_resumed`. | Resume first-word loss and mic sensitivity. | Yes. Add calibration, sensitivity modes, hysteresis, and resume timing changes. Keep it UI/control oriented, not capture-stopping. |
| `FE-Audiomind/src/app/App.tsx` | Creates fresh realtime meeting, waits for `session.ready`, starts recorder, maps VAD state into lifecycle labels, sends chunks via `handleLiveChunkReady`, and stops/finalizes only on recording completion. | Start readiness gap, resume pre-roll trigger, soft pause lifecycle, F2 fresh meeting isolation. | Yes. Coordinate arming/ready/start states and route VAD resume events to pre-roll flush without stopping the recorder. |
| `FE-Audiomind/src/components/realtime/AudioRecorderButton.tsx` | Button starts `onBeforeStartRecording` then `recorder.startRecording`; dispatches new `audioChunks` to `onChunkReady`; completes after all chunk dispatch promises settle. Manual paused state currently maps to `recorder.resumeRecording()`. | Start first-word loss, manual pause semantics. | Yes, but keep small. UI should reflect preparing/arming/ready/recording and should not encourage hard recorder pause for soft pause. |
| `FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts` | Opens `/ws/meetings/{meetingId}`, sends `auth.init`, waits for authenticated `session.ready`, queues audio metadata+binary FIFO while auth is pending, sends `stream.stop` on stop, exposes `pause()`/`resume()` as text controls. | Start pre-roll flush, WebSocket ready gate, long-silence keepalive, stale-session safety. | Yes. Add explicit pre-roll metadata and bounded flush support only if implemented outside recorder; otherwise validate existing FIFO ordering. Consider client keepalive/ping text message only if backend needs it. |
| `FE-Audiomind/src/components/features/RealtimeDashboardScene.tsx` | Renders realtime dashboard, lifecycle badge, selectors, transcript, recorder widget, and analysis after stop. | UX readiness and sensitivity control. | Yes. Add mic sensitivity selector and readiness states only; no realtime logic here. |
| `FE-Audiomind/src/utils/transcript.ts` | Normalizes/upserts live and hydrated transcript segments. | Transcript display after start/resume. | Probably no. Include in regression tests only. |
| `FE-Audiomind/src/hooks/useRealtimeMeetingStream.test.tsx` | Covers connection, auth init, audio send, transcript event merging, stop close mapping, ready waiters, and stale timeout handling. | Start pre-roll queue/flush tests. | Yes. Extend for pre-roll ordering and no duplicate flush. |
| `FE-Audiomind/src/hooks/useVoiceActivityDetection.test.tsx` | Covers silence-to-paused, speech-to-resumed, noise below threshold, disabled reset, unavailable RMS. | Resume and sensitivity calibration tests. | Yes. Extend for calibration, sensitivity modes, hysteresis, and resume timing. |
| `FE-Audiomind/src/components/realtime/AudioRecorderButton.test.tsx` | Covers MediaRecorder startup, stale chunks, abort/restart, permission errors, expected session id, preflight, chunk callbacks, completion flush. | Start/preflight and chunk dispatch tests. | Yes. Extend for chunk timeslice, rolling buffer callbacks, and soft-pause-not-hard-pause behavior. |
| `FE-Audiomind/src/app/App.test.tsx` | Covers fresh meeting id, hydration, display merging, and `resolveVoiceActivityLifecycleUpdate` soft pause/resume behavior. | F2 isolation and soft pause lifecycle. | Yes. Extend for VAD resume pre-roll orchestration if helper extracted. |
| `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/config/WebSocketConfig.java` | Maps `/ws/meetings/{meetingId}` to `MeetingWebSocketHandler`. | Backend WebSocket path. | No likely change. |
| `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java` | Authenticates `auth.init`; sends `session.ready`; stores `audio.chunk` metadata; forwards following binary audio to AI API; treats `stream.stop` as terminal finalize; unknown text messages become status responses; closes on 5-minute idle when activity is next checked. | Keepalive, backend logs, stop/finalize safety. | Maybe. Add safe keepalive handling/logging only if needed. Do not route pause/resume to finalize. |
| `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java` | Posts each WebSocket audio chunk as multipart to `ai-service` `/api/v1/stt/stream`; includes `language`, `speaker_mode`, `is_final`; handles finalization replay/reset conflicts. | Backend log metadata and pre-roll observability. | Maybe. Only if new metadata must pass through. |
| `demoRecordAUDIOMID/ai-service/app/main.py` | Handles `/api/v1/stt/stream`, guards WebM continuation after terminal closes, creates/reuses `MeetingSessionActor`, supports final synthetic empty chunk. | Deepgram stream continuity and reset handling. | Maybe. No provider change; only add tests/logs if pre-roll metadata or keepalive behavior requires it. |
| `demoRecordAUDIOMID/ai-service/app/services/stt_session_actor.py` | Owns per-meeting STT session actor, queues send/recv/persist, connects adapter, finalizes on stop. | Backend continuity under chunks and finalization. | Unlikely for Option A; test if backend metadata changes. |
| `demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py` | Deepgram streaming adapter. Sends WebM/Opus bytes to Deepgram, drains transcript events, sends websocket ping after `KEEPALIVE_AFTER_IDLE_SECONDS = 15.0` only during recv/drain calls. Connects with `ping_interval=None`. | Long silence / Deepgram timeout. | Maybe. If long silence still times out, add explicit KeepAlive/control strategy driven by an idle task, not only recv. |
| `demoRecordAUDIOMID/processing-service/src/test/java/.../MeetingWebSocketHandlerTest.java` | Covers auth init language/speaker mode, binary forwarding, reset-required, stream stop/finalize, duplicate stop, no-speech status. | Backend keepalive and metadata handling. | Yes only if backend changes. |
| `demoRecordAUDIOMID/ai-service/tests/test_stt_stream_route.py`, `test_stt_session_actor.py`, `test_deepgram_stt_adapter.py` | Cover stream route/session actor behavior, retry guards, finalization, adapter Deepgram behavior. | Backend keepalive/reset safety. | Yes only if backend changes. |

## 3. Root Cause Hypotheses

- Start loss is likely caused by waiting for meeting creation and WebSocket authenticated readiness before recorder capture begins. The current recorder starts only after `handlePrepareLiveMeeting()` awaits `waitForSessionReady()`.
- `MediaRecorder.start(1000)` emits coarse one-second chunks, so the first chunk can arrive late and may not contain a clean early boundary for STT.
- Resume loss is likely caused by VAD needing sustained speech before moving from `silent_paused` to `listening_resumed`; without a rolling buffer, the first 80-300ms of speech can already be past by the time the resume event is observed.
- Soft speech can miss because VAD uses fixed thresholds and no noise-floor calibration or sensitivity mode.
- Long silence risk exists because the Deepgram adapter's keepalive ping is tied to recv/drain calls. During no audio/no recv, the Deepgram stream may remain idle longer than intended. Java also has a 5-minute idle close check when activity is processed.
- Existing `AUDIO HASH ... first16hex` diagnostics are bounded but still should not be expanded. Implementation should avoid logging audio bytes or content-like fingerprints unless explicitly approved for a short diagnostic run.

## 4. Option Comparison

| Option | Summary | Benefits | Risks | Fit |
| ------ | ------- | -------- | ----- | --- |
| A - MediaRecorder rolling buffer MVP | Keep MediaRecorder/WebM/Opus, reduce chunk size after validation, queue early start chunks until ready, keep soft-pause capture/send continuous, and add calibrated VAD and sensitivity modes. | Smallest change, aligns with current WebM/Opus Deepgram path, lower browser risk, easiest to test with existing mocks. | MediaRecorder chunks are container fragments; duplicated pre-roll may replay WebM fragments and can upset backend guard if not ordered carefully. Chunk sizes below 250ms may vary by browser. |
| B - Web Audio / AudioWorklet robust pipeline | Capture PCM frames with AudioContext/AudioWorklet, maintain 10-20ms PCM rolling buffer, stream PCM frames over WebSocket. | Best technical control over pre-roll, VAD, gain, and exact timing. | Larger rewrite, new encoding/STT contract, more browser compatibility work, more backend changes, higher production risk. |
| C - Hybrid | Implement Option A first behind a clean recorder/pre-roll boundary. Keep Option B as fallback if manual Chrome/Edge validation still clips first words. | Balances MVP speed and production safety while preserving a path to a robust pipeline. | Requires discipline to keep the Option A abstraction clean and not spread buffer logic across UI components. |

Recommendation: Hybrid Option C, with MediaRecorder-based changes as the implementation target for the MVP.

Reasons:

- The existing production path is already WebM/Opus over MediaRecorder and Deepgram. Preserving that reduces backend and provider risk.
- Existing FE tests can cover most of the behavior with current mocks.
- First-word loss is probably a readiness/buffer/timeslice problem, not proof that the entire audio stack must move to AudioWorklet.
- AudioWorklet should remain the fallback if real browser validation shows MediaRecorder cannot provide reliable short chunks or preserve first words safely.

## 5. MVP Decision

Recommended MVP: Hybrid Option C with MediaRecorder-based changes first.

Priority order:

1. Primary fix for start loss:
   - Capture mic/audio earlier after the user clicks Start.
   - Queue early chunks until the WebSocket sends authenticated `session.ready`.
   - Flush queued start chunks once the session is ready, preserving FIFO order.

2. Primary fix for resume loss:
   - Soft VAD pause must not stop `MediaRecorder`, WebSocket, Deepgram stream, or meeting session.
   - Audio should continue to be captured during soft pause.
   - Prefer continuous capture/send during soft pause so first words after silence are not gated by resume detection.

3. Conditional resume pre-roll:
   - MediaRecorder resume pre-roll replay is optional and feature-flagged.
   - WebM/Opus chunks are encoded container fragments; replaying old chunks can duplicate audio or trigger backend continuation/reset issues.
   - If browser/backend validation shows WebM replay is unsafe, do not replay old WebM chunks. Keep continuous capture/send during soft pause instead and use VAD only for UI/logging.

4. Fallback:
   - AudioWorklet remains fallback only if the MediaRecorder MVP cannot preserve first words after manual Chrome/Edge validation.

## 6. Implementation Decision Gates

### Gate A - MediaRecorder short chunks

- Test `100ms`, `200ms`, and `250ms` MediaRecorder timeslices in Chrome and Edge.
- If `100ms` is unstable, use `200ms`.
- If `200ms` is unstable, use `250ms`.
- Do not use `100ms` by default unless validated.

### Gate B - Start pre-roll

- First try capture early + queue until authenticated `session.ready`.
- Only add explicit start pre-roll replay if queued early chunks are not enough to preserve the validation phrase prefix.

### Gate C - Resume pre-roll

- First ensure soft pause does not stop capture/send.
- Only replay resume pre-roll if WebM replay is proven safe with the current browser chunks and backend continuation guards.
- Otherwise keep continuous send during soft pause and use VAD only for UI/logging.

### Gate D - KeepAlive

- Do not add backend keepalive unless long-silence manual smoke shows the stream closes or transcripts stop after silence.
- If keepalive is needed, implement it in a separate commit/PR section from the recorder/VAD work.

### Gate E - Noise Suppression Toggle

- Default microphone noise suppression ON for MVP.
- Toggle applies before recording starts.
- Do not restart `MediaRecorder`, WebSocket, or the browser `MediaStream` during active recording in the MVP.
- If live toggling is required later, make it a separate phase because it may require recreating the `MediaStream` and can risk first-word loss.
- If OFF improves voice quality for some devices, keep the toggle.
- If ON causes clipping, muffled speech, or robotic audio in smoke tests, update helper text and revisit the default before production.

## 7. Manual Pause vs Soft VAD Pause

Soft VAD pause:

- Triggered by silence detection.
- UI-only lifecycle state.
- Must not call `MediaRecorder.pause()`.
- Must not call `stream.pause` if backend treats it ambiguously.
- Must not clear chunks, transcript, meeting id, session token, WebSocket, or Deepgram session.

Manual pause button:

- Decide one of:
  - Option A: hide/disable manual pause in the realtime MVP and keep only Stop.
  - Option B: make manual pause also soft/UI-only.
  - Option C: keep hard manual pause only if explicitly labeled and never used by VAD.
- Recommendation for F6 MVP: Option A or B. Avoid hard manual pause unless a later UX decision accepts first-word-loss risk and labels it clearly.

## 8. State Machine and Sequence Diagrams

### Start flow

```text
Click Start
-> enter preparing/arming state
-> request microphone permission as early as possible
-> acquire mic
-> start MediaRecorder local capture/buffer
-> createRealtimeMeeting in parallel or immediately after mic permission starts
-> set sessionToken
-> open WebSocket
-> session.ready
-> flush queued start chunks
-> live streaming
```

### Soft pause/resume flow

```text
recording
-> VAD detects silence
-> liveLifecycleState=silent_paused
-> recorder still running
-> WebSocket still open
-> audio still captured/sent or buffered according to selected MVP path
-> VAD detects speech
-> liveLifecycleState=listening_resumed
-> log VAD_RESUMED
-> continue streaming without losing first words
```

### Stop flow

```text
User Stop
-> send stream.stop
-> finalize transcript
-> hydrate transcript
-> trigger/poll analysis
```

## 9. Recommended Approach

Implement a MediaRecorder-based rolling buffer MVP with explicit instrumentation:

- Acquire the microphone and begin local capture before user speech is expected.
- Queue chunks until `session.ready`; treat explicit WebM pre-roll replay as conditional.
- Use a bounded rolling pre-roll buffer with `startPreRollMs = 1200` for start diagnostics/fallback.
- Use `resumePreRollMs = 1200` only if Gate C proves replay is safe.
- Reduce MediaRecorder timeslice to 200ms by default after validation; test 100ms but do not default to it unless stable.
- Keep Deepgram as the only realtime STT provider.
- Keep soft pause as UI state only; recorder, capture, WebSocket, and Deepgram stay active.
- Add dynamic VAD calibration and sensitivity modes.
- Add safe, bounded logs for readiness, VAD calibration, and pre-roll flush byte counts.

## 10. Target Architecture

### A. Start Pre-roll

- Introduce an explicit startup model:
  - `preparing`: creating meeting and WebSocket session.
  - `arming`: microphone acquired and rolling buffer is filling.
  - `ready`: WebSocket authenticated and mic warmup complete.
  - `recording`: live chunks are flowing.
- Preferred flow:
  - Request mic permission as early as possible once the user clicks Start.
  - Acquire mic and start local MediaRecorder capture/buffering as soon as permission is granted.
  - Create fresh meeting and open WebSocket in parallel with mic arming, or immediately after mic permission starts if parallelization is not safe in the implementation.
  - Start MediaRecorder with validated `timesliceMs`.
  - Queue chunks locally while the backend session is not ready.
  - When `session.ready` is authenticated, flush queued start chunks before live chunks.
  - Add explicit start pre-roll replay only if this queue-to-ready path still clips first words.
- Do not wait for authenticated WebSocket `session.ready` before starting local mic capture.
- Queued local chunks must still be guarded by active `meetingId` and `sessionToken` before sending.
- Never send queued chunks if the active session token or meeting id has changed.
- If meeting creation fails, discard local buffered audio and stop the mic stream.
- If mic permission fails, show a mic permission error and do not create or continue the realtime session if avoidable.
- If implementation cannot safely parallelize `createRealtimeMeeting` and `getUserMedia`, it should still start mic capture before waiting for WebSocket `session.ready`.
- Proposed values:
  - `startPreRollMs = 1200`.
  - `initialMicWarmupMs = 300-700`.
  - `mediaRecorderTimesliceMs = 200` default after validation; use 250ms fallback if needed; use 100ms only if validated stable.

Implementation note: because MediaRecorder emits encoded WebM/Opus chunks, any explicit replay must preserve chunk order and not split binary chunks. If duplicate WebM fragments trigger backend reset guards, narrow the MVP to "capture early and queue chunks while awaiting ready" for start, and reserve exact resume pre-roll for AudioWorklet.

### B. Resume Pre-roll

- VAD controls UI and flush decisions only.
- VAD must not call `MediaRecorder.pause()` or `MediaRecorder.resume()` for automatic soft pause.
- Audio capture continues during `silent_paused`.
- Preferred MVP path: keep sending audio continuously during soft pause and use VAD for lifecycle labels/logging.
- Conditional path: on `silent_paused -> listening_resumed`, flush up to `resumePreRollMs` before sending the current live chunk only if Gate C proves WebM replay is safe.
- Prevent duplicate resume pre-roll flushes by storing the last flushed VAD transition id/time.
- Proposed values:
  - `resumePreRollMs = 1200`.
  - `resumeMinSpeechMs = 80-150`.
  - `silenceToPauseMs = 1500`.
  - `hangoverMs = 300-500`.
- If MediaRecorder chunk boundaries make resume replay unsafe, keep live chunks flowing during soft pause and use VAD only for UI. This still avoids resume loss because audio was never stopped; the rolling buffer is then mainly for diagnostics/fallback.

### C. Mic Sensitivity

- Request browser constraints:
  - `echoCancellation: true`
  - `noiseSuppression: userNoiseSuppressionEnabled`
  - `autoGainControl: true`
  - `channelCount: 1`
  - preferred `sampleRate: 48000`
- Default `userNoiseSuppressionEnabled` to true for MVP, with the user-facing toggle described in Section 11.
- Log actual `track.getSettings()` with safe fields only:
  - `channelCount`, `sampleRate`, `echoCancellation`, `noiseSuppression`, `autoGainControl`, `deviceIdPresent`.
  - Do not log device labels, device IDs, audio, or tokens.
- Add dynamic noise floor calibration:
  - `noiseCalibrationMs = 800`.
  - `speechStartThreshold = max(minStartRms, noiseFloor * startRatio)`.
  - `speechContinueThreshold` lower than start threshold for hysteresis.
  - Clamp thresholds to avoid false positives in normal rooms.
- Add modes:
  - Low: higher thresholds for noisy rooms.
  - Normal: default balanced thresholds.
  - High: lower thresholds for soft speech, still bounded by minimum absolute RMS.
- Proposed default: Normal.

### D. KeepAlive / Long Silence

- Confirm Deepgram timeout behavior in manual smoke.
- Current Python adapter sends websocket ping only when `recv_transcript_events()` runs and idle seconds exceed 15. That does not guarantee a ping during complete audio silence if no recv path is invoked.
- If long silence closes the stream, plan one of:
  - Frontend sends a safe text `stream.keepalive` to processing every 3-5 seconds while WebSocket is open and recorder is active.
  - Processing service recognizes `stream.keepalive`, updates activity, and optionally forwards an AI keepalive endpoint if needed.
  - Python Deepgram adapter owns an idle keepalive task per open session that sends Deepgram `KeepAlive` or websocket ping every 3-5 seconds while open and no audio is flowing.
- Do not finalize realtime analysis just because the user is softly paused or silent.

## 11. Noise Suppression Toggle

The realtime recording UI should expose a user-facing microphone noise suppression toggle.

Behavior:

- The toggle controls the browser audio constraint `noiseSuppression`.
- Default should be ON for MVP because most users record in rooms with fan, keyboard, or background noise.
- Users can turn it OFF if their voice sounds muffled, clipped, robotic, or too aggressively filtered.
- The toggle is separate from mic sensitivity:
  - Mic sensitivity controls VAD thresholds.
  - Noise suppression controls browser microphone preprocessing.
- Do not describe or implement this as AI/STT filtering. It is browser microphone capture preprocessing before audio reaches realtime STT.

UX recommendation:

- In realtime recording settings, near the mic sensitivity selector, add:
  - Label: `Khử nhiễu microphone`
  - Toggle values: `On` / `Off`
  - Helper text: `Bật để giảm tiếng quạt, bàn phím, tạp âm nền. Tắt nếu giọng bị méo hoặc mất âm.`
- For MVP, allow changing this before recording starts.
- During active recording, either disable the toggle or show `Áp dụng ở lần ghi tiếp theo`.
- Do not automatically restart live recording in F6 MVP because recreating the mic stream can cause first-word loss or session risk.
- If a later implementation safely supports live restart, warn clearly that changing the setting during recording may briefly reconnect the microphone.

Implementation analysis:

- Current `useAudioRecorder` uses `getUserMedia({ audio: true })`.
- F6 should replace that with explicit constraints:
  - `echoCancellation: true`
  - `noiseSuppression: userNoiseSuppressionEnabled`
  - `autoGainControl: true`
  - `channelCount: 1`
  - preferred `sampleRate: 48000`
- Read actual applied settings from `track.getSettings()` after acquisition.
- Browsers may ignore unsupported constraints or apply a different value than requested.
- Check `navigator.mediaDevices.getSupportedConstraints()?.noiseSuppression` before presenting the toggle as supported.
- If unsupported:
  - Keep recording usable.
  - Do not fail recording.
  - Disable or hide the toggle with clear helper text.
  - Log safe `MIC_CONSTRAINT_UNSUPPORTED constraint=noiseSuppression`.
- If the requested setting is ignored:
  - Show no hard error.
  - Use actual `track.getSettings().noiseSuppression` when available.
  - Log the actual applied value.
- Do not log device labels or device IDs. Log only safe settings fields:
  - `noiseSuppression`
  - `echoCancellation`
  - `autoGainControl`
  - `sampleRate`
  - `channelCount`
  - `deviceIdPresent`

## 12. FE Implementation Plan

1. Extract recorder constants/config:
   - `mediaRecorderTimesliceMs`.
   - `startPreRollMs`.
   - `resumePreRollMs`.
   - `initialMicWarmupMs`.
   - `sensitivityMode`.
   - `noiseSuppressionDefault`.
   - `noiseSuppressionToggleEnabled`.

2. Update `useAudioRecorder`:
   - Request explicit mic constraints.
   - Pass user-selected `noiseSuppression` into `getUserMedia`.
   - Log `MIC_SETTINGS` safely.
   - Start MediaRecorder with a shorter timeslice.
   - Maintain a bounded rolling buffer of recent chunks with timestamps and sizes.
   - Expose pre-roll flush helpers or events, not raw mutable refs.
   - Remove or production-guard `AUDIO HASH FRONTEND first16hex` logging.
   - Do not log audio byte prefixes or fingerprints in production.
   - Keep `abortRecording()` and `stopRecording()` terminal.
   - Avoid using `MediaRecorder.pause()` for soft VAD pause.

3. Update VAD:
   - Add calibration state and `VAD_CALIBRATED` log.
   - Support Low/Normal/High sensitivity modes.
   - Use start/continue thresholds and hangover.
   - Reduce resume confirmation to 80-150ms.
   - Keep state stable when RMS is unavailable.

4. Update App orchestration:
   - Keep fresh meeting/session token isolation unchanged.
   - Split realtime start into separate phases:
     - Arm microphone/local capture.
     - Create fresh meeting/session token.
     - Wait for WebSocket `session.ready`.
     - Flush queued start chunks.
     - Enter live streaming.
   - Allow mic arming while meeting/WebSocket is preparing.
   - Preserve F2 fresh meeting isolation and stale-session guards.
   - Flush queued start chunks once both mic and `session.ready` are ready.
   - Never send queued local chunks unless the active `sessionToken` and `meetingId` still match.
   - On VAD paused-to-resumed transition, log resume and request a resume pre-roll flush only if Gate C enables it.
   - Keep audio capture/send continuous during soft pause for the MVP path.
   - Never call stop/finalize/clear transcript on soft pause.

5. Update UI:
   - Add readiness labels only if needed: Preparing, Arming mic, Ready, Listening.
   - Add mic sensitivity selector in realtime dashboard, disabled while terminal stopping if needed.
   - Add `Khử nhiễu microphone` toggle near mic sensitivity when supported/enabled.
   - Disable the noise suppression toggle during active recording unless live stream restart is explicitly implemented in a later phase.
   - Keep controls compact and operational.

## 13. Backend/Processing Implementation Plan

Backend changes are optional for the MVP unless validation shows long silence or pre-roll metadata needs them.

Potential Java processing-service changes:

- Add explicit `stream.keepalive` handling in `MeetingWebSocketHandler.handleTextMessage`.
- Log `REALTIME_AUDIO_CHUNK_RECEIVED` using meeting id, seq, declared size, actual size, and optional `prerollType`; do not log audio bytes.
- If FE sends pre-roll metadata (`preroll: "start" | "resume"`), preserve it only for bounded logs unless AI API needs it.
- Ensure `stream.pause` and `stream.resume` remain non-terminal and do not call `finalizeSttSession`.

Potential Python ai-service changes:

- If Deepgram closes during long silence, add an adapter-owned keepalive mechanism every 3-5 seconds while the stream is open and idle.
- Prefer Deepgram's documented keepalive control message if available in the active SDK/protocol; otherwise websocket ping.
- Add tests before changing adapter behavior.

No backend change should reintroduce Whisper/Ollama fallback for realtime. Existing local fallback guards must remain off for production.

## 14. Config/Feature Flags and Threshold Proposal

Proposed FE config keys:

```env
VITE_REALTIME_PREROLL_ENABLED=true
VITE_REALTIME_START_PREROLL_MS=1200
VITE_REALTIME_RESUME_PREROLL_MS=1200
VITE_REALTIME_RECORDER_TIMESLICE_MS=200
VITE_REALTIME_VAD_DYNAMIC_ENABLED=true
VITE_REALTIME_MIC_SENSITIVITY=normal
VITE_REALTIME_NOISE_SUPPRESSION_DEFAULT=true
VITE_REALTIME_NOISE_SUPPRESSION_TOGGLE_ENABLED=true
VITE_REALTIME_KEEPALIVE_ENABLED=false
```

Initial values:

- `mediaRecorderTimesliceMs`: 200ms default after Chrome/Edge validation; allow 100ms experiment only behind validation; 250ms fallback.
- `startPreRollMs`: 1200ms.
- `resumePreRollMs`: 1200ms, conditional on safe WebM replay.
- `initialMicWarmupMs`: 500ms.
- `noiseCalibrationMs`: 800ms.
- `resumeMinSpeechMs`: 120ms.
- `silenceToPauseMs`: 1500ms.
- `hangoverMs`: 400ms.
- `keepaliveEnabled`: false until long-silence validation proves it is necessary.
- `micSensitivity`: Normal by default; High is user-selectable but not default.
- `noiseSuppressionDefault`: true.
- `noiseSuppressionToggleEnabled`: true if UI work is included in F6-1 or F6-2. If browser support is not reported, hide or disable the toggle with clear helper text.

Sensitivity modes:

| Mode | Intended use | Threshold policy |
| ---- | ------------ | ---------------- |
| Low | Noisy room | Higher `minStartRms`, higher noise multiplier. |
| Normal | Default | Balanced minimum RMS and noise multiplier. |
| High | Soft speaker | Lower `minStartRms`, lower start multiplier, conservative continue threshold to avoid noise runaway. |

All thresholds should be clamped. High sensitivity must not multiply or amplify audio content; it only changes detection thresholds.

Noise suppression config is independent from mic sensitivity. Changing one must not mutate the other.

## 15. Logging Plan

Frontend logs:

- `MIC_NOISE_SUPPRESSION_SELECTED`: `mode=on|off`.
- `MIC_SETTINGS`: safe track settings only; no labels/device ids.
- `MIC_CONSTRAINT_UNSUPPORTED`: `constraint=noiseSuppression`.
- `VAD_CALIBRATED`: noise floor, thresholds, sensitivity mode.
- `VAD_PAUSED`: meeting id, session id, silence duration.
- `VAD_RESUMED`: meeting id, session id, `prerollMs`, `flushedBytes`, `chunkSeq`.
- `RECORDING_START_ARMED`: meeting id/session id if available, timeslice, pre-roll settings.
- `RECORDING_WS_READY`: meeting id, session id, `flushStartPreroll`, `flushedBytes`.
- `REALTIME_CHUNK_SEND`: meeting id, session id, seq, size, optional `prerollMs`.
- `MIC_SENSITIVITY_CHANGED`: mode only.

Backend logs if needed:

- `REALTIME_SESSION_STARTED`: meeting id, session id.
- `REALTIME_KEEPALIVE_SENT`: service, meeting id/session id, idle ms.
- `REALTIME_AUDIO_CHUNK_RECEIVED`: meeting id, seq, declared size, actual size, optional pre-roll type.
- `REALTIME_RESUME_PREROLL_RECEIVED`: meeting id, first seq, flushed bytes.
- `REALTIME_ANALYSIS_SAVED`: meeting id after stop/finalization path completes.

Must not appear during normal new realtime sessions:

- `STT_FINALIZATION_REPLAY`
- `UPLOAD_DUPLICATE_REUSED` before realtime starts
- `streamAudioChunk Conflict`
- `REALTIME_STREAM_REJECTED_STALE_MEETING` unless intentionally testing stale terminal meeting
- Secret values, JWTs, API keys, device labels, device IDs, or audio bytes

Rules:

- Do not log audio content, transcript text for this feature, device labels, device IDs, API keys, JWTs, env values, or secrets.
- Do not log audio byte prefixes, hashes, fingerprints, or `first16hex` values in production.
- Keep only safe metadata such as size, seq, meetingId, sessionId, prerollMs, flushedBytes, `noiseSuppression`, `echoCancellation`, `autoGainControl`, `sampleRate`, `channelCount`, and `deviceIdPresent`.
- Keep logs bounded and sampleable.
- Existing first-byte audio diagnostics should be removed, guarded, or kept out of production during implementation if they conflict with this policy.

## 16. Test Plan

Frontend unit tests:

- VAD calibration computes thresholds from noise floor with clamping.
- Low/Normal/High sensitivity modes produce expected threshold ordering.
- Resume requires `resumeMinSpeechMs` but does not wait long enough to clip first words.
- Hangover prevents flicker around thresholds.
- Unavailable RMS does not cause pause/resume churn.

Frontend recorder tests:

- `getUserMedia` receives the requested constraints.
- `getUserMedia` receives `noiseSuppression: true` when the toggle is ON.
- `getUserMedia` receives `noiseSuppression: false` when the toggle is OFF.
- MediaRecorder starts with configured short timeslice.
- Start pre-roll buffer keeps only the configured rolling window.
- Start pre-roll flushes once when WebSocket/session becomes ready.
- Resume pre-roll flushes once on `silent_paused -> listening_resumed` only when Gate C enables replay.
- With replay disabled, soft pause keeps recorder/WebSocket/send active and does not wait for VAD resume before audio reaches the stream.
- Duplicate VAD resume events do not duplicate pre-roll.
- Soft pause does not call `MediaRecorder.pause()`, close WebSocket, stop recorder, clear transcript, or send `stream.stop`.
- Stale session chunks/pre-roll are still dropped.
- Unsupported browser `noiseSuppression` constraint does not block recording.
- `MIC_SETTINGS` log does not include device label or device id.

Frontend UI tests:

- Noise suppression toggle renders before recording when enabled and supported.
- Toggle is disabled while recording if MVP does not support live re-apply.
- Changing noise suppression does not modify VAD sensitivity mode.
- Changing sensitivity mode does not modify noise suppression.

Frontend WebSocket tests:

- Pre-roll metadata+binary ordering remains FIFO.
- Queued start pre-roll drains only after authenticated `session.ready`.
- Reconnect/stale token guards continue to drop old chunks.
- Stop still sends `stream.stop` and maps normal close to stopped.

Backend tests only if backend changes:

- Java handler accepts `stream.keepalive` and updates activity without finalizing.
- Java handler logs pre-roll metadata without audio bytes.
- Python Deepgram adapter sends keepalive during idle open streams.
- Existing reset-required and WebM continuation guards still pass.

Do not run Docker/browser smoke during this spec phase.

## 17. Manual Smoke Checklist

1. Start recording and speak immediately.
2. Start recording, wait until ready, then speak.
3. Speak, stay silent 3 seconds, then speak again.
4. Pause/resume by silence 5 times.
5. Speak softly after pause.
6. Stay silent for 15-20 seconds, then speak.
7. Record with noise suppression ON near fan or keyboard noise.
8. Record with noise suppression OFF.
9. Compare transcript completeness, first-word preservation, voice clarity, false VAD pauses/resumes, and background noise impact.
10. Test Chrome and Edge.
11. Confirm transcript does not lose first words.
12. Confirm no excessive false positives in a normal room.
13. Confirm logs show start queue flush, noise suppression selected/applied state, and, if enabled, resume pre-roll flush.

Manual validation phrases:

| Scenario | Phrase |
| -------- | ------ |
| Start immediate | "F6 bắt đầu một, con mèo xanh 111" |
| Start after ready | "F6 sẵn sàng hai, quả chuối tím 222" |
| Resume after silence | "F6 resume ba, chiếc xe đỏ 333" |
| Soft voice after pause | "F6 nói nhỏ bốn, bông hoa vàng 444" |
| Long silence | "F6 im lâu năm, dòng sông bạc 555" |

Acceptance:

- Transcript must preserve `F6 bắt đầu`, `F6 sẵn sàng`, `F6 resume`, `F6 nói nhỏ`, and `F6 im lâu`.
- Missing the unique prefix means F6 fails validation.

## 18. Production Validation Checklist

- Deploy only after local manual smoke passes.
- Test 3-5 realtime meetings consecutively.
- Each recording creates a fresh meeting id.
- Transcript does not include stale meeting content.
- Start/resume first words are preserved.
- Soft speech after pause is detected.
- Noise suppression ON/OFF behavior has been validated with real microphone tests.
- Logs contain no secrets, tokens, device labels, device IDs, or audio content.
- Health and monitor scripts pass after deploy.

Production log checks:

- Frontend expected:
  - `MIC_SETTINGS`
  - `MIC_NOISE_SUPPRESSION_SELECTED`
  - `VAD_CALIBRATED`
  - `RECORDING_START_ARMED`
  - `RECORDING_WS_READY`
  - `VAD_PAUSED`
  - `VAD_RESUMED`
  - `REALTIME_CHUNK_SEND`
- Backend expected:
  - `REALTIME_SESSION_STARTED`
  - `REALTIME_AUDIO_CHUNK_RECEIVED` if implemented
  - `REALTIME_ANALYSIS_SAVED` after stop
- Must not appear:
  - `STT_FINALIZATION_REPLAY` during new realtime session
  - `UPLOAD_DUPLICATE_REUSED` before realtime
  - `streamAudioChunk Conflict`
  - `REALTIME_STREAM_REJECTED_STALE_MEETING` unless intentionally testing stale terminal meeting
  - Secret values, JWT, API keys, device labels, device IDs, audio bytes

## 19. Implementation Slicing

Recommended later implementation branches/PRs:

- PR F6-1: FE capture/start readiness + explicit mic constraints + safe mic settings logging + noise suppression default config + shorter chunks + logs. Include optional pre-recording noise suppression toggle if small.
- If the toggle UI makes F6-1 too large:
  - PR F6-1a: mic constraints + logging.
  - PR F6-1b: noise suppression toggle UI.
- PR F6-2: Dynamic VAD calibration + sensitivity modes.
- PR F6-3: Soft pause/resume orchestration + optional pre-roll flush guarded by decision gate.
- PR F6-4: KeepAlive only if long-silence validation proves it is needed.

Each PR must have focused tests and must not mix Gemini, export, or unrelated business changes.

## 20. Rollout Plan

- Implement behind config defaults that can be adjusted without broad code changes.
- Start with Normal sensitivity and 200ms MediaRecorder timeslice.
- Default noise suppression ON, with user-facing pre-recording toggle enabled when supported.
- Validate locally in Chrome and Edge.
- If stable, deploy to a limited environment and test repeated fresh meetings.
- Watch logs for pre-roll flush byte counts, reset-required events, WebSocket closes, Deepgram failures, and false positive VAD resumes.

## 21. Rollback Plan

- Revert to current MediaRecorder `1000ms` timeslice and fixed VAD thresholds if shorter chunks cause instability.
- Disable pre-roll flushing while keeping mic constraints and calibration if replay causes backend reset-required conflicts.
- Disable High sensitivity if false positives are unacceptable.
- Disable the noise suppression toggle or change the default if real microphone validation shows unacceptable clipping, muffling, or robotic speech.
- Revert backend keepalive changes independently if they cause duplicate activity/finalization behavior.

## 22. Risks and Mitigations

- MediaRecorder short chunk support varies by browser. Mitigate with Chrome/Edge smoke and a 250ms fallback.
- WebM pre-roll replay may duplicate or disrupt container continuity. Mitigate by preserving whole chunks, flushing once, and falling back to continuous send during soft pause if needed.
- Lower VAD thresholds can increase false positives. Mitigate with calibration, hysteresis, hangover, and selectable sensitivity.
- Browser noise suppression support can vary or be ignored. Mitigate by checking supported constraints, logging actual `track.getSettings()` values, and keeping recording usable without the toggle.
- Noise suppression ON can muffle or clip speech on some microphones. Mitigate with a visible OFF option, clear helper text, and real microphone validation before production.
- Changing noise suppression may require recreating the `MediaStream`. Mitigate by applying the toggle before recording starts and deferring live re-apply to a later phase.
- Starting mic before WebSocket readiness can create stale-session leakage if session ids are not guarded. Mitigate by preserving existing session token checks and dropping stale chunks.
- Local mic capture may start before the backend session is ready. If meeting creation fails, buffered audio must be discarded and the mic stream stopped. Mitigate by keeping buffered chunks local until `sessionToken` is valid and `session.ready` is authenticated, then dropping stale buffers on any mismatch.
- Long silence may still close provider streams. Mitigate with explicit keepalive only after confirming timeout behavior.
- Extra logs can leak sensitive data if careless. Mitigate with an allowlist of safe fields.

## 23. Non-goals

- No production code in this spec branch.
- No provider change away from Deepgram.
- No Whisper/Ollama realtime fallback.
- No full AudioWorklet rewrite for the MVP.
- No transcript merge redesign.
- No analysis prompt or Gemini behavior changes.
- No automatic live mic stream restart for noise suppression changes in F6 MVP.
- No Docker/browser smoke in this phase.
- No commit or push in this phase.

## 24. Open Questions

- Does Chrome/Edge reliably emit 100-200ms MediaRecorder WebM chunks for the current MIME type?
- Does Deepgram accept replayed recent WebM chunks safely, or should resume protection rely on continuous capture/send during soft pause?
- Should pre-roll be represented only in FE logs, or should metadata include `prerollType` for backend validation?
- Does Deepgram require an explicit `KeepAlive` message during silence, or is websocket ping enough for the current endpoint?
- Should microphone sensitivity preference persist per user or reset per session after the MVP?
- Should noise suppression preference persist per user/device, or reset to the MVP default ON each session?
- Should unsupported `noiseSuppression` hide the toggle entirely, or show it disabled with explanatory helper text?
- If Chrome/Edge report support but ignore the requested value, is safe logging of actual applied settings enough for MVP acceptance?

## 25. Final Implementation Recommendation

Recommended:

- Implement capture early + queue-to-session-ready first.
- Start mic/local capture as early as possible after click; do not wait for WebSocket readiness.
- Flush queued start chunks only after authenticated `session.ready` and session-token validation.
- Make VAD pause UI-only.
- Keep recorder/WebSocket active during soft pause.
- Add dynamic VAD/mic sensitivity.
- Implement noise suppression as a user-facing pre-recording setting.
- Default noise suppression ON.
- Keep noise suppression separate from mic sensitivity.
- Do not live-restart the mic stream during recording in MVP.
- Validate noise suppression ON/OFF with real microphone tests before production.
- Treat WebM resume pre-roll replay as experimental and feature-flagged.
- Do not move to AudioWorklet unless MVP validation fails.
