# 7T Analysis Resilience + History Performance Spec

## 1. Executive Summary

Audiomind realtime meeting **35** đã PASS STT core nhưng **WARN/FAIL** ở bước analysis auto, với marker metadata `AI_SERVICE_CALL_FAILED operation=analyzeRealtimeTranscript errorCode=ServiceUnavailable` và `CallNotPermittedException` (Resilience4j circuit breaker mở). Đồng thời FE có hai vấn đề UX/perf: trang **Kết quả phân tích / Phân tích AI** dễ bị kẹt scroll khi nội dung dài, và trang **History** gọi backend quá nhiều do auto-select + filter không debounce + detail fetch không cache/cancel.

**MVP must-have (phase này):**

1. **STT realtime pass là success độc lập** — analysis fail không kéo meeting/recording lifecycle thành `failed`.
2. **Status enum chuẩn hóa** — server `ANALYSIS_FAILED_RETRYABLE`; FE map `analysis_failed_retryable`; backward-compatible với `FAILED` + `retryable` flag.
3. **Retry owner locked** — Resilience4j CircuitBreaker + Retry ở processing-service; **remove** Spring `@Retryable` trên `analyzeRealtimeTranscript`.
4. **FE transcript saved + retry CTA**; stop infinite/lazy re-trigger khi cooldown/retryable fail.
5. **Analysis page scroll fix** — flex `min-height: 0`, right panel scroll.
6. **History perf** — debounce/cancel/cache/lazy detail; no default auto-select.

**Deferred khỏi MVP must-have:**

- Server auto-retry scheduler 30/60/120 (Slice B2, feature-flagged, single-node only).
- Backend pagination/projection (Slice E).
- Durable distributed retry queue.
- Advanced dashboard metrics.

**Implementation order (small slices):** D1 → D2 → C → A1 → A2/B → B2 (optional) → E (if measured).

**Trạng thái:** SPEC-ONLY v2 — implementation-ready, không thay đổi runtime code trong task spec.

---

## 2. Current Evidence

### 2.1 Realtime STT baseline

| Item | Evidence |
| ---- | -------- |
| Branch | `docs/7t-qa-f6-start-resume-preroll-mic-sensitivity-spec` |
| Baseline commits | `74c991d` (realtime STT final hardening), `a95985c` (batch glossary) |
| Realtime 35 STT | PASS — transcript finalize + hydration hoạt động |
| Stop/finalize path | `MeetingWebSocketHandler` → `finalizeSttSession` → synthetic final chunk → transcript persistence |
| FE stop path | `App.tsx` `handleLiveRecordingComplete` → hydration → `setLiveLifecycleState('stopped')` → `startRealtimeAnalysisPolling` |

### 2.2 Upload batch baseline

| Item | Evidence |
| ---- | -------- |
| Meetings 32/33/34 | PASS sau fix glossary normalization (`a95985c`) |
| Known deferred | Duplicate failed upload reuse (meeting 29) — **out of scope** |

### 2.3 Realtime analysis failure evidence

| Field | Value |
| ----- | ----- |
| meetingId | 35 (realtime smoke) |
| Marker 1 | `AI_SERVICE_CALL_FAILED operation=analyzeRealtimeTranscript errorCode=ServiceUnavailable` |
| Marker 2 | `AI_SERVICE_CALL_FAILED ... errorCode=CallNotPermittedException` |
| Trigger log | `REALTIME_ANALYSIS_TRIGGER_ATTEMPT`, `REALTIME_ANALYSIS_ENQUEUED` |
| Missing success | Không có `REALTIME_ANALYSIS_SAVED` cho meeting 35 |
| Endpoint | `POST /api/internal/realtime-analysis` (processing → ai-service) |
| Client | `AIServiceClient.analyzeRealtimeTranscript` — `@CircuitBreaker` + `@Retry` + `@Retryable` **chồng nhau** |
| Fallback log | `source=analysis_fallback` khi FE poll `getAnalysis` |

### 2.4 History/API performance symptoms

| Symptom | Observation |
| ------- | ----------- |
| Page open burst | `listMeetingsWithParams` + auto-select `items[0]` → `Promise.all([getMeetingDetail, getTranscript, getSavedAnalysis])` = **4 calls** |
| Search không debounce | `searchQuery` trong `useEffect` deps — mỗi keystroke reload list |
| No AbortController/cache | `cancelled` boolean only; no TTL cache |
| No pagination | `GET /meetings` full list |

### 2.5 Analysis page scroll/layout symptoms

| Symptom | CSS / component |
| ------- | ---------------- |
| Viewport lock | `.app--dashboard { height: 100vh; overflow: hidden }` |
| Fixed analysis viewport | `.analysis-main-content { height: calc(100vh - 64px - 65px); overflow: hidden }` |
| Right panel trap | `.analysis-right-panel` thiếu `overflow-y: auto` |
| Forced min-height | `.feature-analysis-scene { min-height: 1204px }` |
| Nested transcript scroll | `TranscriptDisplay maxHeight="520px"` trong panel đã scroll |

---

## 3. Root Cause Analysis

### 3.1 Realtime analysis auto fail / circuit breaker

Transcript persist (STT finalize) hoàn tất **trước** `runRealtimeAnalysis` async. Circuit breaker `ai-service` mở sau failure burst → `CallNotPermittedException`. `mapFailureCode` gom thành `GEMINI_ANALYSIS_FAILED`. FE poll `getAnalysis` có thể lazy-trigger thêm call khi circuit còn mở. Triple retry (Resilience4j + Spring `@Retryable` + Gemini internal) làm trầm trọng.

### 3.2 Analysis page scroll

`.analysis-main-content` lock viewport; right panel không scroll → clip nội dung dài. Nested `maxHeight` transcript gây wheel trap.

### 3.3 History excessive backend calls

Auto-select row đầu + search không debounce + không cancel/cache → burst API không cần thiết.

---

## 4. MVP Scope

### 4.1 Must-have (ship trong phase 7T này)

| # | Deliverable | Slice |
| - | ----------- | ----- |
| 1 | History debounce 300ms + AbortController + stale response guard | D1 |
| 2 | History no auto-select + sessionStorage restore + lazy detail + cache TTL 5m | D2 |
| 3 | Analysis page scroll (left/right panel, sticky header/tabs) | C |
| 4 | Distinct `errorCode`: `CIRCUIT_OPEN`, `GEMINI_UNAVAILABLE` | A1 |
| 5 | Server status `ANALYSIS_FAILED_RETRYABLE` + `retryable` flag (additive) | A1 |
| 6 | FE: transcript saved message + retry/re-analyze CTA | A1 |
| 7 | Stop FE infinite poll + block lazy re-trigger during cooldown/retryable fail | A1 |
| 8 | Remove Spring `@Retryable` from `analyzeRealtimeTranscript`; keep Resilience4j owner | A2 |
| 9 | Circuit breaker observability markers | A2 |

### 4.2 Optional / deferred (không block MVP demo)

| # | Deliverable | Slice | Gate |
| - | ----------- | ----- | ---- |
| 1 | Bounded server auto-retry 30/60/120 | B2 | Feature flag `REALTIME_ANALYSIS_AUTO_RETRY_ENABLED=false` default **off** in MVP |
| 2 | Backend list pagination/projection | E | Chỉ khi đo >50 meetings hoặc p95 list >200ms |
| 3 | Durable distributed retry queue (Redis delayed queue multi-instance) | — | Post-demo |
| 4 | Grafana/dashboard metrics | — | Post-demo |
| 5 | Transcript lazy load on History tab click only | — | Post-MVP perf win |
| 6 | `liveLifecycleState='analysis_failed'` badge | — | Chỉ dùng `liveAnalysisStatus`; defer lifecycle enum |

### 4.3 Terminology & status enum convention

**Rule:** Server/API wire values = **UPPERCASE_SNAKE**. FE normalized display state = **lowercase snake** (khớp `liveAnalysisStatus` pattern hiện tại). FE vẫn accept uppercase từ API qua `normalizeAnalysisResponse`.

#### Server enum (`analysisStatus` / JobStateStore / ai-service `meeting_analysis_runs`)

| Value | Meaning | `retryable` |
| ----- | ------- | ----------- |
| `ANALYSIS_PENDING` | Transcript saved; analysis chưa start | `false` |
| `ANALYZING` | In flight | `false` |
| `COMPLETED` | Success | `false` |
| `ANALYSIS_FAILED_RETRYABLE` | Failed; user/manual retry allowed | `true` |
| `FAILED` | Non-retryable terminal | `false` |
| `RATE_LIMITED` | Provider rate limit | `true` |
| `QUOTA_BLOCKED` | Quota exhausted | `true` |
| `NO_ANALYSIS` | Chưa có analysis | `false` |

#### FE normalized state map

| Server `analysisStatus` | FE `liveAnalysisStatus` | FE `detail.analysisState` |
| ----------------------- | ----------------------- | ------------------------- |
| `ANALYSIS_PENDING` | `pending` | `processing` |
| `ANALYZING` | `polling` | `processing` |
| `COMPLETED` | `completed` | `completed` |
| `ANALYSIS_FAILED_RETRYABLE` | `failed` (or new `retryable` if type extended) | `failed` |
| `FAILED` | `failed` | `failed` |
| `RATE_LIMITED` / `QUOTA_BLOCKED` | `failed` | `failed` |
| `NO_ANALYSIS` | `pending` | `missing` |

**Wire example:**

```txt
Server response: analysisStatus=ANALYSIS_FAILED_RETRYABLE, retryable=true, errorCode=CIRCUIT_OPEN
FE after normalize: analysis_failed_retryable (display), liveAnalysisStatus=failed, shows retry CTA
```

#### Backward compatibility (additive only)

- **Giữ** `FAILED` — clients cũ vẫn parse được.
- **Thêm** `ANALYSIS_FAILED_RETRYABLE` — clients mới dùng `retryable=true` + distinct `errorCode`.
- **Không đổi** shape `GET /processing/{id}/analysis` top-level; chỉ thêm optional fields: `retryable`, `errorCode`, `retryAfterSeconds`, `attemptCount`, `transcriptSaved`.
- Clients cũ coi `FAILED` như trước; clients mới check `retryable` trước khi treat as terminal.
- `isFailedAnalysisStatus()` mở rộng: treat `ANALYSIS_FAILED_RETRYABLE` as failed-but-retryable (stop poll, show CTA) — **không** treat như `liveLifecycleState=error`.
- **Không** rename/remove `COMPLETED`, `ANALYZING`, `NO_ANALYSIS`.

#### errorCode enum (additive)

| `errorCode` | Source |
| ----------- | ------ |
| `CIRCUIT_OPEN` | `CallNotPermittedException` |
| `GEMINI_UNAVAILABLE` | HTTP 503 / provider down |
| `GEMINI_ANALYSIS_FAILED` | HTTP 502 / parse errors |
| `EMPTY_TRANSCRIPT` | HTTP 422 |
| `AI_SERVICE_UNAVAILABLE` | Other downstream HTTP |

---

## 5. Non-Goals & Do Not Touch

### 5.1 Non-goals

- G3.5 / Google OAuth/API runtime
- Duplicate failed upload reuse (meeting 29)
- DB migration lớn
- AudioWorklet / STT pipeline
- Gemini model/prompt rewrite (F8)
- Full UI refactor

### 5.2 Do not touch (hard guard for implementers)

| Area | Commit / scope | Reason |
| ---- | -------------- | ------ |
| G1 realtime STT core | `74c991d` baseline | Đã PASS smoke; không đổi finalize/actor path |
| Batch upload glossary | `a95985c` baseline | Đã PASS 32/33/34 |
| Duplicate failed upload reuse | deferred | Out of phase scope |
| Google / G3.5 integration | — | Explicit non-goal |
| `MeetingWebSocketHandler` STT finalize logic | — | Chỉ đụng analysis trigger/error mapping, không đổi STT |
| Toàn bộ dashboard navigation shell | — | Chỉ `MeetingHistoryScene`, `FeatureAnalysis`, analysis status components |

---

## 6. Proposed Design

### 6.1 Retry owner (LOCKED decision)

**Active layers (MVP):**

| Layer | Location | Config | Responsibility |
| ----- | -------- | ------ | -------------- |
| Resilience4j `@CircuitBreaker` | `AIServiceClient.analyzeRealtimeTranscript` | `failure-rate-threshold: 25%`, `wait-duration-in-open-state: 10s`, window 10 | Protect ai-service/Gemini; emit `CallNotPermittedException` when open |
| Resilience4j `@Retry` | Same method | `max-attempts: 4`, `wait-duration: 2s`, exponential ×2 | **Sole outer retry owner** for transient HTTP failures |
| Gemini internal retry | `ai-service/app/services/ai_analyzer.py` | `analysis_retry_max_attempts`, rate-limit backoff | Provider-level only; **không** thêm outer retry |

**Remove/disable (MVP Slice A2):**

| Layer | Action | Reason |
| ----- | ------ | ------ |
| Spring `@Retryable` on `analyzeRealtimeTranscript` | **Remove annotation** (method-level) | Chồng với Resilience4j → tối đa ~12 effective attempts; gây circuit open nhanh |
| Spring `@Retryable` on other `AIServiceClient` methods | **Defer** — chỉ remove trên `analyzeRealtimeTranscript` trong phase này | Minimize blast radius |

**Tests bắt buộc (retry dedupe):**

- `AIServiceClientTest`: mock 503 → verify Resilience4j retry count ≤4; verify **không** có Spring Retry interceptor invocation (spy/wiremock call count).
- `MeetingWebSocketHandlerTest`: single trigger → HTTP attempts bounded; circuit open → 0 HTTP calls.
- Regression: existing `analyzeRealtimeTranscript_shouldPostTranscriptPayloadToInternalEndpoint` still passes.

### 6.2 Realtime analysis resilience

**Principle:** Transcript persistence = primary transaction. Analysis = secondary async job.

**Server (processing-service) — Slice A1:**

1. Sau `finalizeSttSession` success: analysis state `ANALYSIS_PENDING`; **không** set meeting `status=failed`.
2. `mapFailureCode(CallNotPermittedException)` → `errorCode=CIRCUIT_OPEN`, `analysisStatus=ANALYSIS_FAILED_RETRYABLE`.
3. HTTP 503 → `GEMINI_UNAVAILABLE` + `ANALYSIS_FAILED_RETRYABLE`.
4. `JobStateStore.markAnalysisFailed` ghi `status=ANALYSIS_FAILED_RETRYABLE` khi retryable (thay vì generic `FAILED` only).
5. `ProcessingService.getAnalysis`: **không lazy-trigger** khi state là `ANALYSIS_FAILED_RETRYABLE` và cooldown active.

**Server (ai-service):**

- `/api/internal/realtime-analysis` failure → `mark_analysis_run_failed` (đã có) với `status=FAILED` + `errorCode` in run metadata.
- Không log transcript body / API keys.

### 6.3 Persistence model (LOCKED decision)

#### Câu hỏi → MVP answer

| Question | MVP decision |
| -------- | ------------ |
| Analysis status cần survive restart? | **Có cho History** — qua ai-service `meeting_analysis_runs` (Postgres). **Live session** dùng Redis JobStateStore TTL. |
| History refresh thấy `ANALYSIS_FAILED_RETRYABLE`? | **Có** — `getSavedAnalysis` / `getAnalysis` đọc run metadata; nếu last run `FAILED` + `retryable=true` + `errorCode` → show retry CTA. |
| Redis mất (restart processing)? | FE fallback: `getAnalysis` reads ai-service; nếu no run → `NO_ANALYSIS` + manual re-analyze. Không crash. |
| Cần DB migration mới? | **Không** — dùng existing `meeting_analysis_runs` + additive response fields. |

#### Two-tier storage

```txt
Tier 1 — Hot (live session, TTL ~ job state TTL):
  Redis JobStateStore: ANALYSIS_FAILED_RETRYABLE, errorCode, retryAfterSeconds, attemptCount, cooldown

Tier 2 — Durable (History / refresh):
  ai-service meeting_analysis_runs via mark_analysis_run_failed:
    status=FAILED, error_code, retryable flag in response assembly
  Completed analysis rows unchanged (COMPLETED)
```

#### Acceptance (persistence)

- [ ] Sau realtime analysis fail, refresh History page vẫn thấy failed/retryable state (từ saved analysis path).
- [ ] Redis flush không làm mất durable failed metadata nếu ai-service đã ghi run.
- [ ] Nếu cả Redis và DB run missing → `NO_ANALYSIS` / missing, không fake retryable.

### 6.4 Bounded server auto-retry (DEFERRED — Slice B2)

**Chỉ implement nếu manual retry không đủ sau A1/A2.** Constraints nếu bật:

| Constraint | Value |
| ---------- | ----- |
| Feature flag | `REALTIME_ANALYSIS_AUTO_RETRY_ENABLED` default **`false`** |
| Max attempts | 3 |
| Backoff | 30s, 60s, 120s |
| Skip when | circuit open, cooldown active, `attemptCount >= maxAttempts` |
| Transport | In-memory `ScheduledExecutorService` — **single-node demo only** |
| No infinite retry | Hard stop + log `REALTIME_ANALYSIS_RETRY_SKIPPED` |

MVP demo recovery = **manual re-analyze** (`handleLiveAnalysisRetry`, History `reanalyzeMeetingAnalysis`).

### 6.5 FE analysis status UX (Slice A1)

| State | Transcript UI | Analysis UI | `liveLifecycleState` |
| ----- | ------------- | ----------- | -------------------- |
| STT done, analysis pending | Segments visible | “Đang phân tích…” | `stopped` |
| STT done, retryable fail | Segments + “Transcript đã lưu” | Banner + **Phân tích lại** | `stopped` (**not** `error`) |
| STT done, completed | Segments | Full panel | `stopped` |

**Poll guard:** `pollRealtimeAnalysisAfterStop` stops when `analysisStatus === ANALYSIS_FAILED_RETRYABLE` or `retryable === true`; không loop `getAnalysis` lazy-trigger.

**Copy:**

- Retryable: `Transcript đã lưu. Phân tích AI tạm thời thất bại ({errorCode}). Thử lại sau {retryAfterSeconds}s.`

### 6.6 Analysis page scroll layout (Slice C only)

```css
.analysis-main-content {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.analysis-left-panel,
.analysis-right-panel {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.analysis-page-header { position: sticky; top: 0; z-index: 2; flex-shrink: 0; }
```

- Remove `.feature-analysis-scene { min-height: 1204px }`.
- Remove `maxHeight` on `TranscriptDisplay` in `FeatureAnalysis` when parent scrolls.
- Mobile ≤960px: stack columns; header sticky.

**Slice C scope limit:** Chỉ `FeatureAnalysis.tsx`, `dashboard.css`, `studio-theme.css` — **không** đổi `MeetingHistoryScene` transcript maxHeight trong slice C.

### 6.7 History UX (LOCKED decision)

| Rule | Behavior |
| ---- | -------- |
| Cold open | **Không** auto-select first row |
| sessionStorage restore | Key `audiomind.history.lastSelectedMeetingId` — restore **chỉ khi** id còn trong list sau load |
| Post-upload navigation | App truyền `focusMeetingId` prop → History select + load detail **chỉ meeting đó** |
| User click row | Load detail |
| No row selected | Empty detail placeholder; **0 detail API calls** |

#### Expected API calls

| Action | Calls |
| ------ | ----- |
| History cold open | **1** — `GET /meetings?...` only |
| sessionStorage restore (valid id) | 1 list + **2** detail (`getTranscript` + `getSavedAnalysis`) — skip `getMeetingDetail` if list row sufficient |
| User click row (cache miss) | **2** — `getTranscript` + `getSavedAnalysis` |
| User click row (cache hit, TTL 5m) | **0** network detail calls |
| User click row (cache stale soft) | **0–1** — optional `getSavedAnalysis` validation only if `analysisState` was `processing` |
| Manual re-analyze | `POST .../analysis/rerun` + poll `getSavedAnalysis` — **selected meeting only** |
| Stale selected polling | **0** — `pollSavedAnalysis` abort when `selectedMeetingId` changes |

#### Detail fetch composition (MVP)

```typescript
// Default detail load — NO getMeetingDetail
Promise.all([
  getTranscript(meetingId),
  getSavedAnalysis(meetingId),
])
// meeting metadata from list row cache
```

### 6.8 API call budget (performance acceptance)

| Scenario | Budget | Measurement |
| -------- | ------ | ----------- |
| History cold open | ≤ **1** API call | Network tab / mock call count |
| Search: type 10 chars fast | ≤ **2** list calls | Debounce 300ms |
| Click one meeting (cache miss) | ≤ **3** detail calls | transcript + saved analysis (+ optional detail) |
| Switch 5 meetings quickly | stale apply = **0** | UI không flash wrong meeting |
| Reopen same meeting within TTL | **0** detail calls (or ≤1 validation) | Cache hit |
| Realtime stop → analysis retryable fail | FE poll attempts bounded by existing max; **0** poll after terminal retryable | No infinite loop |
| List row render | **0** action-plan/report/export calls | On-demand only |

### 6.9 Request cancellation pattern (Slice D1)

```typescript
const detailAbortRef = useRef<AbortController | null>(null)
const detailRequestKeyRef = useRef<number | null>(null)

useEffect(() => {
  if (selectedMeetingId === null) return
  detailAbortRef.current?.abort()
  const controller = new AbortController()
  detailAbortRef.current = controller
  detailRequestKeyRef.current = selectedMeetingId
  // fetch with signal; before setState:
  // if (detailRequestKeyRef.current !== selectedMeetingId) return
}, [selectedMeetingId])
```

Search debounce: **300ms** (`useDebouncedValue` or equivalent).

### 6.10 API pagination (Slice E — deferred)

Chỉ khi profile >50 meetings. Additive `{ items, total, limit, offset, hasMore }`. FE `listMeetingsWithParams` backward-compatible wrapper.

---

## 7. Implementation Slices (commit-sized)

### Slice D1 — History debounce + AbortController + stale guard

**Files:** `MeetingHistoryScene.tsx`, `api.ts` (optional `signal` param), `MeetingHistoryScene.test.tsx`

- Debounce search 300ms.
- AbortController on detail fetch.
- Request key guard before `setState`.
- **Không** đổi auto-select yet.

### Slice D2 — History no auto-select + lazy detail + cache TTL

**Files:** `MeetingHistoryScene.tsx`, `App.tsx` (optional `focusMeetingId`), tests

- Remove `items[0]` auto-select.
- sessionStorage restore.
- `focusMeetingId` from upload/realtime navigation.
- In-memory cache TTL 5m; skip `getMeetingDetail`.
- Empty state when no selection.

### Slice C — Analysis page scroll only

**Files:** `FeatureAnalysis.tsx`, `dashboard.css`, `studio-theme.css`

- Flex scroll pattern; right panel `overflow-y: auto`.
- Remove min-height trap; mobile stack.
- FE test: long fixture scroll.

### Slice A1 — errorCode mapping + FE retryable status (no auto-retry)

**Files:** `MeetingWebSocketHandler.java`, `JobStateStore.java`, `ProcessingService.java`, `App.tsx`, `RealtimeDashboardScene.tsx`, `types/index.ts`, tests

- `ANALYSIS_FAILED_RETRYABLE` + `CIRCUIT_OPEN` / `GEMINI_UNAVAILABLE`.
- FE transcript saved + retry CTA.
- Stop poll + block lazy re-trigger on cooldown/retryable.
- **Không** thêm server auto-retry scheduler.

### Slice A2 — Retry owner cleanup + circuit breaker observability

**Files:** `AIServiceClient.java`, `AIServiceClientTest.java`, `application.yml` (optional tune)

- Remove `@Retryable` from `analyzeRealtimeTranscript` only.
- Log `CIRCUIT_BREAKER_STATE_CHANGE` if feasible via Resilience4j events.
- Verify bounded HTTP attempts in tests.

### Slice B2 — Bounded server auto-retry (OPTIONAL)

**Files:** `MeetingWebSocketHandler.java` or `ProcessingService.java`, `application.yml`

- Feature flag default **off**.
- In-memory scheduler only; single-node.
- Skip circuit open / max attempts.

### Slice E — Backend pagination (ONLY IF MEASURED)

**Files:** `MeetingController.java`, `MeetingService.java`, `api.ts`

- Paginated list; load-more.

---

## 8. API Contract Plan

### Analysis response (additive)

```json
{
  "meetingId": 35,
  "data": {
    "analysisStatus": "ANALYSIS_FAILED_RETRYABLE",
    "retryable": true,
    "errorCode": "CIRCUIT_OPEN",
    "retryAfterSeconds": 30,
    "attemptCount": 1,
    "maxAttempts": 3,
    "transcriptSaved": true
  }
}
```

**Legacy client:** `analysisStatus: "FAILED"` vẫn valid; thiếu `retryable` → treat as non-retryable unless `RATE_LIMITED`/`QUOTA_BLOCKED`.

---

## 9. Data/State Model Plan

### FE realtime

| Field | Type | Notes |
| ----- | ---- | ----- |
| `liveLifecycleState` | enum | STT only; stays `stopped` on analysis fail |
| `liveAnalysisStatus` | `idle\|polling\|completed\|pending\|failed` | lowercase |
| `liveAnalysisMetadata.analysisStatus` | uppercase from API | normalize in display |
| `liveAnalysisMetadata.retryable` | boolean | drives CTA |

### FE History cache

```typescript
type MeetingDetailCacheEntry = {
  meetingId: number
  meetingSummary: Meeting  // from list row
  transcriptSegments: TranscriptSegment[]
  analysis: AiAnalysis | null
  analysisMetadata: AiAnalysis | null
  fetchedAt: number  // TTL 5 min
}
```

### Server JobStateStore (additive fields)

```txt
status: ANALYSIS_PENDING | ANALYZING | COMPLETED | ANALYSIS_FAILED_RETRYABLE | FAILED
retryable: true|false
errorCode: string
retryAfterSeconds: int
attemptCount: int
```

---

## 10. Logging and Observability

| Event | Fields |
| ----- | ------ |
| `REALTIME_ANALYSIS_TRIGGER_ATTEMPT` | meetingId, source |
| `REALTIME_ANALYSIS_SAVED` | meetingId, source |
| `REALTIME_ANALYSIS_FAILED` | meetingId, source, errorCode, httpStatus? |
| `AI_SERVICE_CALL_FAILED` | meetingId, operation, errorCode |
| `ANALYSIS_STATUS_PERSISTED` | meetingId, analysisStatus, retryable, tier=redis\|db |
| `CIRCUIT_BREAKER_STATE_CHANGE` | name=ai-service, state |
| `REALTIME_ANALYSIS_RETRY_SKIPPED` | meetingId, reason (B2 only) |

---

## 11. Privacy/Security Constraints

- Metadata only in logs: meetingId, endpoint, errorCode, status, service, class, durationMs.
- No raw transcript, audio, tokens, API keys, provider response bodies.

---

## 12. Test Plan

### 12.1 Unit

- `mapFailureCode(CallNotPermittedException)` → `CIRCUIT_OPEN`.
- `markAnalysisFailed` → `ANALYSIS_FAILED_RETRYABLE` when retryable.
- `AIServiceClientTest`: no Spring `@Retryable` on `analyzeRealtimeTranscript`; Resilience4j attempts ≤4.

### 12.2 Integration

- WS handler: 503 → meeting status not `failed`; analysis `ANALYSIS_FAILED_RETRYABLE`.
- `getAnalysis` during cooldown: no lazy-trigger.
- Circuit open: zero HTTP to ai-service.

### 12.3 FE

- Realtime: transcript visible + retry CTA; lifecycle not `error`.
- Poll stops on `ANALYSIS_FAILED_RETRYABLE`.
- History cold open: 1 list call only.
- Click row: ≤3 detail calls.
- Selection switch: 0 stale apply.
- Search 10 chars: ≤2 list calls.
- Analysis page: right panel scrollTop changes.

### 12.4 Manual smoke

- Realtime 35 pattern: STT pass → analysis fail → manual re-analyze after circuit closes → COMPLETED.
- History: open → no detail until click/restore.

### 12.5 Performance (budget verification)

- Verify all rows in §6.8 API call budget table.

---

## 13. Acceptance Criteria

### Realtime analysis (must-have)

- [ ] STT pass không set meeting `status=failed` khi chỉ analysis fail.
- [ ] `errorCode` distinct: `CIRCUIT_OPEN`, `GEMINI_UNAVAILABLE`.
- [ ] Server emits `ANALYSIS_FAILED_RETRYABLE` + `retryable=true`.
- [ ] FE: “Transcript đã lưu” + retry CTA.
- [ ] No infinite FE poll; no lazy re-trigger during cooldown.
- [ ] Manual re-analyze works after circuit recovery.
- [ ] Spring `@Retryable` removed from `analyzeRealtimeTranscript`.

### Analysis scroll (must-have)

- [ ] Header/tabs visible; right panel scrolls long content.
- [ ] No wheel trap on desktop.

### History (must-have)

- [ ] Cold open ≤1 API call.
- [ ] No default auto-select first row.
- [ ] sessionStorage restore works when id in list.
- [ ] `focusMeetingId` loads only that meeting.
- [ ] Cache TTL 5m; debounce 300ms; abort stale requests.

### Deferred (not blocking MVP sign-off)

- [ ] Server auto-retry B2 (if flag enabled).
- [ ] Pagination Slice E.

---

## 14. Rollout Plan

| Step | Slice | Risk |
| ---- | ----- | ---- |
| 1 | D1 | Low |
| 2 | D2 | Low |
| 3 | C | Low |
| 4 | A1 | Medium |
| 5 | A2 | Medium |
| 6 | B2 | Medium — **off by default** |
| 7 | E | Low — measurement gated |

Rollback: revert slice commits independently; B2 flag off; manual re-analyze always available.

---

## 15. Remaining Open Questions (max 3)

1. **Transcript lazy load on History tab:** Defer post-MVP — acceptable to load transcript on selection for now (2-call detail budget). Revisit if transcript payload >500KB p95.
2. **Slice E threshold:** Defer measurement — trigger pagination when owner has >50 meetings OR list p95 >200ms in staging.
3. **Extend `liveAnalysisStatus` with `retryable` value:** Defer — MVP reuse `failed` + `retryable` metadata flag; avoid type churn unless UX needs distinct badge color.

---

## Appendix A — Code References

| Area | Path |
| ---- | ---- |
| WS analysis trigger | `MeetingWebSocketHandler.java` — `triggerRealtimeAnalysisAsync`, `runRealtimeAnalysis`, `mapFailureCode` |
| AI client (triple retry) | `AIServiceClient.java` — `analyzeRealtimeTranscript` L453-459 |
| Resilience4j | `application.yml` — `resilience4j.retry` + `circuitbreaker` |
| JobStateStore | `JobStateStore.java` — `markAnalysisFailed` (status `FAILED` today) |
| Durable runs | `ai-service/app/services/analysis_runs.py` — `mark_analysis_run_failed` |
| FE poll | `App.tsx` — `pollRealtimeAnalysisAfterStop`, `isFailedAnalysisStatus` |
| History | `MeetingHistoryScene.tsx` — list effect L370-412, detail L414-484 |
| Analysis UI/CSS | `FeatureAnalysis.tsx`, `dashboard.css` L380-401, L971-973 |

## Appendix B — Implementation Order (locked)

1. **D1** — debounce + AbortController + stale guard
2. **D2** — no auto-select + sessionStorage + cache + skip `getMeetingDetail`
3. **C** — analysis scroll only
4. **A1** — error mapping + FE retryable UX + poll guard (no server auto-retry)
5. **A2** — remove Spring `@Retryable` + circuit observability
6. **B2** — bounded auto-retry (optional, flag off)
7. **E** — pagination (if measured)

## Appendix C — Implementation Prompt Sequence

### `7T-history-perf-slice-d`

**Scope:** Slice D1 + D2 only. `MeetingHistoryScene.tsx`, `api.ts` signal support, `App.tsx` optional `focusMeetingId`, tests. Debounce 300ms; AbortController; remove auto-select; sessionStorage `audiomind.history.lastSelectedMeetingId`; cache TTL 5m; detail = `getTranscript` + `getSavedAnalysis` only. Verify API budget: cold open 1 call, click ≤2. **Do not touch** analysis resilience, scroll CSS, STT, batch upload.

### `7T-analysis-scroll-slice-c`

**Scope:** Slice C only. `FeatureAnalysis.tsx`, `dashboard.css`, `studio-theme.css`, focused FE test. Right panel scroll; remove `min-height: 1204px`; flex `min-height: 0`; sticky header/tabs; mobile stack. **Do not touch** History, backend, realtime analysis status.

### `7T-analysis-resilience-slice-a-b`

**Scope:** Slice A1 + A2 (+ B2 only if flag requested). `MeetingWebSocketHandler`, `JobStateStore`, `ProcessingService`, `AIServiceClient` (remove `@Retryable` on `analyzeRealtimeTranscript`), `App.tsx`, `RealtimeDashboardScene`, `types/index.ts`, Java + FE tests. Add `ANALYSIS_FAILED_RETRYABLE`, `CIRCUIT_OPEN`, `GEMINI_UNAVAILABLE`; FE transcript saved + retry CTA; stop poll/lazy re-trigger; persistence via Redis + `meeting_analysis_runs`. **Do not touch** G1 STT (`74c991d`), batch glossary (`a95985c`), History (assumes D done), scroll CSS.

---

*Spec version: 7T-analysis-resilience-history-performance-v2*
*Date: 2026-06-14*
*Status: SPEC-ONLY — implementation-ready*
