# Phase 7L — Realtime Pause/Resume Detection Audit Results

- Date: 2026-05-28
- Branch: `feature/realtime-pause-resume-spec`
- Scope: current FE realtime recording flow, VAD feasibility, and backend stop/finalize/analysis guardrails.

## Summary

- The FE already has a manual pause/resume protocol path, but there is no automatic silence-based VAD state machine.
- The realtime WebSocket remains open until `stream.stop`; pause must not route through the stop/finalize path.
- The backend analysis trigger path is tied to finalization, so pause must remain strictly non-terminal.
- No STT routing/default/multi behavior should change for this phase.
- The recommended MVP shape is soft auto-pause in the FE first, with transport pause/resume only if the socket and transcript behavior stay stable.

## Current Findings

| Area | File/path | Current behavior | Gap |
| ---- | --------- | ---------------- | --- |
| VAD source | [FE-Audiomind/src/hooks/useAudioRecorder.ts](../FE-Audiomind/src/hooks/useAudioRecorder.ts) | Audio capture already exposes analyser-based diagnostics. | Diagnostics are not promoted to product logic, so silence cannot currently pause the session automatically. |
| Realtime transport | [FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts](../FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts) | `pause()` and `resume()` already send `stream.pause` and `stream.resume`; `stopStream()` is the terminal path. | No code decides when to pause/resume based on silence or speech re-entry. |
| Live UI | [FE-Audiomind/src/components/features/RealtimeDashboardScene.tsx](../FE-Audiomind/src/components/features/RealtimeDashboardScene.tsx) | Shows one live panel with transcript and analysis after stop. | There is no explicit Paused / Resumed surface tied to actual voice activity. |
| Transcript view | [FE-Audiomind/src/components/transcript/RealtimeTranscript.tsx](../FE-Audiomind/src/components/transcript/RealtimeTranscript.tsx) | Can render manual paused state. | The main dashboard does not drive it with VAD state. |
| Stop/finalize path | [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java) | `stream.stop` finalizes STT before closing the socket and can lead to analysis. | Pause must stay completely separate from this terminal flow. |
| Analysis read path | [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java) | Supports live analysis and a read-only saved-analysis endpoint. | Pause should not touch analysis creation or read-only retrieval. |

## Implementation Notes

- Keep the microphone stream active during pause.
- Keep the WebSocket session active during pause.
- Use RMS or similar waveform sampling from `AnalyserNode` to detect silence/speech.
- Treat pause as a UI/session state transition, not a stop/restart cycle.
- Gate all analysis work behind Stop/Finish only.
- Do not suppress silent chunks unless runtime validation proves transcript continuity remains stable after resume.
- Do not use `MediaRecorder.pause()` / `MediaRecorder.resume()` for auto-pause unless it is proven safe for chunk timing and STT continuity.

## Test Strategy

- Unit-test the VAD state machine with fake RMS samples.
- Use fake timers for speech → silence 2s → paused.
- Use fake timers for paused → speech 300ms → resumed/listening.
- Verify a noise blip below threshold does not resume.
- Verify pause does not call stop/finalize.
- If transport pause is used, verify hook integration calls `stream.pause` and `stream.resume` only for auto transitions.
- Verify stop still happens only from the user Stop action.
- Verify transcript state is not cleared across pause/resume.

## Validation Intent

- FE build should continue to pass after the eventual implementation.
- Targeted FE tests should prove that pause does not stop the socket or trigger analysis.
- Manual browser validation should prove the user can pause, speak again, and still finish with a single analysis result.
- The manual run should also confirm no analysis-trigger log appears during pause and that repeated pause/resume cycles still end in exactly one analysis run after Stop.

## Notes

- No runtime code was changed for this audit.
- This report intentionally stays aligned with the spec-only requirement for Phase 7L.
