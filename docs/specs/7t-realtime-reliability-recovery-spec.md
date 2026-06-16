# 7T — Realtime Reliability & Recovery Spec

Status: SPEC-ONLY  
Branch: `docs/7t-realtime-reliability-recovery-spec`  
Baseline: `main` @ `51fac73` (`fix(ui): polish Google Meet demo interface (#98)`)  
Updated: 2026-06-16

Spec-only phase. Không implement runtime code, Docker smoke, browser smoke, deploy VPS, hoặc commit ngoài file spec này trong task spec.

---

## 1. Executive Summary

Epic **7T-Realtime-Reliability-Recovery** chốt ba blocker còn lại của Epic 1 realtime trước khi khai báo Done:

1. **Stop tail preservation** — user bấm Stop ngay sau câu cuối không được mất vài giây/câu cuối vì MediaRecorder tail chưa flush/drain đủ trước khi finalize.
2. **Gemini analysis recovery** — Gemini `503` / `429` / all keys exhausted không được làm meeting trông như hỏng; transcript vẫn completed, analysis có status retryable, auto-retry và re-analyze thủ công rõ ràng.
3. **Short transcript gate** — transcript quá ngắn / noise / 0 rows không được gọi Gemini; status và UX phải rõ, không tốn phí và không log nhiễu.

**Implementation order (2 PR):**

| PR | Slice | Services |
| --- | --- | --- |
| PR 1 | `F9-R5 Stop Tail Preservation` | `FE-Audiomind` (web), `processing-api` (drain/log/idempotency nếu cần) |
| PR 2 | `Gemini Analysis Recovery + Short Transcript Gate` | `ai-api`, `celery-worker`, `processing-api` (status propagation), `FE-Audiomind` (retry UX) |

---

## 2. Current Production Baseline

| Item | State |
| --- | --- |
| Production main | `51fac73` |
| PR #95 merged | `ee9193b` — realtime finalization hardening, final audio fallback, no-transcript/status taxonomy (`RealtimeStatusCodes`, `FAILED_AUDIO_CAPTURE`, `NO_TRANSCRIPT`) |
| PR #96 merged | `26f20ff` — Google Meet tab audio demo capture (`browser_tab`, `browser_tab_with_mic`) |
| PR #98 merged | `51fac73` — Google Meet UI polish |
| Upload flow | PASS |
| Report/action export | PASS (Evidence QA cleanup thuộc epic khác) |
| Gemini backup key | Production logs xác nhận alias `backup1` success |
| Realtime STT | Partial PASS — core finalize/hydration ổn nhưng tail loss còn tái hiện |
| Realtime analysis | Chưa ổn định — Gemini `503`/`429`/all keys exhausted; meeting UX dễ bị hiểu nhầm là failed |
| Blocker mới | Stop tail: `useAudioRecorder.stopRecording()` chỉ gọi `recorder.stop()` không `requestData()`; `finishRecording()` cleanup stream ngay trên `onstop` |
| Short transcript | Chưa có gate trước Gemini — chỉ reject `EMPTY_TRANSCRIPT` (422) |
| Analysis retry UX | Có `AnalysisStatusPanel`, `reanalyzeMeetingAnalysis`, `ANALYSIS_FAILED_RETRYABLE` ở processing Redis state; chưa có background retry scheduler |

### 2.1 CodeGraph / Fullerenes grounding (files đã phân tích)

**FE realtime stop lifecycle**

| File | Symbol | Responsibility hiện tại |
| --- | --- | --- |
| `FE-Audiomind/src/hooks/useAudioRecorder.ts` | `startRecording`, `stopRecording`, `finishRecording`, `ondataavailable` | MediaRecorder lifecycle; `stopRecording` → `recorder.stop()` only; `finishRecording` cleanup stream ngay |
| `FE-Audiomind/src/components/realtime/AudioRecorderButton.tsx` | `handleClick`, chunk dispatch effect, completion effect | Stop → `stopRecording()`; chờ pending chunk dispatches rồi `onRecordingComplete(blob)` |
| `FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts` | `stopStream`, `flushPendingMessages`, `waitForBufferedAmountToDrain` | WS queue flush + `bufferedAmount` drain 1500ms → `stream.stop` |
| `FE-Audiomind/src/app/App.tsx` | `handleLiveRecordingComplete`, `onTabAudioTrackEndedRef` | Orchestration: stopping → stopStream → hydrate → final audio fallback |
| `FE-Audiomind/src/utils/audioSourceAcquisition.ts` | `acquireAudioSource`, `mixTabAndMicrophoneStreams` | mic / tab / tab+mic sources |
| `FE-Audiomind/src/components/features/RealtimeDashboardScene.tsx` | `resolveRealtimeLifecycleBadge`, lifecycle props | UI states: recording, stopping, finalizing_transcript, analysis_* |

**Processing realtime lifecycle**

| File | Symbol | Responsibility hiện tại |
| --- | --- | --- |
| `demoRecordAUDIOMID/processing-service/.../MeetingWebSocketHandler.java` | `handleTextMessage` (`stream.stop`), `finalizeSttSession`, `completeTerminalRealtimeOutcome` | Idempotent finalize (`FINALIZED_ATTR`); taxonomy terminal; trigger analysis |
| `demoRecordAUDIOMID/processing-service/.../RealtimeStatusCodes.java` | constants | `FAILED_AUDIO_CAPTURE`, `NO_TRANSCRIPT`, `FINALIZING`, etc. |
| `demoRecordAUDIOMID/processing-service/.../ProcessingService.java` | `submitRealtimeFinalAudioFallback`, `runLazyRealtimeAnalysis` | Final audio fallback endpoint; lazy analysis trigger |
| `demoRecordAUDIOMID/ai-service/app/services/stt_session_actor.py` | `finalize` | AI-side STT session finalize + drain |

**AI / STT / analysis lifecycle**

| File | Symbol | Responsibility hiện tại |
| --- | --- | --- |
| `demoRecordAUDIOMID/ai-service/app/main.py` | `analyze_realtime_transcript`, `_analyze_and_persist_realtime_transcript`, `_finish_realtime_analysis` | Realtime analysis endpoint; Redis cooldown 90s |
| `demoRecordAUDIOMID/ai-service/app/services/gemini_key_manager.py` | `GeminiKeyManager` | Multi-key alias selection, cooldown |
| `demoRecordAUDIOMID/ai-service/app/services/gemini_client.py` | `post_json` | Per-request key rotation; `GEMINI_ALL_KEYS_EXHAUSTED` |
| `demoRecordAUDIOMID/ai-service/app/services/analysis_runs.py` | `MeetingAnalysisRun`, status constants | DB run tracking; `ANALYSIS_FAILED_RETRYABLE` defined |
| `demoRecordAUDIOMID/processing-service/.../AnalysisFailureMapping.java` | `mapFailureCode`, `resolveFailedAnalysisStatus` | Maps 429/503 → retryable codes |
| `demoRecordAUDIOMID/processing-service/.../JobStateStore.java` | `markAnalysisFailed` | Redis: `retryable`, `attemptCount`, `cooldownUntilMs`, `retryAfterSeconds` |

**FE analysis UX**

| File | Symbol | Responsibility hiện tại |
| --- | --- | --- |
| `FE-Audiomind/src/components/analysis/AnalysisStatusPanel.tsx` | re-analyze CTA | Status display + manual re-analyze |
| `FE-Audiomind/src/components/features/MeetingHistoryScene.tsx` | `getAnalysisStateFromResponse`, re-analyze handler | History detail + export guard |
| `FE-Audiomind/src/components/features/FeatureAnalysis.tsx` | hydrate + re-analyze | Analysis page |
| `FE-Audiomind/src/services/api.ts` | `reanalyzeMeetingAnalysis`, `submitRealtimeFinalAudioFallback` | Processing gateway APIs |

---

## 3. Problem Statement

### 3.1 User impact

| Symptom | Root cause (code-grounded) | User impact |
| --- | --- | --- |
| Mất cuối câu khi Stop ngay sau khi nói | `stopRecording()` không `requestData()`; `finishRecording()` cleanup tracks trước khi chunk cuối vào `audioChunks`; `stopStream()` chạy sau `onRecordingComplete` nên WS có thể thiếu tail | Transcript incomplete; user phải ghi lại |
| STT xong nhưng Gemini 503/429 | `analyze_realtime_transcript` raise 503/429; FE chưa luôn phân biệt retryable vs meeting failed; DB run đôi khi `FAILED` thay vì `ANALYSIS_FAILED_RETRYABLE` | User tưởng meeting hỏng dù transcript đã có |
| Transcript 1–2 câu ngắn vẫn gọi Gemini | Không có short gate — chỉ check empty string | Tốn phí, log nhiễu, analysis chất lượng kém hoặc fail |
| All keys exhausted | `GeminiClient` raise `GEMINI_UNAVAILABLE`/`GEMINI_RATE_LIMITED`; chưa có background retry queue đa bước | User không biết hệ thống sẽ thử lại; phải refresh thủ công |

### 3.2 Production evidence (từ baseline user report)

- Realtime STT partial pass sau PR #95–#98.
- Gemini `backup1` đã success trong logs → multi-key path hoạt động nhưng recovery end-to-end chưa đủ.
- Upload flow PASS — phải giữ regression-free.

---

## 4. Non-Goals

Epic này **không** làm:

- Google OAuth / Calendar / Meet API integration
- Evidence QA / export linker sâu (epic khác)
- Payment / admin / quota billing UI
- DB cleanup / reset / volume wipe
- UI redesign lớn ngoài trạng thái recovery cần thiết
- Thay Deepgram hoặc Gemini provider
- Workspace / share / product expansion
- History performance debounce (đã có spec riêng `7t-analysis-resilience-history-performance-spec.md`)
- G3.5 Google integration roadmap

---

## 5. Architecture Decision

### 5.1 Chia 2 PR — lý do

| Lý do | Giải thích |
| --- | --- |
| Risk isolation | Stop tail là browser MediaRecorder ordering; analysis recovery là provider/Redis/Celery — failure modes khác nhau |
| Smoke clarity | PR1 smoke chỉ cần mic/tab/mic+tab tail matrix; PR2 smoke cần Gemini fault injection |
| Rollback độc lập | PR1 rollback web; PR2 rollback ai-api/celery mà không đụng stop lifecycle |
| Review surface | PR1 chủ yếu FE + WS finalize logs; PR2 chủ yếu ai-api schema/status |

### 5.2 Shared principles

- **STT success ≠ analysis success** — meeting `completed` khi transcript terminal hợp lệ hoặc taxonomy no-transcript/failed-audio; analysis failure retryable không đổi meeting status thành `failed`.
- **Idempotent finalize** — giữ `FINALIZED_ATTR` / duplicate `stream.stop` ignore (PR #95).
- **No secrets in logs** — chỉ log `keyAlias`, `traceId`, `meetingId`, `sessionId`, `attempt`.
- **Gateway-only FE** — FE không gọi ai-api trực tiếp cho analysis.

---

## 6. PR 1 — F9-R5 Stop Tail Preservation

### 6.1 Target Flow

```
User bấm Stop
  → UI: "Đang hoàn tất ghi âm..." (lifecycle: stopping → finalizing_recording)
  → FE: MediaRecorder.requestData() nếu state === 'recording' | 'paused'
  → FE: MediaRecorder.stop()
  → FE: chờ final dataavailable (Promise, timeout 500ms) HOẶC stop event (timeout 800ms)
  → FE: enqueue/send chunk cuối qua sendAudioChunk (nếu size > 0)
  → FE: chờ pending chunk dispatches (existing AudioRecorderButton logic)
  → FE: build fullAudio Blob (giữ audioChunks — KHÔNG clear sớm)
  → FE: flushPendingMessages(true) + waitForBufferedAmountToDrain(1500ms)
  → FE: websocket.send stream.stop (existing stopStream)
  → FE: chờ stream.status terminal hoặc hydration ready
  → BE: finalizeSttSession idempotent + drain seq
  → Nếu transcript rows = 0 và fullAudio đủ lớn: final-audio-fallback (existing path)
  → Cleanup tracks/mixer/recorder SAU terminal status
```

### 6.2 FE requirements

#### 6.2.1 `useAudioRecorder.ts`

Thêm `stopRecordingGraceful(): Promise<{ fullBlob: Blob; sessionId: number }>`:

1. Nếu recorder inactive → resolve với blob từ `audioChunks` hiện có.
2. Nếu `recording` hoặc `paused`:
   - Log `MEDIARECORDER_REQUEST_DATA`.
   - Gọi `recorder.requestData()` trong try/catch (ignore nếu unsupported).
   - Đăng ký one-shot listener chờ `dataavailable` với `size > 0` hoặc timeout 500ms (`MEDIARECORDER_FINAL_DATAAVAILABLE`).
   - Gọi `recorder.stop()`; chờ `onstop` với timeout 800ms (`MEDIARECORDER_STOP_EVENT`).
3. **Không** gọi `cleanupStream()` trong `onstop` — chuyển cleanup sang caller sau terminal.
4. `finishRecording` tách thành:
   - `markRecordingStopped(sessionId)` — set state `stopped`, stop timers only.
   - `cleanupRecordingResources(sessionId)` — cleanup stream/mixer/recorder handlers (gọi sau finalize path).
5. Không clear `audioChunks` / `rollingChunksRef` cho đến khi `handleLiveRecordingComplete` xác nhận terminal hoặc fallback xong.

Constants (MVP):

| Constant | Value |
| --- | --- |
| `FINAL_DATAAVAILABLE_TIMEOUT_MS` | 500 |
| `RECORDER_STOP_EVENT_TIMEOUT_MS` | 800 |
| `STOP_DRAIN_TIMEOUT_MS` | 1500 (giữ hiện tại) |

#### 6.2.2 `AudioRecorderButton.tsx`

- Stop click gọi `stopRecordingGraceful()` thay vì `stopRecording()`.
- Set parent lifecycle `stopping` **trước** graceful stop (callback prop `onStopRequested`).
- Disable button khi `stopping` | `finalizing_recording` | `finalizing_transcript`.
- Completion effect: sau graceful stop + pending dispatches → `onRecordingComplete(fullBlob, sessionId)`.
- Log `REALTIME_FINAL_CHUNK_ENQUEUED` khi chunk tail được dispatch.

#### 6.2.3 `useRealtimeMeetingStream.ts`

- Giữ `stopStream()` ordering: flush → drain → `stream.stop`.
- Thêm log `REALTIME_FINALIZE_AFTER_CLIENT_DRAIN` trước send `stream.stop`.
- Không `disconnect()` / `clearPendingQueue` trước khi `stream.stop` sent thành công, trừ disconnect fallback đã có.
- `userStopRequestedRef` drop late chunks — giữ behavior PR #95.

#### 6.2.4 `App.tsx`

- `handleLiveRecordingComplete` sequence:
  1. `REALTIME_STOP_REQUESTED`
  2. `setLiveLifecycleState('stopping')`
  3. `await stopStream()` (sau blob ready + tail chunk sent)
  4. `setLiveLifecycleState('finalizing_transcript')`
  5. hydrate + fallback như hiện tại
  6. `cleanupRecordingResources()` cuối cùng
- `onTabAudioTrackEnded`: route qua cùng graceful stop path (không gọi `stopRecording()` trực tiếp).
- Tab stop sharing message giữ `RECORDING_SOURCE_ERRORS.tabStopSharing`.

#### 6.2.5 Recording sources

Áp dụng **cùng flow** cho:

| Source | Notes |
| --- | --- |
| `microphone` | Baseline |
| `browser_tab` | Tab track ended → graceful stop |
| `browser_tab_with_mic` | Mixer cleanup deferred; tab ended triggers full graceful stop |

#### 6.2.6 Debug events (DEV / `AUDIO_DEBUG_ENABLED`)

| Event | When |
| --- | --- |
| `REALTIME_STOP_REQUESTED` | User stop or tab track ended |
| `MEDIARECORDER_REQUEST_DATA` | Before stop |
| `MEDIARECORDER_FINAL_DATAAVAILABLE` | Final chunk received or timeout |
| `MEDIARECORDER_STOP_EVENT` | onstop fired or timeout |
| `REALTIME_FINAL_CHUNK_ENQUEUED` | Tail chunk sent to WS queue |
| `REALTIME_FINALIZE_AFTER_CLIENT_DRAIN` | Before stream.stop send |
| `FINAL_AUDIO_BLOB_READY` | fullBlob assembled, size logged |

Không log: raw audio bytes, JWT, API keys, full WS URLs with tokens.

### 6.3 Backend / processing requirements

#### 6.3.1 `MeetingWebSocketHandler`

- Giữ idempotent `FINALIZED_ATTR` — log `REALTIME_STOP_DUPLICATE_IGNORED`.
- Trên `stream.stop`, log structured:

```
event=REALTIME_STOP_FINALIZE_AFTER_DRAIN
  meetingId={}
  sessionId={}
  lastClientSeq={}
  lastSentSeq={}
  drainedSeq={}
  finalizeSeq={}
```

- `finalizeSttSession`: sau synthetic final chunk, log:

```
event=REALTIME_FINALIZE_COMPLETE
  meetingId={}
  sessionId={}
  finalizeSeq={}
  transcriptRows={}
  finalAudioBytes={}   # 0 for synthetic; nonzero if recovery path
```

- Double `stream.stop` / `afterConnectionClosed` không duplicate analysis trigger (existing test `handleTextMessage_duplicateStreamStop_shouldNotTriggerRealtimeAnalysisTwice`).
- `transcriptRows = 0` hoặc `FAILED_AUDIO_CAPTURE` → **không** gọi Gemini (existing `REALTIME_ANALYSIS_SKIPPED`).
- `transcriptRows > 0` và meaningful (PR2 gate ở ai-api; PR1 processing có thể pre-check length ≥ 80 chars để tránh trigger sớm — optional optimization, không bắt buộc PR1).

#### 6.3.2 Async audio queue

- Khi `REALTIME_ASYNC_AUDIO_QUEUE_ENABLED=true`: `shutdownRealtimeWorkerForStop` phải drain FIFO đến `lastClientSeq` trước finalize (giữ PR #95 behavior).
- Queue full trong happy path = FAIL smoke (không silent drop).

### 6.4 Acceptance criteria

| ID | Case | Input | Expected | Log expected |
| --- | --- | --- | --- | --- |
| R1-T1 | Mic tail | Nói câu cuối, Stop ngay (< 1s) | Không mất cuối câu **5/5** | `MEDIARECORDER_REQUEST_DATA`, `REALTIME_FINAL_CHUNK_ENQUEUED` |
| R1-T2 | Tab tail | Google Meet tab, Stop ngay cuối câu | Không mất tail **5/5** | Same + tab telemetry |
| R1-T3 | Tab+mic tail | `browser_tab_with_mic`, Stop ngay cuối | Không mất tail **5/5** | Mixer cleanup after terminal |
| R1-T4 | Stop sharing | Stop sharing tab giữa chừng | Controlled graceful stop, no crash | `TRACK_ENDED`, `REALTIME_STOP_REQUESTED` |
| R1-T5 | Double Stop | Double-click Stop | Finalize 1 lần | `STREAM_STOP_DUPLICATE_IGNORED` (FE), `REALTIME_STOP_DUPLICATE_IGNORED` (BE) |
| R1-T6 | Slow network | Throttle WS, Stop | Timeout/fallback, không kẹt processing | `STREAM_STOP_BUFFER_DRAIN_TIMEOUT` optional; meeting terminal trong 30s |
| R1-T7 | Tiny/no audio | Im lặng < 2s | `FAILED_AUDIO_CAPTURE`, no Gemini | `REALTIME_ANALYSIS_SKIPPED reason=failed_audio_capture` |
| R1-T8 | Full audio fallback | Stream thiếu transcript, blob ≥ min bytes | Fallback transcript rows > 0 | `REALTIME_FINAL_AUDIO_FALLBACK_SUCCEEDED` |

---

## 7. PR 2 — Gemini Analysis Recovery + Short Transcript Gate

### 7.1 Target Flow

```
STT/transcript terminal (rows > 0)
  → normalize transcript text (existing canonicalizer / FE normalizeText)
  → short transcript gate (shared evaluator)
  → if skip: persist ANALYSIS_SKIPPED_SHORT_TRANSCRIPT / NO_MEANINGFUL_TRANSCRIPT, meeting completed
  → if pass: begin_analysis_run
  → Gemini primary key (alias logged)
  → on 429/503/timeout: fallback next key (backup1, ...)
  → if all keys fail retryable: analysis_status = ANALYSIS_FAILED_RETRYABLE, meeting transcript completed
  → enqueue background retry (Redis + Celery beat)
  → FE: "AI đang bận, hệ thống sẽ thử lại" + nút re-analyze
  → retry success → COMPLETED
  → retry exhausted (4 background) → FE CTA thử lại thủ công, transcript vẫn hiển thị
```

### 7.2 Short transcript gate

**MVP decision (locked):** Không gọi Gemini nếu **bất kỳ** điều kiện sau đúng:

| # | Rule | Implementation |
| --- | --- | --- |
| G1 | `transcript_rows == 0` | Already skipped — giữ |
| G2 | Normalized chars `< 80` | Strip whitespace/punctuation per `normalizeText` |
| G3 | Word count `< 12` | Split on whitespace after normalize |
| G4 | Mostly filler/noise | ≥ 60% tokens ∈ filler set `{ừ, à, ờ, hmm, uh, um, ...}` (locale vi+en minimal set hardcoded MVP) |
| G5 | Duplicate micro-loop | Same normalized line repeated ≥ 4 lần (reuse pipeline collapse heuristic) |

**Shared module:** `demoRecordAUDIOMID/ai-service/app/services/transcript_quality_gate.py`

```python
@dataclass(frozen=True)
class TranscriptQualityVerdict:
    should_analyze: bool
    skip_reason: str | None  # NO_MEANINGFUL_TRANSCRIPT | ANALYSIS_SKIPPED_SHORT_TRANSCRIPT
    normalized_chars: int
    word_count: int
```

Processing-api gọi gate qua ai-api internal `POST /api/internal/transcript-quality/evaluate` **hoặc** duplicate lightweight Java evaluator với cùng constants (DECISION: **ai-api owns gate logic**; processing gọi evaluate trước `analyzeRealtimeTranscript` để tránh HTTP Gemini).

**Status mapping:**

| Layer | Status | errorCode |
| --- | --- | --- |
| ai-api analysis run | `NO_ANALYSIS` | `ANALYSIS_SKIPPED_SHORT_TRANSCRIPT` |
| processing Redis | `SKIPPED` | `NO_MEANINGFUL_TRANSCRIPT` |
| meeting job | `completed` | terminal realtime = `COMPLETED` (transcript exists but analysis skipped) |

**FE message (Vietnamese, locked):**

> Bản ghi quá ngắn hoặc chưa có đủ nội dung để phân tích. Bạn có thể ghi lại hoặc tải file khác.

### 7.3 Gemini retry classification

| Condition | errorCode | Retryable | ai-api run status | HTTP to processing |
| --- | --- | --- | --- | --- |
| 429 `RESOURCE_EXHAUSTED` | `GEMINI_RATE_LIMITED` | Yes | `RATE_LIMITED` → promote to `ANALYSIS_FAILED_RETRYABLE` in response | 429 |
| 503 / model overloaded | `GEMINI_UNAVAILABLE` | Yes | `ANALYSIS_FAILED_RETRYABLE` | 503 |
| Timeout / network | `GEMINI_UNAVAILABLE` | Yes | `ANALYSIS_FAILED_RETRYABLE` | 503 |
| All keys exhausted | `GEMINI_QUOTA_EXHAUSTED` | Yes (cooldown) | `ANALYSIS_FAILED_RETRYABLE` | 503 |
| Circuit open (Resilience4j) | `CIRCUIT_OPEN` | Yes | `ANALYSIS_FAILED_RETRYABLE` | 503 |
| 400 invalid request / schema bug | `GEMINI_ANALYSIS_FAILED` | **No** | `FAILED` | 502 |
| 401/403 config | `GEMINI_CONFIG_ERROR` | **No** | `FAILED` | 503 |
| Safety block (if detected) | `GEMINI_CONTENT_BLOCKED` | **No** (MVP) | `FAILED` | 422 |

**Fix required:** `analyze_realtime_transcript` phải `mark_analysis_run_failed(status=ANALYSIS_STATUS_FAILED_RETRYABLE)` cho retryable `AnalysisUnavailableError` / all-keys-exhausted, không dùng `ANALYSIS_STATUS_FAILED` chung.

### 7.4 Retry policy

**MVP (locked):**

| Phase | Behavior |
| --- | --- |
| Immediate | `GeminiClient` rotates keys in-process (existing max_attempts=3 per request) |
| Background | Celery beat task `analysis.retry_scheduled` mỗi 60s scan Redis retry queue |
| Backoff schedule | Attempt 1: 30s, 2: 2m, 3: 5m, 4: 15m after prior failure |
| Max background retries | 4 |
| Jitter | ±10% per delay |
| Stop conditions | Permanent error; transcript hash unchanged + permanent code; `mode=force` manual re-analyze resets count |
| No infinite retry | After 4 background failures → status `ANALYSIS_FAILED_RETRYABLE` với `retryExhausted=true` |

**Env flags:**

| Env | Default | Purpose |
| --- | --- | --- |
| `ANALYSIS_BACKGROUND_RETRY_ENABLED` | `true` | Kill-switch rollback PR2 |
| `ANALYSIS_BACKGROUND_RETRY_MAX_ATTEMPTS` | `4` | Cap |
| `ANALYSIS_SHORT_TRANSCRIPT_GATE_ENABLED` | `true` | Kill-switch gate |

**Redis keys (ai-api):**

- `analysis:retry:queue` — sorted set score = `next_retry_at` unix
- `analysis:state:{meetingId}` — existing + fields below

### 7.5 Data / status model

#### 7.5.1 Hiện trạng schema (audited)

**`meeting_analysis_runs` (Postgres)** — có: `status`, `provider`, `model`, `error_code`, `error_message`, `canonical_transcript_hash`, `idempotency_key`. **Chưa có:** `retry_count`, `next_retry_at`, `provider_alias`, `trace_id`, `analysis_input_hash`.

**Processing `JobStateStore` Redis** — có: `status`, `retryable`, `attemptCount`, `cooldownUntilMs`, `retryAfterSeconds`, `errorCode`, `transcriptHash`.

**ai-api Redis realtime analysis** — có: `cooldown_until`, `retry_after_seconds`, `error_code`.

#### 7.5.2 Migration (PR2 — Alembic)

Bảng `meeting_analysis_runs` thêm columns (nullable, backward-compatible):

| Column | Type | Purpose |
| --- | --- | --- |
| `analysis_retry_count` | INTEGER DEFAULT 0 | Background + manual attempts |
| `analysis_next_retry_at` | TIMESTAMP NULL | Next scheduled retry |
| `analysis_last_attempt_at` | TIMESTAMP NULL | Observability |
| `analysis_provider_alias` | VARCHAR(32) NULL | `primary`, `backup1` — logs only safe alias |
| `analysis_trace_id` | VARCHAR(64) NULL | Support CTA |
| `analysis_input_hash` | VARCHAR(64) NULL | Dedup / skip unchanged permanent fail |

Redis hash extensions (không cần migration): `analysis_provider_alias`, `analysis_trace_id`, `analysis_input_hash`, `retry_exhausted`, `next_retry_at`.

**API response extensions (`AnalysisResponse` / `getSavedAnalysis`):**

```json
{
  "analysisStatus": "ANALYSIS_FAILED_RETRYABLE",
  "retryable": true,
  "retryAfterSeconds": 120,
  "retryExhausted": false,
  "analysisRetryCount": 2,
  "analysisNextRetryAt": "2026-06-16T10:32:00Z",
  "errorCode": "GEMINI_UNAVAILABLE",
  "analysisTraceId": "rt-a1b2c3",
  "analysisProviderAlias": "backup1"
}
```

### 7.6 FE UX requirements

| State | Meeting transcript | Analysis panel | CTA |
| --- | --- | --- | --- |
| `ANALYSIS_FAILED_RETRYABLE` | Visible, labeled saved | Warning banner | "Thử phân tích lại" enabled when cooldown elapsed |
| All keys exhausted | Visible | "AI đang quá tải, hệ thống sẽ tự thử lại." | Re-analyze disabled until `retryAfterSeconds` |
| Short transcript skip | Visible (if any) or empty state | Info message (locked Vietnamese copy) | "Bắt đầu ghi âm" / upload CTA |
| Permanent fail | Visible | Error + `traceId` | Re-analyze enabled (user may fix transcript externally) |
| Analyzing | Visible | Spinner "Đang phân tích..." | Re-analyze disabled |

**Không** hiển thị meeting-level `failed` khi chỉ analysis retryable failed.

**Export guard (locked):** Khi `analysisStatus` ∈ `{ANALYZING, ANALYSIS_FAILED_RETRYABLE}` và `retryExhausted=false`:

- Action plan export hiển thị message hiện có "analysis-required" — **không** auto-trigger analysis.
- Không ghi dữ liệu analysis cũ/sai vào export nếu `stale=true` (giữ 7U export policy).

Files: `MeetingHistoryScene.tsx`, `FeatureAnalysis.tsx`, `RealtimeDashboardScene.tsx`, `AnalysisStatusPanel.tsx`.

### 7.7 Acceptance criteria

| ID | Case | Setup | Expected | Log |
| --- | --- | --- | --- | --- |
| R2-T1 | Primary 429, backup OK | Mock primary 429 | `COMPLETED`, alias `backup1` | `GEMINI_KEY_SELECTED alias=backup1` |
| R2-T2 | Both 429/503 | All keys 503 | `ANALYSIS_FAILED_RETRYABLE`, meeting completed + transcript | `GEMINI_ALL_KEYS_EXHAUSTED retryable=true` |
| R2-T3 | All keys exhausted | Cooldown all | Retryable, no crash | `REALTIME_ANALYSIS_FAILED_RETRYABLE` |
| R2-T4 | Background retry success | Fail then succeed on attempt 2 | `COMPLETED` after ≤ 2m | `ANALYSIS_BACKGROUND_RETRY_SUCCESS attempt=2` |
| R2-T5 | Retry exhausted | 4 failures | FE re-analyze CTA, `retryExhausted=true` | `ANALYSIS_BACKGROUND_RETRY_EXHAUSTED` |
| R2-T6 | Short 13 chars | Transcript "Xin chào bạn." | No Gemini call | `ANALYSIS_SKIPPED_SHORT_TRANSCRIPT` |
| R2-T7 | Zero rows | Empty DB transcript | No Gemini | `REALTIME_ANALYSIS_SKIPPED reason=no_transcript` |
| R2-T8 | Manual re-analyze | Click re-analyze after retryable | New run `mode=force`, resets attempt optional | `REALTIME_ANALYSIS_TRIGGERED source=rerun` |
| R2-T9 | Export pending | Export during retryable | No wrong report data | No `REALTIME_ANALYSIS_TRIGGERED` from export |

---

## 8. Observability / Logs

### 8.1 FE browser debug events

| Event | Fields |
| --- | --- |
| `REALTIME_STOP_REQUESTED` | `meetingId`, `sessionId`, `source` |
| `MEDIARECORDER_REQUEST_DATA` | `sessionId`, `recorderState` |
| `MEDIARECORDER_FINAL_DATAAVAILABLE` | `size`, `chunkSequence`, `timedOut` |
| `MEDIARECORDER_STOP_EVENT` | `sessionId`, `timedOut` |
| `REALTIME_FINAL_CHUNK_ENQUEUED` | `meetingId`, `seq`, `size` |
| `REALTIME_FINALIZE_AFTER_CLIENT_DRAIN` | `meetingId`, `lastSeq`, `bufferedAmount` |
| `FINAL_AUDIO_BLOB_READY` | `meetingId`, `bytes` |

### 8.2 Processing realtime stop/finalize

| Event | Fields |
| --- | --- |
| `REALTIME_STOP_FINALIZE_AFTER_DRAIN` | `meetingId`, `sessionId`, `lastClientSeq`, `drainedSeq` |
| `REALTIME_FINALIZE_COMPLETE` | `meetingId`, `finalizeSeq`, `transcriptRows`, `finalAudioBytes` |
| `REALTIME_STOP_DUPLICATE_IGNORED` | `meetingId`, `finalizedSeq` |
| `REALTIME_ANALYSIS_SKIPPED` | `meetingId`, `reason`, `source` |
| `REALTIME_ANALYSIS_FAILED_RETRYABLE` | `meetingId`, `errorCode`, `retryAfterSeconds`, `attempt` |

### 8.3 ai-api Gemini

| Event | Fields |
| --- | --- |
| `GEMINI_KEY_SELECTED` | `alias`, `attempt`, `meetingId`, `traceId` |
| `GEMINI_KEY_FAILED` | `alias`, `statusCode`, `errorCode`, `retryable` |
| `GEMINI_ALL_KEYS_EXHAUSTED` | `retryable`, `cooldownActive`, `meetingId` |
| `ANALYSIS_SKIPPED_SHORT_TRANSCRIPT` | `meetingId`, `normalizedChars`, `wordCount` |
| `ANALYSIS_BACKGROUND_RETRY_ENQUEUED` | `meetingId`, `attempt`, `nextRetryAt` |
| `ANALYSIS_BACKGROUND_RETRY_SUCCESS` | `meetingId`, `attempt`, `alias` |
| `ANALYSIS_BACKGROUND_RETRY_EXHAUSTED` | `meetingId`, `attemptCount` |

**Never log:** raw API key, `x-goog-api-key`, full prompts, transcript body in error paths, JWT.

---

## 9. Test Plan

Theo TDD vertical slices: mỗi slice 1 test behavior → implement → green trước khi slice tiếp.

### 9.1 Unit tests — FE

| Test file | Cases |
| --- | --- |
| `useAudioRecorder.test.ts` (new) | `requestData` before stop; final dataavailable wait; deferred cleanup |
| `AudioRecorderButton.test.tsx` | Tail chunk dispatch before complete; disabled when stopping |
| `useRealtimeMeetingStream.test.tsx` | stopStream ordering; duplicate stop; drain timeout |
| `App.test.tsx` | `handleLiveRecordingComplete` order; tab track ended graceful path |
| `AnalysisStatusPanel.test.tsx` | Retryable copy; cooldown disable; short transcript message |

### 9.2 Unit tests — backend

| Test file | Cases |
| --- | --- |
| `MeetingWebSocketHandlerTest.java` | Finalize logs; duplicate stop; no analysis on FAILED_AUDIO_CAPTURE |
| `test_transcript_quality_gate.py` (new) | Gate rules G1–G5 boundary (79 vs 80 chars, 11 vs 12 words) |
| `test_gemini_analyzer.py` | Key rotation; all keys exhausted → retryable |
| `test_realtime_analysis_endpoint.py` | Short transcript skip; ANALYSIS_FAILED_RETRYABLE status |
| `test_analysis_retry_task.py` (new) | Backoff schedule; max attempts; jitter bounds |
| `ProcessingServiceTest.java` | Retryable failure mapping; skip short transcript before ai call |

### 9.3 Integration tests

| Test | Scope |
| --- | --- |
| FE hook + mock WS | Stop tail: final seq reaches processing mock |
| processing → ai-api | Finalize → analysis trigger → 503 → retryable state in Redis |
| Celery retry task | Enqueue → beat tick → success path |

### 9.4 Manual smoke matrix

| Gate | Cases |
| --- | --- |
| PR1 local | R1-T1..R1-T8 |
| PR2 local | R2-T1..R2-T9 (Gemini fault via env mock keys) |
| Production smoke | 1 mic + 1 tab meeting each PR after deploy |
| Regression upload | 1 upload meeting end-to-end |
| Regression mic-only | Pre-#96 microphone flow |
| Regression tab/mic+tab | Google Meet demo paths |

### 9.5 Test matrix (condensed)

| ID | Layer | Input | Expected status | Key log |
| --- | --- | --- | --- | --- |
| R1-T1 | E2E | Mic fast stop | Transcript complete | `REALTIME_FINAL_CHUNK_ENQUEUED` |
| R2-T6 | API | 13 char transcript | `ANALYSIS_SKIPPED_SHORT_TRANSCRIPT` | `ANALYSIS_SKIPPED_SHORT_TRANSCRIPT` |
| R2-T2 | API | All 503 | `ANALYSIS_FAILED_RETRYABLE` | `GEMINI_ALL_KEYS_EXHAUSTED` |
| REG-U1 | E2E | Upload MP3 | `COMPLETED` + analysis | `ANALYSIS_CACHE_HIT` or `SAVED` |

---

## 10. Rollout Plan

### 10.1 PR1 deploy

| Service | Action |
| --- | --- |
| `web` (FE-Audiomind) | Build + deploy static bundle |
| `processing-api` | Deploy nếu có thêm finalize logs / drain metrics only |

**Pre-deploy:** `rtk git log -1` confirms PR1 commit.

**Post-deploy smoke:**

```bash
# Production log bundle (metadata only)
docker logs processing-api --since 10m 2>&1 | grep -E "REALTIME_STOP|REALTIME_FINALIZE|FINAL_AUDIO"
docker logs ai-api --since 10m 2>&1 | grep -E "REALTIME_ANALYSIS_SKIPPED"
```

Manual: 1 mic meeting fast-stop tail check.

### 10.2 PR2 deploy

| Service | Action |
| --- | --- |
| `ai-api` | Deploy gate + retry status fixes |
| `celery-worker` | Deploy retry task module |
| `celery-beat` | Add to compose if not present — single scheduler instance |
| `processing-api` | Deploy gate pre-check + response field extensions |

**DB migration:**

```bash
# Inside ai-api container
alembic upgrade head
```

**Backup before migration:**

```bash
pg_dump -Fc audiomind > backup-pre-7t-pr2-$(date +%Y%m%d).dump
```

Không reset DB. Không xóa volume.

### 10.3 Feature flag rollout

1. Deploy PR2 with `ANALYSIS_BACKGROUND_RETRY_ENABLED=true`, `ANALYSIS_SHORT_TRANSCRIPT_GATE_ENABLED=true`.
2. Monitor `ANALYSIS_BACKGROUND_RETRY_*` logs 30 phút.
3. Nếu retry storm: set `ANALYSIS_BACKGROUND_RETRY_ENABLED=false` (rollback logic §11).

---

## 11. Rollback Plan

| Failure | Rollback |
| --- | --- |
| PR1 tail regression | Redeploy `web` image commit trước PR1; processing-api rollback nếu đã deploy |
| PR2 gate false positive | `ANALYSIS_SHORT_TRANSCRIPT_GATE_ENABLED=false` + restart ai-api |
| PR2 retry storm | `ANALYSIS_BACKGROUND_RETRY_ENABLED=false` + restart celery-worker/beat |
| PR2 migration issue | `alembic downgrade -1` + restore từ backup dump |
| Severe PR2 | Rollback ai-api + celery images; processing-api prior tag |

Không xóa volume. Không `git push --force` main.

---

## 12. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Browser không emit final `dataavailable` | Medium | Tail loss | `requestData()` + timeout proceed; rely on timeslice last chunk + final audio fallback |
| Stop sharing tab trước Stop | Medium | Truncated audio | `onTrackEnded` → same graceful path; user message |
| Duplicate stop/finalize | Low | Duplicate analysis | `FINALIZED_ATTR` + FE `streamStopSentRef` |
| WebSocket closed before drain | Medium | Missing tail | Drain timeout + disconnect fallback (existing) + PR1 ordering fix |
| Gemini all keys 503 | High | No analysis | Retryable status + background queue + FE CTA |
| Retry storm / cost spike | Medium | Quota burn | Max 4 background, jitter, env kill-switch |
| Status mismatch FE/BE | Medium | Wrong UX | Shared `analysisStatus` enum tests + contract CI |
| Export when analysis pending | Low | Wrong report | Export guard — no auto-trigger; stale check |
| Short gate false negative | Low | Wasted Gemini | Conservative thresholds; monitor `ANALYSIS_SKIPPED_SHORT_TRANSCRIPT` rate |
| Celery beat single point | Low | Delayed retry | Accept MVP; multi-beat deferred |

---

## 13. Definition of Done

Epic **7T-Realtime-Reliability-Recovery** Done khi **tất cả**:

- [ ] Stop tail pass **5/5** mic, tab, tab+mic (R1-T1..R1-T3)
- [ ] No-audio → `FAILED_AUDIO_CAPTURE`, no Gemini (R1-T7)
- [ ] Short transcript → no Gemini, correct status + FE message (R2-T6, R2-T7)
- [ ] Gemini 429/503 → meeting **không** failed; `ANALYSIS_FAILED_RETRYABLE` (R2-T2, R2-T3)
- [ ] Backup key dùng alias, không log raw key (R2-T1)
- [ ] Background retry queue pass (R2-T4, R2-T5)
- [ ] Re-analyze UX pass (R2-T8)
- [ ] Upload flow no regression (REG-U1)
- [ ] Export không ghi dữ liệu sai khi analysis chưa hoàn tất (R2-T9)
- [ ] Logs đủ debug với `meetingId` + `traceId` — không cần SSH đọc thủ công quá nhiều
- [ ] Production smoke pass sau PR1 + PR2

---

## 14. Implementation Slices

| # | Slice | PR | Deliverable |
| --- | --- | --- | --- |
| 1 | FE `stopRecordingGraceful` + requestData wait | PR1 | `useAudioRecorder.ts` |
| 2 | FE deferred cleanup + lifecycle `finalizing_recording` | PR1 | `useAudioRecorder.ts`, `App.tsx` |
| 3 | FE queue drain / finalize ordering | PR1 | `AudioRecorderButton`, `useRealtimeMeetingStream` |
| 4 | Processing finalize idempotency + seq logs | PR1 | `MeetingWebSocketHandler.java` |
| 5 | Final audio fallback integration check | PR1 | `App.tsx` + tests |
| 6 | `transcript_quality_gate.py` + endpoint | PR2 | ai-api |
| 7 | Gemini retry classification fix (`ANALYSIS_FAILED_RETRYABLE`) | PR2 | `main.py`, `analysis_runs.py` |
| 8 | Redis retry queue + Celery beat task | PR2 | `tasks.py`, celery beat compose |
| 9 | Alembic migration analysis run columns | PR2 | `models.py` |
| 10 | FE retryable + short transcript UX | PR2 | `AnalysisStatusPanel`, scenes |
| 11 | Smoke / log bundle script update | PR2 | `docs/deploy/production-smoke-checklist.md` append |

---

## 15. File Impact Map

| File | Function / component | Current responsibility | Expected change (impl PR) | Test file |
| --- | --- | --- | --- | --- |
| `FE-Audiomind/src/hooks/useAudioRecorder.ts` | `stopRecording`, `finishRecording` | Immediate stop + cleanup | `stopRecordingGraceful`, deferred cleanup | `useAudioRecorder.test.ts` (new) |
| `FE-Audiomind/src/components/realtime/AudioRecorderButton.tsx` | `handleClick`, completion effect | Stop without requestData | Graceful stop orchestration | `AudioRecorderButton.test.tsx` |
| `FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts` | `stopStream` | WS drain + stream.stop | Log markers, ordering comments | `useRealtimeMeetingStream.test.tsx` |
| `FE-Audiomind/src/app/App.tsx` | `handleLiveRecordingComplete` | Stop after blob ready | Reorder: tail → drain → finalize; cleanup last | `App.test.tsx` |
| `FE-Audiomind/src/utils/audioSourceAcquisition.ts` | `acquireAudioSource` | Tab/mic sources | No logic change; tests for track ended | `audioSourceAcquisition.test.ts` |
| `FE-Audiomind/src/components/features/RealtimeDashboardScene.tsx` | lifecycle badge | Status display | `finalizing_recording` label | `RealtimeDashboardScene.test.tsx` |
| `FE-Audiomind/src/components/analysis/AnalysisStatusPanel.tsx` | re-analyze CTA | Retryable UX | Short transcript + exhausted copy | `AnalysisStatusPanel.test.tsx` |
| `FE-Audiomind/src/components/features/MeetingHistoryScene.tsx` | export + re-analyze | History detail | Short skip + retryable export guard | `MeetingHistoryScene.test.tsx` |
| `FE-Audiomind/src/components/features/FeatureAnalysis.tsx` | hydrate analysis | Analysis page | Retryable banner polish | `FeatureAnalysis.test.tsx` |
| `FE-Audiomind/src/services/api.ts` | API types | Response parsing | New metadata fields | `api.test.ts` |
| `processing-service/.../MeetingWebSocketHandler.java` | `finalizeSttSession` | Terminal finalize | Structured seq logs | `MeetingWebSocketHandlerTest.java` |
| `processing-service/.../ProcessingService.java` | `runLazyRealtimeAnalysis` | Trigger analysis | Pre-gate call; propagate new fields | `ProcessingServiceTest.java` |
| `processing-service/.../JobStateStore.java` | `markAnalysisFailed` | Redis state | `retryExhausted`, `nextRetryAt` fields | `ProcessingServiceTest.java` |
| `processing-service/.../AnalysisFailureMapping.java` | error mapping | Retryable codes | Add `GEMINI_CONTENT_BLOCKED` permanent | existing tests |
| `ai-service/app/services/transcript_quality_gate.py` | (new) | — | Short transcript evaluator | `test_transcript_quality_gate.py` |
| `ai-service/app/main.py` | `analyze_realtime_transcript` | Analysis endpoint | Gate + retryable status fix | `test_realtime_analysis_endpoint.py` |
| `ai-service/app/services/gemini_client.py` | `post_json` | Key rotation | Emit `GEMINI_KEY_FAILED` | `test_gemini_analyzer.py` |
| `ai-service/app/services/analysis_runs.py` | `mark_analysis_run_failed` | DB status | Retryable status + new columns | `test_analysis_runs.py` |
| `ai-service/app/models.py` | `MeetingAnalysisRun` | Schema | Migration columns | alembic test |
| `ai-service/app/tasks.py` | Celery tasks | Batch processing | `analysis.retry_scheduled` task | `test_analysis_retry_task.py` |
| `ai-service/app/services/stt_session_actor.py` | `finalize` | STT drain | Verify no change PR1 | `test_stt_session_actor.py` |
| `infra/docker-compose.mvp.yml` | celery-beat | Worker only | Add beat service + env flags | manual compose check |

---

## Appendix A — Spec validation checklist

| Question | Answer in this spec |
| --- | --- |
| Làm sao chắc không mất âm cuối? | §6.1 `requestData()` → wait final `dataavailable` → send tail chunk → WS drain → `stream.stop` → §6.4 R1-T1..T3 |
| Làm sao biết final chunk đã gửi xong? | `REALTIME_FINAL_CHUNK_ENQUEUED` + `STREAM_STOP_AFTER_FLUSH` + `lastSeq`/`drainedSeq` logs §6.3.1, §8 |
| Gemini backup key fail thì sao? | Rotate aliases §7.3; all exhausted → retryable + background retry §7.4 |
| Gemini 503/429 thì meeting status gì? | Meeting `completed` + transcript; analysis `ANALYSIS_FAILED_RETRYABLE` §7.1, §5.2 |
| Transcript quá ngắn thì status gì? | `ANALYSIS_SKIPPED_SHORT_TRANSCRIPT` / `NO_MEANINGFUL_TRANSCRIPT` §7.2 |
| User thấy gì trên UI? | §7.6 table |
| Retry mấy lần, delay bao lâu? | 4 background: 30s, 2m, 5m, 15m §7.4 |
| Test nào chứng minh done? | §9.4, §13 |
| Deploy service nào? | §10.1 PR1 web+processing; §10.2 PR2 ai-api+celery+processing |
| Rollback ra sao? | §11 |

---

## Appendix B — Diagnose / TDD notes

- **Diagnose skill** (`~/.agents/skills/diagnose/SKILL.md`): file không có trên máy dev; áp dụng systematic root-cause từ symptom → code path → user impact (§3, Appendix A).
- **TDD skill:** tests theo vertical slices §14; integration-style qua public APIs (`stopRecordingGraceful`, `analyze_realtime_transcript`, `GET analysis/saved`); không test implementation MediaRecorder internals.
