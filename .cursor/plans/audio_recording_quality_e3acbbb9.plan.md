# Audio recording quality — approved plan (amended)

**Branch:** `feature/audio-recording-quality`

**Status:** Implemented Phase 0 → Phase 5 (2026-07-14)

## Locked design decisions (user amendments)

### 1. Dual fallback recorder (parallel from start)

```text
Acquire tabStream + microphoneStream once
→ tab recorder → realtime streamId=tab
→ mic recorder → realtime streamId=mic
→ same sources → Web Audio mix graph
→ fallback MediaRecorder records mixed destination entire session
→ fallback does NOT send WS chunks
→ fullBlob ONLY from fallback recorder chunks
```

Forbidden: `recorders.flatMap(({ chunks }) => chunks)` for final blob.

No second microphone acquire.

Cleanup: requestData fallback → stop fallback → await stop → Blob → disconnect nodes → close AudioContext → then stop source tracks.

### 2. MIME + extension with Blob

```typescript
type RecordedAudioResult = {
  blob: Blob
  mimeType: string
  extension: 'webm' | 'm4a'
}
```

Source of truth: `recorder.mimeType || requestedFormat.mimeType || blob.type`.

Map: `audio/webm*` → `.webm`, `audio/mp4*` → `.m4a`. Unknown MIME → safe fallback + warning.

`useRealtimeSession` fallback filename uses returned `extension`.

Realtime streaming uses WebM/Opus only; final/batch may use MP4 when MediaRecorder supports it.

### 3. Backend rollout / retention

Defaults: `AUDIO_ENHANCEMENT_ENABLED=false`, `AUDIO_KEEP_ENHANCED_FILE=false`.

Original never overwritten. Enhanced is temporary prepared audio until STT + local diarization complete; `KEEP=false` deletes in `finally` after all consumers. `KEEP=true` is opt-in (needs separate retention policy).

### 4–5. FFmpeg

Arg array, `shell=False`, timeout, flags `-y -nostdin -hide_banner -loglevel error -vn -map 0:a:0 -c:a pcm_s16le -ar 16000 -ac 1`.

Write `.partial` → `os.replace` only after success + non-empty + valid stream when probed.

Fallback: highpass+afftdn → highpass → PCM no filter → original. Filter retries only on filter/compat errors.

Validate input file + suffix allowlist + probe; resolved input ≠ output; symlink-safe; cleanup partials on failure/timeout.

Probe is fail-closed when FFprobe is unavailable.

### 6. Async HTTP

`final_audio_fallback` FastAPI path: `await asyncio.to_thread(run_final_audio_fallback, ...)`.

Celery pipeline: sync provider direct. No fake async Protocol wrapping `subprocess.run`.

### 7. Constraints by mode

| Mode | NS | AEC | AGC | channels |
|------|----|-----|-----|----------|
| Mic-only | toggle | true | true | 1 |
| Dual mic leg | toggle | true | true | 1 |
| Mixed mic leg | toggle | false | false | 1 |
| Tab leg | false | false | false | 1 |

Mixed AEC/AGC false is RMS/gate backward-compat, not a general rule. No WS protocol / gain-gate changes unless required.

### 8. Testing

Unit: no concat tab/mic for fullBlob; fullBlob = fallback only; MIME/extension consistent.

Manual: dual 10–20s → distinct tab/mic → graceful stop → ffprobe final file.

## Phases

0. Branch + baseline tests/build
1. Acquisition constraints + App dual wiring
2. MIME format + dual fallback mixer
3. Mic health + VAD
4. Backend FFmpeg enhancement
5. Tests + verification report

## Out of scope

Realtime WS payload shape; frontend secrets; overwriting original audio files.
