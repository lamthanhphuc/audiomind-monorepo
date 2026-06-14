# 7T Realtime Final Hardening Before Smoke Spec

Updated: 2026-06-14 (revision 2 — pre-coding tighten)

Spec-only phase. Do not implement runtime code, Docker smoke, browser smoke, commits, or Google/G3.5 work while updating this document.

## 1. Executive Summary

This phase hardens the Audiomind realtime STT path **after Fix #1–#3** and **before the final manual smoke**. The realtime critical path is already review-ready for baseline smoke, but several architectural and operational risks remain that can distort smoke results or cause post-finalize regressions.

Goals:

- Remove the last known realtime correctness risks (processing backpressure, env drift, UI/history mismatch, privacy leaks).
- Separate smoke evidence into independent gates: realtime STT core vs analysis vs history/export/search.
- Produce implementation slices small enough to land safely in a dirty multi-phase worktree.

This is **not** G3.5, not Google OAuth/API, not a provider migration, and not a full-app refactor.

**Recommended implementation order (revision 2):** B → D → A → C → E — guard/logging first, async hot path second, UI consistency third, evidence packaging last.

## 2. Current State

### Fix #1 — checkpoint / finalization / WS transcript delivery

- WS `transcript.partial` / `transcript.final` now appear during recording.
- `last_finalized_seq` advances beyond 0; checkpoint commit happens before actor shutdown.
- Processing sets `AUDIO_RECEIVED_ATTR` before AI HTTP returns for valid payload.

### Fix #2 — drain + hydration stability

- AI non-final recv drain: `1.0s → 0.1s`; final drain: `2.0s`.
- FE post-stop hydration uses stability signature: `id`, `mergeKey`, timing, `text`, `isFinal` — not fragment count alone.
- Meeting 24 evidence: DB `max_end ~25.88s`, checkpoint finalized seq `111`.

### Fix #3 / polish — stop lifecycle + stale guards

**FE (`useRealtimeMeetingStream`, `App.tsx`):**

- Async `stopStream()`: flush queue → bounded `bufferedAmount` drain (1500ms) → one-shot `stream.stop`.
- `streamStopSentRef` true only after successful send.
- Socket closed / send fail → `false`; duplicate stop true only if stop already sent.
- Late chunks dropped after user stop.
- App awaits `stopStream()`; on fail → disconnect fallback, wait 500ms, hydrate with partial state.

**Processing (`MeetingWebSocketHandler`):**

- Terminal meeting rejected at `auth.init` before `session.ready`.
- Stale/terminal metadata dropped before AI; rejected metadata clears `lastAudioSeq`.
- Missing `recording_session_id` / `attempt_id` after active session known → stale drop.
- `stream.stop` force revalidates meeting status; non-terminal cache TTL 30s.

**AI (`stt_session_actor`, `DeepgramSTTAdapter`, `config.py`):**

- No raw audio hex/header/transcript text in parsed logs.
- `DG_REQUEST_PARAMS` reports `sampleRateIncluded=false` for WebM/Opus.
- KeepAlive uses configured idle threshold.

### Review status entering this phase

- Realtime STT core: **PASS_REVIEW** for baseline smoke.
- User intent: **fix remaining risks first**, then run final smoke once.

## 3. Non-Goals

- No G3.5 work.
- No Google OAuth/API integration.
- No STT provider change (stay on Deepgram realtime).
- No Gemini provider migration.
- No full frontend redesign or unrelated history/export feature expansion.
- No commit/push in implementation passes unless explicitly requested later.
- No Docker/browser smoke during spec or initial implementation slices.
- No cleanup of unrelated dirty files unless a slice explicitly owns that surface and smoke depends on it.

## 4. Problem List / Risk Register

| ID | Risk | Severity | Affected module | Evidence / current behavior | Why it matters | Proposed direction | Must-fix before final smoke? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | Processing WS thread blocks on synchronous `aiServiceClient.streamAudioChunk()` | HIGH | `MeetingWebSocketHandler`, `AIServiceClient` | `handleBinaryMessage()` calls `streamAudioChunk()` inline on WS thread after guards; HTTP multipart to ai-api can take hundreds of ms–seconds | Under load or Deepgram latency, WS ingress stalls, transcript delivery bursts, client backpressure unclear, stop/finalize timing becomes nondeterministic | Introduce per-session in-memory FIFO worker queue behind `REALTIME_ASYNC_AUDIO_QUEUE_ENABLED=true` (default); WS thread validate+enqueue only | **Yes** |
| R2 | Env/config drift in local `infra/.env` | MEDIUM | `infra/.env`, `ai-service` startup, compose env mapping | `StartupConfigValidator` in Java only checks `JWT_SECRET`; ai-service logs STT config but does not fail on bad drain/debug overrides | Stale `STT_RECV_DRAIN_TIMEOUT_SECONDS=1.0` or `DEEPGRAM_DEBUG_RAW_MESSAGES=true` can silently regress realtime behavior | Slice B: startup validation + `scripts/check-realtime-config.ps1` | **Yes** |
| R3 | Dirty multi-phase diff (analysis v2, grouped action-plan, history/search/export) | MEDIUM | `ProcessingService`, `ai_analyzer.py`, `MeetingHistoryScene`, `api.ts` | Worktree contains large non-realtime changes | Final smoke narrative becomes ambiguous | Split smoke gates G1–G5; defer non-G1 unless required | **No** for STT core |
| R4 | UI/History transcript consistency after stop | MEDIUM | `App.tsx`, `MeetingHistoryScene`, `transcript.ts` | Hydration improved but live vs persisted merge still has edge cases | User sees different transcript on live screen vs History after stop | Slice C equivalence signature harness | **Yes** for transcript gate |
| R5 | Logging/privacy residual leaks | MEDIUM | `stt_adapter.py`, `AIServiceClient`, FE console | `DG CONNECT url=` logs full WS URL; `debug_raw_messages` can log capped provider preview | Smoke/debug logs may leak user speech content | Slice D scan + regression tests | **Yes** |
| R6 | Final smoke evidence collection not standardized | LOW | ops scripts | No single script for 2–3 meeting consecutive smoke | Hard to compare meetings | Slice E evidence script (metadata only) | **Yes** before declaring pass |
| R7 | Double finalization race (`stream.stop` + `afterConnectionClosed`) | HIGH | `MeetingWebSocketHandler` | Both paths can call `finalizeSttSession()`; `FINALIZED_ATTR` helps but async worker adds new race surface | Duplicate AI finalize, Conflict/replay, corrupt checkpoint | Atomic per-session state machine; only FINALIZING winner calls finalize | **Yes** (Slice A) |
| R8 | Queue full treated as normal backpressure | HIGH | Slice A worker | Prior draft suggested silent drop-newest | Silent audio loss → transcript gaps; false smoke pass | Queue full = **fail/degraded**; emit `stream.error` or close session; smoke **FAIL** if event appears in happy path | **Yes** (Slice A) |

## 5. Target Architecture

### 5.1 Processing Async Audio Queue

**Problem:** Today WS ingress and AI forwarding are coupled in `handleBinaryMessage()`.

**Feature flag (DECIDED):**

| Env / property | Value | Notes |
| --- | --- | --- |
| `REALTIME_ASYNC_AUDIO_QUEUE_ENABLED` | `true` default in dev/MVP compose | Final smoke must exercise async path |
| Rollback | set `REALTIME_ASYNC_AUDIO_QUEUE_ENABLED=false` | Reverts to legacy inline `streamAudioChunk()` on WS thread |
| Compose mapping | `processing-api` environment in `infra/docker-compose.mvp.yml` | Add explicit env interpolation |

**Legacy fallback (REQUIRED):**

- When flag `false`: preserve current synchronous inline path unchanged.
- When flag `true`: WS thread enqueue-only path.
- Tests must cover **both** paths.
- Rollback plan: flip env + `docker compose up -d --force-recreate processing-api` — no code revert required.

**Target flow (async enabled):**

```
FE WS  →  Processing WS thread (fast path)
            ├─ auth / terminal / stale guards (existing)
            ├─ metadata+binary pairing (existing)
            ├─ enqueue RealtimeAudioWorkItem (if queue not full)
            └─ return immediately

Per-session worker (1 per WS session)
            ├─ FIFO drain by seq
            ├─ call AIServiceClient.streamAudioChunk()
            ├─ clear audioBytes reference after AI call returns
            ├─ broadcast transcript events in receive order
            └─ on stream.stop: STOPPING → drain queue → FINALIZING (single winner) → finalizeSttSession()
```

**Session key:** `meetingId + recordingSessionId + attemptId` (from WS session attributes once known).

**Queue item fields (metadata only in logs):**

| Field | Type | Notes |
| --- | --- | --- |
| `meetingId` | long | |
| `recordingSessionId` | long | nullable until first valid metadata |
| `attemptId` | long | nullable until first valid metadata |
| `seq` | long | ordering key |
| `byteLength` | int | do not log bytes |
| `language` | string | |
| `speakerMode` | string | |
| `isFinal` | boolean | from metadata |
| `audioBytes` | byte[] | **must be nulled/cleared after processing** |
| `authorization` | string | pass-through to AI client |
| `enqueuedAtMs` | long | lag metric |

**Lifecycle states (per WS session worker) — atomic transitions:**

| State | Meaning | Transitions |
| --- | --- | --- |
| `ACTIVE` | Accept enqueue | → `STOPPING` on `stream.stop` |
| `STOPPING` | Reject new enqueue; drain existing | → `FINALIZING` when queue empty (CAS winner) |
| `FINALIZING` | **Only CAS winner** calls `finalizeSttSession()` once | → `FINALIZED` |
| `FINALIZED` | Ignore chunks; idempotent stop/close | terminal; trigger cleanup |
| `REJECTED` | Terminal/stale/reset_required/backpressure | terminal; trigger cleanup |

**Double finalization guard (REQUIRED):**

- `stream.stop`, `afterConnectionClosed`, and worker drain-timeout path **must not** call `finalizeSttSession()` concurrently.
- Use per-session `AtomicReference<WorkerState>` or equivalent CAS: only thread that successfully transitions `STOPPING → FINALIZING` invokes finalize.
- `afterConnectionClosed`: if worker already `FINALIZING`/`FINALIZED`, skip finalize (existing `FINALIZED_ATTR` guard remains).
- Duplicate `stream.stop`: idempotent close only.
- Log: `REALTIME_FINALIZE_SKIPPED_DUPLICATE meetingId reason=already_finalizing|already_finalized`.

**Worker lifecycle cleanup (REQUIRED):**

- On `FINALIZED`, `REJECTED`, or WS `afterConnectionClosed`:
  - Remove worker from `RealtimeAudioWorkerRegistry`.
  - Clear pending queue entries; null `audioBytes` on each dequeued/processed item.
  - Log: `REALTIME_WORKER_CLEANUP meetingId registrySizeBefore registrySizeAfter queueDepth=0`.
- Acceptance: registry size decreases after session end; no retained byte arrays in queue after finalize.

**Backpressure / queue full policy (DECIDED — fail, not pass):**

- In-memory bounded queue per session. Default max items: `64` (align with ai-service `stt_audio_queue_max_items`).
- **Queue full in happy-path smoke is a FAIL condition.**
- On enqueue when full:
  1. Log `REALTIME_CHUNK_DROPPED_QUEUE_FULL meetingId seq byteLength queueDepth maxQueueDepth reason=backpressure` (metadata only).
  2. Broadcast `stream.error` with `recoverable=false`, `resetRequired=true` **OR** close WS with reason `backpressure`.
  3. Transition worker/session to `REJECTED`; stop accepting further chunks.
  4. Do **not** silently drop and continue as if healthy.
- Unit test must assert queue-full path emits error/close.
- Manual smoke: any `REALTIME_CHUNK_DROPPED_QUEUE_FULL` → **smoke FAIL**.

**Ordering guarantees:**

- Single worker thread/executor per session → strict FIFO.
- Transcript broadcasts preserve AI response order per seq.
- `stream.stop` waits for queue drain (bounded timeout, proposal `5000ms`) before CAS into `FINALIZING`.

**Metrics/logs (safe metadata only):**

- `REALTIME_AUDIO_ENQUEUED meetingId seq byteLength queueDepth`
- `REALTIME_AUDIO_DEQUEUED meetingId seq queueDepth waitMs`
- `REALTIME_AUDIO_WORKER_LAG meetingId seq lagMs`
- `REALTIME_QUEUE_DRAIN_COMPLETE meetingId drainedCount waitMs` — **required before finalize when queue had pending items**
- `REALTIME_WORKER_CLEANUP meetingId registrySizeBefore registrySizeAfter`
- `REALTIME_FINALIZE_SKIPPED_DUPLICATE meetingId reason=...`
- Never log `audioBytes`, hex, base64, transcript text.

**Files likely involved:**

- `MeetingWebSocketHandler.java`
- `RealtimeAudioSessionWorker.java` (new)
- `RealtimeAudioWorkerRegistry.java` (new)
- `WebSocketConfig.java` (executor bean, feature flag binding)
- `application.yml` or `@Value` for `REALTIME_ASYNC_AUDIO_QUEUE_ENABLED`
- `infra/docker-compose.mvp.yml` — env mapping
- Tests: `MeetingWebSocketHandlerTest`, `RealtimeAudioSessionWorkerTest`

**Note:** AI service already has `MeetingSessionActor` internal queues. This slice addresses **processing-service WS ingress decoupling** only.

### 5.2 Config Guard

**Targets to validate (no secret printing):**

| Check | Expected | Severity |
| --- | --- | --- |
| `STT_RECV_DRAIN_TIMEOUT_SECONDS` | `<= 0.2` (default `0.1`) | ERROR if `>= 1.0` |
| `STT_FINAL_RECV_DRAIN_TIMEOUT_SECONDS` | present, `>= 1.0` (default `2.0`) | WARN if missing/misnamed |
| `DEEPGRAM_DEBUG_RAW_MESSAGES` | `false` in dev smoke | WARN/ERROR if `true` |
| Forced Deepgram `sample_rate` / `encoding` in streaming URL builder | omitted for WebM | WARN if detected at startup self-test |
| `STT_PROVIDER` | `deepgram` for realtime smoke | ERROR if unexpected |
| `REALTIME_ASYNC_AUDIO_QUEUE_ENABLED` | `true` for final smoke | WARN if `false` during smoke prep |

**Compose services (unchanged):** `ai-api`, `processing-api`, `meeting-api`, `user-api`, `db`, `redis`, `web`, `celery-worker`.

### 5.3 Smoke Separation

| Gate | Scope | Pass criteria (summary) | Owner slice |
| --- | --- | --- | --- |
| G1 Realtime STT core | Record → stop → WS partial/final → DB fragments → hydration | Section 8 | B, D, A, E |
| G2 Analysis auto | Post-stop Gemini analysis | defer unless required | R3 |
| G3 History/detail | `MeetingHistoryScene` transcript display | Section 8 + Slice C | C |
| G4 Export/search/action-plan | Non-realtime surfaces | defer | — |
| G5 Owner gate | Auth/ownership | defer | — |

**Recommendation:** Final smoke round 1 = **G1 only**. Round 2 = G1+G2. Round 3 = G1+G2+G3.

## 6. Implementation Slices

### Recommended order

1. **Slice B** — Config/env guard (low risk; protects observation)
2. **Slice D** — Logging/privacy scan (low risk; clean signals before hot path)
3. **Slice A** — Processing async queue / backpressure (hot path; depends on clean logs/config)
4. **Slice C** — UI/History transcript consistency (depends on stable transcript output from A)
5. **Slice E** — Smoke evidence script (packages commands after all slices)

---

### Slice B — Config/env guard

**Goal:** Detect dangerous realtime env overrides before smoke.

**Files likely touched:**

- `demoRecordAUDIOMID/ai-service/app/main.py`
- `demoRecordAUDIOMID/ai-service/app/config.py`
- `demoRecordAUDIOMID/ai-service/tests/test_realtime_config_guard.py` (new)
- `scripts/check-realtime-config.ps1` (new)
- Optional: `scripts/deploy/check-prod-config.sh`

**Tests:** Guard fails on `STT_RECV_DRAIN_TIMEOUT_SECONDS=1.0`; warns on `DEEPGRAM_DEBUG_RAW_MESSAGES=true`; warns if `REALTIME_ASYNC_AUDIO_QUEUE_ENABLED=false` during smoke prep.

**Rollback risk:** LOW.

**Acceptance criteria:** Startup logs `REALTIME_CONFIG_GUARD` without secrets; script exit non-zero on ERROR.

---

### Slice D — Logging/privacy scan hardening

**Goal:** No raw audio/transcript/provider payload in realtime path logs.

**Files likely touched:**

- `demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py`
- `demoRecordAUDIOMID/processing-service/.../AIServiceClient.java`
- `FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts`

**Acceptance criteria:** Forbidden patterns absent in tests; `DG CONNECT` no longer logs full URL with query values.

---

### Slice A — Processing async queue / backpressure

**Goal:** WS thread returns quickly when `REALTIME_ASYNC_AUDIO_QUEUE_ENABLED=true`; legacy sync path preserved when `false`.

**Files likely touched:**

- `MeetingWebSocketHandler.java`
- `RealtimeAudioSessionWorker.java`, `RealtimeAudioWorkerRegistry.java` (new)
- `WebSocketConfig.java`, `application.yml`, `infra/docker-compose.mvp.yml`
- `MeetingWebSocketHandlerTest.java`, `RealtimeAudioSessionWorkerTest.java` (new)

**Approach (pseudocode):**

```java
if (!asyncQueueEnabled) {
  // legacy: inline streamAudioChunk on WS thread (unchanged)
  return;
}
if (reject guards) return;
if (queue.isFull()) {
  log REALTIME_CHUNK_DROPPED_QUEUE_FULL;
  broadcast stream.error recoverable=false;
  transition REJECTED;
  return;
}
queue.enqueue(item);
log REALTIME_AUDIO_ENQUEUED;
return;

// worker thread
while (state == ACTIVE && queue not empty) {
  item = queue.poll();
  result = aiServiceClient.streamAudioChunk(...);
  item.audioBytes = null; // no retention
  broadcastTranscript(result);
}

// stream.stop (WS thread)
casTransition(ACTIVE, STOPPING);
reject new enqueue;
await drain(queue, timeout=5000ms);
log REALTIME_QUEUE_DRAIN_COMPLETE;
if (casTransition(STOPPING, FINALIZING)) {
  finalizeSttSession(); // single winner
}
casTransition(FINALIZING, FINALIZED);
registry.remove(sessionId);
log REALTIME_WORKER_CLEANUP;

// afterConnectionClosed
if (!casTransition(*, FINALIZING)) {
  log REALTIME_FINALIZE_SKIPPED_DUPLICATE;
  registry.remove(sessionId);
}
```

**Tests (mandatory):**

| Test | Path |
| --- | --- |
| Async enabled: WS returns before slow AI mock | `REALTIME_ASYNC_AUDIO_QUEUE_ENABLED=true` |
| Async enabled: seq order 1,2,3 preserved | true |
| Async enabled: `stream.stop` drains queue before finalize | true |
| Async enabled: `stream.stop` + `afterConnectionClosed` race → finalize once | true |
| Async enabled: queue full → `stream.error`/close, no silent continue | true |
| Async enabled: worker registry cleanup after FINALIZED | true |
| Async disabled: legacy inline path still passes existing handler tests | `false` |
| Stale/terminal chunks never enqueued (both paths) | both |

**Rollback risk:** LOW — flip `REALTIME_ASYNC_AUDIO_QUEUE_ENABLED=false`.

**Acceptance criteria:**

- All handler + worker tests pass for both flag values.
- No `REALTIME_CHUNK_DROPPED_QUEUE_FULL` in happy-path integration test.
- `REALTIME_QUEUE_DRAIN_COMPLETE` logged when stop drains pending chunks.
- No duplicate finalize log in race test.

---

### Slice C — UI/History transcript consistency hardening

**Goal:** After stop, live hydrated view ≈ History detail for same meeting.

**Depends on:** Slice A stable transcript persistence.

**Acceptance criteria:** Equivalence signature match; partial warning when `stopIncomplete` or `backendPartial`.

---

### Slice E — Final smoke scripts / log filters

**Goal:** Repeatable evidence for 2–3 consecutive meetings.

**Acceptance criteria:**

- Script outputs metadata only: fragment counts, checkpoint seq, log event tallies.
- **Must not print** `transcript_fragments.text`, raw provider payloads, or secrets.
- PASS/FAIL checklist includes queue-full and double-finalize checks.

## 7. Test Plan

### Frontend (after Slice C)

```powershell
cd D:\Bin\EXE101\phase3-worktree\FE-Audiomind
rtk npm test -- --run src/hooks/useRealtimeMeetingStream.test.tsx src/app/App.test.tsx
rtk npm test -- --run src/components/features/MeetingHistoryScene.test.tsx
rtk npm run build
```

### Processing (after Slice A)

```powershell
cd D:\Bin\EXE101\phase3-worktree\demoRecordAUDIOMID\processing-service
rtk test mvn -Dtest=MeetingWebSocketHandlerTest test
rtk test mvn -Dtest=RealtimeAudioSessionWorkerTest test
rtk test mvn test
```

### AI (after Slice B/D)

```powershell
cd D:\Bin\EXE101\phase3-worktree\demoRecordAUDIOMID\ai-service
rtk pytest tests/test_deepgram_stt_adapter.py tests/test_stt_session_actor.py tests/test_stt_stream_route.py -q
rtk pytest tests/test_realtime_config_guard.py -q
```

### Ops/config (after Slice B)

```powershell
cd D:\Bin\EXE101\phase3-worktree
rtk pwsh scripts/check-realtime-config.ps1
```

### Ops/evidence (after Slice E)

```powershell
cd D:\Bin\EXE101\phase3-worktree
rtk pwsh scripts/realtime-smoke-evidence.ps1 -MeetingId <MEETING_ID> -Since "30m"
```

Outputs metadata-only evidence under `smoke-evidence/meeting-<id>-<timestamp>/`.

### Manual smoke (after all slices)

- Run 2–3 consecutive realtime meetings on fresh meeting IDs.
- `REALTIME_ASYNC_AUDIO_QUEUE_ENABLED=true` confirmed before smoke.
- Collect DB evidence + filtered logs per §9.

## 8. Acceptance Criteria

### Realtime core pass (G1)

- Exactly one `REALTIME_SESSION_STARTED` per meeting per recording attempt.
- `AUDIO_CHUNK_SEND_ENQUEUED` / `AUDIO_CHUNK_SEND_FLUSHED` during record.
- Exactly one `STREAM_STOP_AFTER_FLUSH`; no `STREAM_STOP_FAILED`.
- `REALTIME_STOP_FINALIZE_AFTER_DRAIN` in processing logs.
- Async path: `REALTIME_AUDIO_ENQUEUED` / `REALTIME_AUDIO_DEQUEUED` for valid chunks.
- **No** `REALTIME_CHUNK_DROPPED_STALE_SESSION` during normal happy path.
- **No** `REALTIME_CHUNK_DROPPED_QUEUE_FULL` during happy-path smoke → **automatic FAIL**.
- **No** duplicate finalize: no second `Finalizing STT session` / `REALTIME_STOP_FINALIZE_AFTER_DRAIN` pair for same session after first finalize completed.
- `REALTIME_QUEUE_DRAIN_COMPLETE` appears before finalize when queue had pending chunks at stop.
- `REALTIME_WORKER_CLEANUP` appears or test verifies registry removal.
- No replay of seq `1..N` after finalized meeting.
- No `Conflict` storm; no stale `STT_FINALIZATION_REPLAY` loops.
- AI: `DG_REQUEST_PARAMS sampleRateIncluded=false`; `last_finalized_seq > 0` in `transcript_checkpoints`.
- DB: `max(end_time)` within ~15% of spoken duration; fragment count > 0 when speech present.
- UI after stop within equivalence tolerance of History transcript signature.

### Backpressure pass (Slice A)

- WS handler thread not blocked for duration of slow AI mock (async enabled).
- Queue preserves seq order.
- `stream.stop` drains queue before finalize; logs `REALTIME_QUEUE_DRAIN_COMPLETE`.
- Stale/terminal chunks dropped before enqueue.
- Queue full emits `stream.error` or session close — **degraded/fail**, not pass.
- Worker registry cleanup verified.

### Config pass (Slice B)

- Detects `STT_RECV_DRAIN_TIMEOUT_SECONDS=1.0` override.
- Detects `DEEPGRAM_DEBUG_RAW_MESSAGES=true`.
- Warns if async queue disabled during smoke prep.
- No secrets printed.

### Privacy pass (Slice D)

- No audio bytes/hex/base64/header bytes in logs.
- No raw transcript text or provider raw response bodies.
- No API key/token in logs.
- Smoke evidence script does not print `transcript_fragments.text`.

## 9. Commands

### Build/test (pre-smoke)

```powershell
cd D:\Bin\EXE101\phase3-worktree\FE-Audiomind
rtk npm test -- --run src/hooks/useRealtimeMeetingStream.test.tsx src/app/App.test.tsx
rtk npm run build

cd D:\Bin\EXE101\phase3-worktree\demoRecordAUDIOMID\processing-service
rtk test mvn -Dtest=MeetingWebSocketHandlerTest,RealtimeAudioSessionWorkerTest test
rtk test mvn test

cd D:\Bin\EXE101\phase3-worktree\demoRecordAUDIOMID\ai-service
rtk pytest tests/test_deepgram_stt_adapter.py tests/test_stt_session_actor.py tests/test_stt_stream_route.py -q
rtk pytest tests/test_realtime_config_guard.py -q
```

### Docker rebuild (run only after slices complete)

```powershell
cd D:\Bin\EXE101\phase3-worktree
rtk docker compose --env-file infra/.env `
  -f infra/docker-compose.dev.yml `
  -f infra/docker-compose.mvp.yml `
  up -d --build --force-recreate
```

### Config guard (after Slice B)

```powershell
cd D:\Bin\EXE101\phase3-worktree
rtk pwsh scripts/check-realtime-config.ps1
```

### Log filters (replace `<MEETING_ID>`)

```powershell
cd D:\Bin\EXE101\phase3-worktree
rtk docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml logs processing-api ai-api --since 30m 2>&1 |
  Select-String '<MEETING_ID>|REALTIME_|STREAM_STOP|DG_REQUEST_PARAMS|STT_FINALIZATION|REALTIME_CHUNK_DROPPED_QUEUE_FULL|REALTIME_QUEUE_DRAIN_COMPLETE|REALTIME_WORKER_CLEANUP|Conflict|AI_SERVICE_CALL_FAILED'
```

### DB evidence (replace `<MEETING_ID>`)

Schema verified via `demoRecordAUDIOMID/ai-service/app/models.py` and migration `004_stt_fragments_checkpoints.py`:

- Fragments table: `transcript_fragments` (columns: `meeting_id`, `seq`, `start_time`, `end_time`, `is_final`, `text` — **do not SELECT text in smoke script**)
- Checkpoint table: `transcript_checkpoints` (columns: `meeting_id`, `last_ack_seq`, `last_persisted_seq`, `last_finalized_seq`, `updated_at`)

```powershell
cd D:\Bin\EXE101\phase3-worktree

$sql = @"
SELECT meeting_id,
       COUNT(*) AS fragment_count,
       MAX(end_time) AS max_end,
       COUNT(*) FILTER (WHERE is_final = true) AS final_fragment_count
FROM transcript_fragments
WHERE meeting_id = <MEETING_ID>
GROUP BY meeting_id;

SELECT meeting_id,
       last_ack_seq,
       last_persisted_seq,
       last_finalized_seq,
       updated_at
FROM transcript_checkpoints
WHERE meeting_id = <MEETING_ID>;
"@

$sql | rtk docker compose --env-file infra/.env `
  -f infra/docker-compose.dev.yml `
  -f infra/docker-compose.mvp.yml `
  exec -T db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

**Note:** Replace `<MEETING_ID>` with integer before running. Queries intentionally omit `text` column to avoid printing raw transcript in terminal output.

## 10. Open Questions / Decisions Needed

1. **Stop drain timeout:** Proposal `5000ms` for worker queue drain at `stream.stop` — confirm vs FE 1500ms bufferedAmount drain.
2. **Queue max size:** Default `64` — confirm or lower for processing ingress only.
3. **Analysis/action-plan dirty diff:** Fix before G1 smoke, after G1 pass, or parallel branch?
4. **Final smoke scope round 1:** G1 only (recommended) or G1+G2 same session?
5. **`DG CONNECT url` logging:** Redact to host + query-key names only, or remove URL log entirely?

**Resolved (do not re-open without new evidence):**

- Feature flag: `REALTIME_ASYNC_AUDIO_QUEUE_ENABLED`, default `true`, legacy fallback required.
- Queue full: fail/degraded, not silent drop; smoke FAIL if event in happy path.
- Double finalization: CAS state machine required.
- Worker cleanup: registry removal + queue clear + no byte retention.
- DB checkpoint table: `transcript_checkpoints` (not `stt_meeting_checkpoints`).
- Implementation order: B → D → A → C → E.

## 11. Implementation Prompt for Next Agent

Implement slices in order **B → D → A**. Copy prompt below for **Slice B first**; after B+D pass, use Slice A prompt.

### Slice B prompt

```
Implement Slice B from docs/specs/7t-realtime-final-hardening-before-smoke-spec.md — Config/env guard.
Use CodeGraph first. Only touch ai-service config guard + scripts/check-realtime-config.ps1 + tests.
No commit. No Docker smoke. No secrets in logs.
```

### Slice A prompt (run only after B and D complete)

```
You are a senior realtime systems engineer for Audiomind.

Task: Implement Slice A from docs/specs/7t-realtime-final-hardening-before-smoke-spec.md — Processing async audio queue / backpressure.

Hard constraints:
- Use CodeGraph first to find MeetingWebSocketHandler, handleBinaryMessage, finalizeSttSession, afterConnectionClosed, AIServiceClient.streamAudioChunk.
- Only touch processing-service websocket/async queue files, application.yml, infra/docker-compose.mvp.yml (env mapping only), and their tests.
- Do NOT touch unrelated dirty files.
- Do NOT commit/push/stage. Do NOT use git add .
- Do NOT run Docker/browser smoke.
- Do NOT implement G3.5 or Google OAuth/API.
- Logs: metadata only. No raw audio/transcript/token/API key.

Feature flag (REQUIRED):
- Env: REALTIME_ASYNC_AUDIO_QUEUE_ENABLED
- Default true in infra/docker-compose.mvp.yml for processing-api
- When false: preserve legacy inline streamAudioChunk on WS thread unchanged
- When true: enqueue-only WS path + per-session worker
- Tests for BOTH flag values

Queue full policy (REQUIRED):
- Queue full is FAIL/degraded, NOT silent pass
- Emit stream.error recoverable=false OR close session reason=backpressure
- Log REALTIME_CHUNK_DROPPED_QUEUE_FULL (metadata only)
- Do NOT silently drop and continue

Double finalization guard (REQUIRED):
- Atomic state: ACTIVE → STOPPING → FINALIZING → FINALIZED
- Only CAS winner into FINALIZING calls finalizeSttSession()
- stream.stop + afterConnectionClosed race must finalize at most once
- Log REALTIME_FINALIZE_SKIPPED_DUPLICATE when skipped

Worker cleanup (REQUIRED):
- Remove worker from registry on FINALIZED/REJECTED/closed
- Clear queue after finalize/reject
- Null audioBytes after AI call — no byte[] retention
- Log REALTIME_WORKER_CLEANUP

Required tests:
- Async enabled: slow AI does not block WS thread
- Async enabled: seq order preserved
- Async enabled: stream.stop drains queue; REALTIME_QUEUE_DRAIN_COMPLETE logged
- Async enabled: stream.stop + afterConnectionClosed race → finalize once
- Async enabled: queue full → stream.error/close (fail condition)
- Async enabled: registry cleanup after finalized
- Async disabled: existing MeetingWebSocketHandlerTest cases pass (legacy path)

Run: mvn -Dtest=MeetingWebSocketHandlerTest,RealtimeAudioSessionWorkerTest test

Self-review against spec §8. Report files changed and test results. Do not commit.
```

---

## Appendix A — CodeGraph / Schema Grounding

**DB schema (ai-service):**

| Table | Model | Key columns for smoke evidence |
| --- | --- | --- |
| `transcript_fragments` | `TranscriptFragment` | `meeting_id`, `seq`, `start_time`, `end_time`, `is_final` — omit `text` in evidence queries |
| `transcript_checkpoints` | `TranscriptCheckpoint` | `meeting_id`, `last_ack_seq`, `last_persisted_seq`, `last_finalized_seq`, `updated_at` |

Migration: `demoRecordAUDIOMID/ai-service/alembic/versions/004_stt_fragments_checkpoints.py`

**Code symbols inspected:**

- `MeetingWebSocketHandler` — `handleBinaryMessage`, `finalizeSttSession`, `afterConnectionClosed`
- `AIServiceClient.streamAudioChunk` — synchronous HTTP
- `stt_persistence.py` — `upsert_checkpoint` → `transcript_checkpoints`
- FE: `stopStream`, `hydrateLiveTranscriptSegments`, `mergeHydratedTranscriptWithLive`

## Appendix B — Safe Realtime Log Keys

Approved: `meetingId`, `recordingSessionId`, `attemptId`, `seq`, `byteLength`, `queueDepth`, `bufferedAmount`, `drainTimeoutMs`, `fragmentCount`, `maxEndTime`, `finalizedSeq`, `reason`, `status`, `lagMs`, `waitMs`, `registrySizeBefore`, `registrySizeAfter`, `drainedCount`

Forbidden: raw transcript, provider JSON bodies, audio bytes, hex/base64, API keys, JWT/token, prompts, Gemini responses.
