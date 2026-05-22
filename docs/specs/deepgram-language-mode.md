# Phase 5 Spec: Deepgram Language Mode for Realtime STT

## 1. Problem Statement

Phase 4 realtime live segments is stable:
- realtime emits multiple live segments
- transcript no longer disappears after 10-15 seconds
- stop and hydration flow are stable
- Deepgram realtime finalize / CloseStream behavior is handled more safely
- WebSocket remains the primary architecture
- SSE is not part of this phase

The remaining problem is transcript quality when Vietnamese audio contains English words or technical terms.
Current behavior can over-Vietnamize English terms or misrecognize mixed-language audio.

Phase 5 needs an explicit language mode so users can choose the right STT behavior before recording.

## 2. Scope

### In scope

- FE dropdown / selector for realtime recording language mode.
- FE passes selected language mode into realtime startup / session metadata.
- processing-service receives, validates, normalizes, and forwards language.
- ai-service uses that language when building the Deepgram realtime URL.
- Logs to verify the language path end-to-end: FE -> processing -> ai-service -> Deepgram.
- Automated tests for `vi`, `en`, and `multi`.
- Manual test matrix for Vietnamese-only, English-only, and mixed Vietnamese + English audio.
- Speaker diarization verification with two real speakers or two clearly separate audio sources.

### Out of scope

- SSE refactor.
- Auto language detection for streaming.
- Flux migration.
- Large diarization rewrite.
- Batch transcript UI changes unless required for consistency.
- Database schema change unless the implementation proves it is unavoidable.

## 3. Proposed Language Modes

Define the user-facing modes as follows:

- `vi`: Tiếng Việt
- `en`: English
- `multi`: Việt + Anh

Default:

- `vi`

Validation rule:

- Only allow `vi`, `en`, and `multi`.

Fallback rule:

- Invalid or missing language falls back to `DEEPGRAM_LANGUAGE`.
- If `DEEPGRAM_LANGUAGE` is missing or blank, fallback is `vi`.

Notes:

- Do not use streaming language detection.
- For streaming code-switching, prefer `language=multi` with a multilingual Deepgram realtime model.
- Flux multilingual with `language_hint` is research-only for later phases and does not belong in this phase.

## 4. Data Flow

Target flow:

FE selectedLanguage
-> meeting upload / start metadata or WebSocket init/auth payload
-> processing MeetingWebSocketHandler session metadata
-> AIServiceClient streamSttChunk request language
-> ai-service stream_stt_chunk normalized language
-> Deepgram WebSocket URL language parameter

### 4.1 Transport Contract

- Prefer carrying `language` in the existing WebSocket init/auth payload or the existing realtime start metadata.
- Do not create a new endpoint if the current flow already has a place to pass metadata.
- Snapshot the selected language at meeting start.
- Do not allow language changes while the session is `connecting`, `recording`, or `stopping`.
- If the user changes the selector while idle, apply the new value only to the next meeting.

### 4.2 Payload Examples

FE -> processing WebSocket init/auth example:

```json
{
  "type": "session.init",
  "meetingId": 123,
  "language": "multi"
}
```

Processing -> ai-service stream request example:

```json
{
  "meeting_id": 123,
  "seq": 5,
  "language": "multi",
  "audio": "<binary/form-data>"
}
```

ai-service -> Deepgram URL expectation:

```text
wss://api.deepgram.com/v1/listen?model=nova-3&language=multi&...
```

Do not log the API key.

### 4.3 Fallback Ownership By Layer

FE:

- default `selectedLanguage = vi`
- only send `vi`, `en`, or `multi`

processing:

- validate `vi`, `en`, and `multi`
- invalid or missing -> fallback to env / default
- log `REALTIME_LANGUAGE_SELECTED` and `AUDIO_CHUNK_LANGUAGE_EFFECTIVE`

ai-service:

- validate again as the final gate
- invalid or missing -> `DEEPGRAM_LANGUAGE` -> `vi`
- log `STT_STREAM_EFFECTIVE_CONFIG`

### Files to inspect

FE:

- FE-Audiomind/src/App.tsx
- FE-Audiomind/src/components/AudioRecorderButton.tsx
- FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts

processing:

- demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java
- demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java

ai-service:

- demoRecordAUDIOMID/ai-service/app/main.py
- demoRecordAUDIOMID/ai-service/app/config.py
- demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py

## 5. Deepgram URL Behavior

### Model resolution

Keep the current model fallback chain:

- `DEEPGRAM_REALTIME_MODEL`
- `DEEPGRAM_MODEL`
- `nova-2`

### Language resolution

Use the request language when it is valid:

- request language
- `DEEPGRAM_LANGUAGE`
- `vi`

### Endpointing guidance

Keep existing env support for endpointing.
Document the test candidates explicitly:

- `300` as the baseline
- `500` for smoother Vietnamese long speech
- `100` as the code-switching experiment

Important:

- Do not enable streaming language detection.
- Streaming diarization should use `diarize=true`.
- `diarize_model` is not for streaming.

## 6. Logs

Add or verify these logs:

- `FE_REALTIME_LANGUAGE_SELECTED` or equivalent
- `REALTIME_LANGUAGE_SELECTED` in processing
- `AUDIO_CHUNK_LANGUAGE_EFFECTIVE` in processing
- `STT_STREAM_EFFECTIVE_CONFIG model=... language=...` in ai-service
- safe Deepgram URL logs that include model, language, and endpointing without the API key

Logging rules:

- Log the effective language, not just the raw input.
- Do not log secrets or full authorization headers.
- Keep logs small enough to verify propagation without leaking payloads.

### 6.1 CI/CD Safety Notes

- If CI/CD fails, the agent may use GitHub Actions or `gh` CLI to retrieve the real logs.
- Do not guess the workflow failure cause.
- Do not commit `.env` files, logs, zip files, or debug artifacts.
- If build or test fails, collect evidence with:
  - `gh pr view`
  - `gh run list`
  - `gh run view <RUN_ID> --log-failed`

### 6.2 Manual Log Collection Command

Use this PowerShell template to collect logs for a language test run:

```powershell
cd D:\Bin\EXE101\phase3-worktree

$ids = @(MEETING_ID)
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$out = "debug-phase5-language-$($ids -join '-')-$ts"
New-Item -ItemType Directory -Force -Path $out | Out-Null

docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs --no-color --timestamps --tail 7000 `
ai-api processing-api web `
> "$out\full-logs.txt"

$pattern = (($ids | ForEach-Object { "meeting_id=$_|meetingId=$_|Meeting #$_" }) -join "|") +
"|FE_REALTIME_LANGUAGE_SELECTED|REALTIME_LANGUAGE_SELECTED|AUDIO_CHUNK_LANGUAGE_EFFECTIVE|STT_STREAM_EFFECTIVE_CONFIG|language=|model=|LIVE_SEGMENT|HYDRATION|DG_RESULT_DEBUG|ERROR|Exception|Traceback"

docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs --no-color --timestamps --tail 7500 `
ai-api processing-api web `
| Select-String -Pattern $pattern `
> "$out\filtered-logs.txt"

Compress-Archive -Path $out -DestinationPath "$out.zip" -Force
"$out.zip"
```

## 7. UI / UX Plan

- Add a compact selector in the `Ghi âm trực tiếp` section.
- Default to `Tiếng Việt`.
- Options:
  - Tiếng Việt
  - English
  - Việt + Anh
- Disable changing the selector while recording / connecting / stopping, or apply the change only to the next meeting.
- Add a short hint:
  - `Chọn Việt + Anh nếu audio có thuật ngữ tiếng Anh.`
- Keep the UI simple.
- Do not add an advanced model selector yet.

## 8. Test Matrix

### Automated tests

#### FE

- default language is `vi`
- selecting `en` passes `en` into realtime startup
- selecting `multi` passes `multi` into realtime startup
- active session language cannot change unexpectedly
- start / stop flow still works

#### processing

- valid language forwarded to ai-service
- missing language falls back correctly
- invalid language falls back correctly
- effective language is logged

#### ai-service

- `language=vi/en/multi` is accepted
- missing language falls back to env / default
- invalid language falls back to env / default
- Deepgram WebSocket URL includes the selected language
- `STT_STREAM_EFFECTIVE_CONFIG` logs the language

### Manual tests

- Vietnamese-only audio with `vi`
- English-only audio with `en`
- Vietnamese + English technical terms with `multi`
- Optional comparison runs:
  - `multi` + `endpointing=300`
  - `multi` + `endpointing=100`
  - `vi` + `endpointing=300` baseline

Record the following for each run:

- live segments count
- persisted fragments
- English technical term accuracy
- diarization behavior
- any stalled / empty-result logs

## 9. Risk Analysis

- `multi` may improve code-switching but can reduce Vietnamese-only accuracy.
- `endpointing=100` may improve responsiveness but split segments more aggressively.
- `endpointing=500` may smooth long Vietnamese utterances but increase latency.
- diarization can be unreliable when two speakers are too close to one microphone or in the same room.
- Do not change the default away from `vi` until manual validation proves the improvement.

## 10. Acceptance Criteria

- User can choose `vi`, `en`, or `multi` before recording.
- The selected language appears in FE, processing, and ai-service logs.
- Deepgram realtime URL uses the selected language.
- `vi` remains the default and regression-safe.
- Phase 4 live segments / hydration behavior stays intact.
- Tests pass.
- Manual Vietnamese + English testing shows better technical-term accuracy with `multi`, or documents a clear reason not to switch.

## 11. Implementation Plan

Split the work into small changes:

### A. Spec only

- Create this spec.
- Align the team on the contract and validation plan.

### B. Backend language propagation

- Normalize and validate language in processing-service.
- Forward the normalized value into ai-service.
- Tighten ai-service normalization and Deepgram URL building.

### C. FE selector

- Add the realtime language selector in the live recording UI.
- Thread the selected language into the realtime startup payload.

### D. Tests and manual checklist

- Add FE, processing, and ai-service tests for the three modes.
- Update the manual verification checklist with the endpointing comparison.

### E. Commit only after CI/local validation

- Do not commit until local validation and CI evidence are both acceptable.

Recommended order:

1. Backend propagation first.
2. FE selector second.
3. Tests third.
4. Manual verification fourth.
5. Commit only after CI/local validation.

## 12. Validation Plan For This Spec Step

This step is spec-only.

Expected validation commands after the file is added:

- `git status --short`
- `git diff --stat`
- `git diff --check`

## 13. Notes On Current Codebase State

- FE realtime startup already has session orchestration and stability logs.
- processing-service already captures a `language` attribute on realtime sessions and forwards `language` to ai-service.
- ai-service already normalizes streaming language input and logs the effective realtime config.
- The main work for Phase 5 is to restrict the language contract, add the user-facing selector, and make the logs / tests prove the propagation path.
