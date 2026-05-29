# Phase 7L — Realtime Pause/Resume Detection

## 1. Status

- SPEC-ONLY
- Branch: `feature/realtime-pause-resume-spec`
- Date: 2026-05-28
- No runtime changes

## 2. Background

- Demo realtime hiện tại giữ session sống theo kiểu record-until-stop, nhưng chưa có trạng thái pause/resume tự động khi người nói im lặng rồi nói lại.
- User expectation cho flow demo là: khi im lặng thì UI phản ánh Paused, khi nói tiếp thì quay lại Listening/Resumed, nhưng meeting vẫn phải sống tiếp.
- Stop/Finish là một hành động khác về mặt vòng đời: đó mới là lúc kết thúc session, finalize transcript, và cho phép analysis chạy.
- Phase này không nhằm tối ưu STT routing, không đổi default/multi behavior, và không chạm vào model/language selection.

## Pause model decision

MVP should implement soft auto-pause first:

- VAD detects silence.
- UI shows Paused.
- Existing transcript stays visible.
- Meeting, microphone stream, and WebSocket stay alive.
- No `stream.stop`.
- No finalize.
- No analysis trigger.
- No transcript clear/reset.

Transport-level pause/resume may reuse existing `stream.pause` / `stream.resume` only after verifying it does not close the socket, clear transcript state, or route into finalization.

Do not call `MediaRecorder.pause()` / `MediaRecorder.resume()` for automatic silence pause unless implementation proves it will not break chunk timing or STT continuity.

## 3. Goals

- Detect speaker silence in realtime.
- Show Paused state in the UI.
- Resume when speaker speaks again.
- Keep meeting/session alive during pause.
- Keep WebSocket open during pause.
- Do not finalize transcript on pause.
- Do not trigger analysis on pause.
- Preserve transcript fragments collected before and after pause.

## 4. Non-goals

- No STT provider change.
- No multi-language optimization.
- No Gemini analysis optimization.
- No analysis prompt rewrite.
- No backend redesign unless a small event/log addition is proven necessary.
- No contract-breaking change.
- No change to STT routing, default language, or multi behavior.

## 5. Current realtime audit

| Area | File/path | Current behavior | Gap |
| ---- | --------- | ---------------- | --- |
| Realtime dashboard shell | [FE-Audiomind/src/components/features/RealtimeDashboardScene.tsx](../FE-Audiomind/src/components/features/RealtimeDashboardScene.tsx) | Renders the live recording panel, language/speaker-mode selectors, transcript, and analysis card after stop. | No automatic pause/resume state is surfaced to the dashboard; the live status text does not distinguish silent pause from active listening. |
| Recorder UI | [FE-Audiomind/src/components/realtime/AudioRecorderButton.tsx](../FE-Audiomind/src/components/realtime/AudioRecorderButton.tsx) | Supports `idle`, `connecting`, `recording`, `paused`, `stopping`, `stopped`, and `error` states, including manual pause/resume button behavior. | Pause is only a manual recorder control; there is no silence-driven VAD that transitions into paused automatically. |
| Audio capture | [FE-Audiomind/src/hooks/useAudioRecorder.ts](../FE-Audiomind/src/hooks/useAudioRecorder.ts) | Uses `MediaRecorder` and already has `AnalyserNode` plumbing for audio-level diagnostics. | Diagnostics exist, but there is no product VAD state machine, no silence-duration threshold, and no automatic pause/resume controller. |
| WebSocket realtime stream | [FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts](../FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts) | Already exposes `pause()` and `resume()` helpers that send `stream.pause` / `stream.resume`, keeps the socket alive, and treats `stream.stop` as the terminal path. | No auto-pause policy exists, and no UI state is linked to silence detection. |
| Realtime transcript rendering | [FE-Audiomind/src/components/transcript/RealtimeTranscript.tsx](../FE-Audiomind/src/components/transcript/RealtimeTranscript.tsx) | Renders live segments and supports a manual pause toggle on the transcript component. | The transcript component does not own silence detection or state transitions, and the main dashboard does not currently feed it a pause state. |
| Realtime socket backend | [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java) | `stream.stop` is the terminal path; it finalizes STT before closing the WebSocket. The handler also triggers realtime analysis after finalization. | Pause must not route through this stop/finalize/analysis path. No pause-specific backend event is required for MVP unless logging is needed. |
| Analysis API surface | [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java) | Exposes both live analysis and read-only saved analysis via `/processing/{meetingId}/analysis` and `/processing/{meetingId}/analysis/saved`. | The pause feature should not add new analysis triggers or alter the read-only analysis path. |
| Existing pause/resume protocol | [FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts](../FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts) | The client already knows how to ask the backend to pause/resume the stream. | The missing piece is automatic silence detection and UI/state orchestration around those messages. |

## 6. Proposed design

### Soft pause

- Keep the microphone stream alive.
- Keep the WebSocket/session alive.
- Transition UI to Paused when silence crosses the configured threshold.
- Optionally suppress sending silent chunks if that is safe and does not break transcript continuity.
- Do not call Stop/Finalize.
- Do not trigger analysis.

### Resume

- Detect speech again after the pause threshold has been reached.
- Transition UI back to Listening/Resumed.
- Continue transcript collection in the same session.
- Keep prior transcript fragments visible and append new ones normally.

### MVP implementation shape

- Add a small VAD controller on the FE side that observes microphone waveform levels.
- Reuse the existing audio capture pipeline and WebSocket session lifecycle.
- Treat pause/resume as a UI/session state change, not as a stop/restart cycle.
- Keep backend changes out of scope unless a small log/event addition is needed for observability.

### Silence chunk policy

- MVP should prefer UI soft pause while keeping the session alive.
- Do not suppress silent chunks unless it is proven that backend/STT continuity remains stable.
- If silent chunks are suppressed later, add a test and a manual validation step proving transcript still appends normally after resume.

## 7. State machine

idle → listening → silent_paused → listening_resumed → stopped → analyzing → completed

Notes:

- `listening_resumed` is a transient resume state or label that can collapse back into `listening` if the UI prefers a simpler badge set.
- `stopped` remains the only terminal user action that may lead to finalization and analysis.
- `analyzing` only begins after stop/finish.

## 8. VAD heuristic

- Use `Web Audio` `AnalyserNode` and time-domain waveform sampling.
- Compute RMS every animation frame or every 100 ms.
- Enter paused after `silenceDurationMs` below threshold.
- Resume after `resumeDurationMs` of speech above threshold.
- Keep thresholds configurable constants, not hard-coded magic values in multiple places.

Initial values:

- silenceThreshold: 0.01–0.015
- speechThreshold: 0.018–0.03
- silenceDurationMs: 2000
- resumeDurationMs: 300

Heuristic rules:

- Use a higher bar to enter pause than to exit it, so brief dips do not thrash the state.
- Debounce transitions so the UI does not oscillate on room noise.
- Never treat silence as a stop event.

## 9. UI requirements

- Badge/status: Listening / Paused / Resumed / Stopped / Analyzing.
- Copy should clearly tell the user: “Paused while silent — speak to continue”.
- Do not hide the existing transcript during pause.
- Do not reset timer or transcript on pause/resume.
- Keep the analysis panel hidden or idle until Stop/Finish starts analysis.
- If a transient resume label is used, it should be understandable in the first glance and then settle back into Listening.

## 10. Backend requirements

- Prefer no backend change for MVP.
- If backend change is needed, limit it to pause/resume logs or session telemetry.
- Do not finalize or run analysis on pause.
- Do not close the WebSocket on pause.
- Do not change STT routing/default/multi behavior.
- Do not alter the existing read-only analysis path.
- Do not change Gemini analysis behavior.
- Do not introduce backend changes if the FE-only path is sufficient.
- If backend logging is added, keep it informational only and never use it to finalize or trigger analysis.

## 11. Current implementation constraints

- `stream.stop` is already the terminal path that finalizes STT and can enqueue analysis.
- `stream.pause` / `stream.resume` already exist as protocol messages in the FE hook, so the MVP can focus on automating when those are sent.
- Audio-level diagnostics already exist in the recorder hook, which reduces the amount of new plumbing needed for VAD.
- The existing analysis guard and saved-analysis path should stay untouched.

## 12. Risk matrix

| Risk | Impact | Likelihood | Mitigation |
| ---- | ------ | ---------- | ---------- |
| False pause in quiet speaker | UI may pause while the speaker is still talking softly. | Medium | Use conservative thresholds, a minimum silence duration, and a higher resume threshold. |
| Noisy room prevents pause | UI never reaches Paused, which reduces usefulness. | Medium | Expose constants for tuning and validate in a realistic browser/microphone test. |
| Pause accidentally stops WebSocket | Transcript session would split or end early. | High | Keep pause isolated from stop/finalize logic and add tests that prove the socket stays open. |
| Lost transcript chunks | Transcript before/after pause may not merge correctly. | High | Reuse existing segment upsert/append behavior and avoid clearing transcript state. |
| Analysis triggered too early | User may see a bogus analysis job during silence. | High | Gate analysis strictly behind Stop/Finish and add regression coverage for pause paths. |
| Browser mic permission/device issues | VAD cannot start or may be unstable. | Medium | Reuse existing recorder error handling and surface a clear permission/device message. |

## 13. Acceptance criteria

- Silence for about 2 seconds shows Paused.
- Speaking again resumes Listening.
- Transcript before pause remains visible.
- Transcript after resume appends normally.
- Stop still finalizes and analysis runs once.
- Pause does not create an analysis job.
- Pause does not close the WebSocket.
- No STT routing/default/multi changes.
- Browser test passes with a real microphone.
- Manual pause button does not regress.
- Auto pause does not remove transcript state collected before silence.
- Auto resume appends new transcript into the same session.
- No analysis-trigger log appears while the session is paused.
- After multiple pause/resume cycles, Stop still triggers analysis only once.

## 14. Validation plan

Implementation-phase validation should include:

```bash
npm --prefix FE-Audiomind run build
npm --prefix FE-Audiomind run test -- <targeted tests>
```

Targeted test focus should cover:

- unit test the VAD state machine with fake RMS samples
- fake timers: speech → silence 2s → paused
- fake timers: paused → speech 300ms → resumed/listening
- noise blip below threshold does not resume
- pause does not call stop/finalize
- hook integration: pause/resume message is called if transport pause is used
- stop still only happens when the user presses Stop
- transcript state is not cleared across pause/resume
- stop still finalizes and triggers analysis exactly once
- no analysis trigger on pause

Manual browser validation:

- Start realtime.
- Speak for 5 seconds.
- Stay silent for 2-3 seconds.
- See Paused.
- Speak again.
- See Resumed/Listening.
- Stop.
- Confirm transcript + analysis completed.
- Check logs: no analysis trigger during pause.

## 15. Open questions

- Should silent chunks still be sent to the backend?
- Should threshold be user-configurable?
- Should pause state be saved in meeting metadata?
- Should we show total paused duration?
- Should the UI expose a separate transient Resumed badge or collapse it immediately into Listening?

## 16. Implementation guardrails

- Do not change STT language/default/multi behavior.
- Do not change Gemini analysis.
- Do not change the saved-analysis endpoint.
- Do not add backend changes if FE-only is enough for MVP.
- If backend changes are required, they must stay limited to pause/resume logs and must not finalize or trigger analysis.
- Do not use `MediaRecorder.pause()` / `MediaRecorder.resume()` for auto-pause unless the implementation proves it preserves chunk timing and STT continuity.

## 17. Implementation slices

Recommended order:

1. FE VAD controller and state model.
2. Hook integration with existing pause/resume messages.
3. UI badge/copy updates in the realtime dashboard.
4. Targeted FE tests for pause/resume and stop gating.
5. Manual browser validation with a real microphone.

## 18. Notes on this audit

- This spec was written from the current repo state only and remains spec-only.
- The realtime socket already has a terminal stop path and a separate analysis path; pause must stay off both of those paths.
- CodeGraph commands requested for this phase were not available in the current tool session, so the audit was grounded with targeted file reads instead.
