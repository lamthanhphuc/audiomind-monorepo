# Phase 7E - Analysis Reliability Hardening

## 1. Status
- SPEC-ONLY
- Branch: chore/analysis-reliability-spec
- Date: 2026-05-27
- No implementation code in this branch

## 2. Link to previous phases
- Phase 7B already stabilized health/readiness.
- Phase 7C already standardized canonical backend error responses and traceId propagation.
- Phase 7D already standardized logging keys and debug visibility.
- Phase 7E only hardens analysis reliability.
- Out of scope here: multi en+vi STT, FE polish, logging overhaul, and contract-breaking changes.

## 3. Current state

| Flow | Current behavior | Reliability gaps |
| ---- | ---------------- | ---------------- |
| Upload transcript + analysis | Upload goes through `processing-service` -> `ai-service` batch STT. `processing-service` resolves language, calls `aiServiceClient.processAudio(...)`, writes batch job state to Redis via `JobStateStore`, and later serves transcript/analysis from job state first, then ai-service fallback if needed. Analysis is not a separate immediate post-upload job; it is retrieved lazily through `/processing/{meetingId}/analysis` when state is missing. | Analysis is still coupled to later polling and fallback paths. Duplicate upload is guarded by file idempotency, but duplicate analysis trigger behavior depends on transcript hash/state and can still be noisy when polling repeatedly. Failure semantics are not yet fully frozen into a single analysis state model. |
| Realtime stop + final transcript + analysis | `MeetingWebSocketHandler` finalizes STT once, caches the final transcript, broadcasts the final segment, and triggers realtime analysis after a final non-empty transcript. `processing-service` also has a lazy realtime analysis path when analysis is polled and job-state analysis is missing. | Duplicate stop/finalize is mostly guarded, but analysis trigger sources are split across websocket stop and lazy poll. Failure handling differs between paths, and the stop-triggered branch can still re-enter if the analysis guard is not persisted consistently across failures. |
| Polling `/processing/{meetingId}/analysis` | The endpoint checks job state first, then calls ai-service `/api/meeting/{meeting_id}/analysis`, and only then lazily triggers realtime analysis if neither source has usable analysis. Current non-ready behavior is still backward-compatible with `404` semantics for FE polling. | Polling can become the trigger source itself, so repeated polls may cause trigger spam unless guards/cooldown hold. The response currently only exposes coarse status values such as `NOT_FOUND`, `QUEUED`, or the ai-service status, but it does not yet express a full durable analysis lifecycle. |
| ai-service Gemini analysis | ai-service stores analysis in its `analysis` table and exposes `/api/meeting/{meeting_id}/analysis` plus `/api/internal/realtime-analysis`. For realtime analysis it computes a transcript hash, skips empty or already-existing work, and returns `completed` / `skipped` / `failed` / `503` paths depending on analyzer availability and downstream exceptions. | Gemini/provider failures are partially safe, but the failure model is not fully harmonized with processing-service polling and duplicate guards. There is still a risk of inconsistent failure states between provider unavailable, parse failure, and generic analysis failure. |
| Duplicate / idempotency behavior | Upload dedupe is file id-based in `JobStateStore.claimIdempotency`. Realtime dedupe uses `meetingId + transcriptHash` in memory on both processing-service and ai-service. Processing-service lazy analysis also has in-progress and recent-failure guards. | Idempotency is split across file idempotency, meeting guards, and transcript hash guards rather than one explicit analysis state contract. Duplicate stop, duplicate poll, and duplicate upload are not yet described by one shared state machine. |
| Cooldown / failure behavior | Processing-service lazy realtime analysis currently has a failure cooldown and skip log throttling. Realtime stop-triggered analysis has in-progress / already-exists guards, while ai-service realtime analysis uses in-progress + completed hash and returns failure on provider/config issues. | Cooldown is not yet uniformly documented across upload, polling, and realtime stop. Failure recovery behavior is not explicit enough for repeated poll cycles, and the current design still leaves room for repeated trigger attempts after certain failure branches. |

## 4. Goals
- Make analysis flow stable enough for demo use.
- Preserve transcript availability when Gemini or analysis fails.
- Prevent FE polling from repeatedly triggering new analysis work.
- Prevent duplicate stop/upload events from creating multiple analysis jobs for the same transcript.
- Make state explicit: `NOT_STARTED`, `PENDING`/`QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `SKIPPED`.
- Reuse 7C canonical error codes and 7D logging keys.
- Avoid any STT or multi-language behavior changes.

## 5. Non-goals
- No Deepgram multi-language work.
- No transcript quality tuning.
- No FE UI or polish changes.
- No breaking contract migration unless a separate phase approves it.
- No large retry framework or circuit-breaker rollout unless evidence shows it is needed.
- No large queue/job-system refactor.

## 6. Target analysis state model

Recommended states:
- `NOT_STARTED`
- `PENDING` / `QUEUED`
- `RUNNING`
- `COMPLETED`
- `FAILED`
- `SKIPPED`

Recommended fields if the chosen storage layer can support them:
- `meetingId`
- `source` (`upload`, `realtime`, `lazy_poll`)
- `status`
- `transcriptHashPrefix`
- `analysisVersion`
- `startedAt`
- `completedAt`
- `failedAt`
- `errorCode`
- `errorMessage` safe
- `retryAfterSeconds`
- `lastTriggeredBy`
- `cooldownUntil`

Storage guidance:
- Prefer reusing existing job-state/result fields where possible.
- If durable state is needed for duplicate/cooldown behavior, Redis is the lowest-risk first choice because both processing-service and ai-service already use it.
- In-memory-only guards are not recommended for demo reliability because container restarts would clear state.
- DB schema migration should be a separate, explicitly justified choice if Redis or existing fields cannot represent the required behavior safely.

## Recommended first implementation decision

- Use Redis-backed analysis state, lock, and cooldown for the first 7E implementation.
- Do not add a DB migration in the first 7E implementation unless existing Redis/job-state/ai-service fields cannot represent required behavior safely.
- Avoid in-memory-only guards for demo-critical duplicate/failure behavior because container restart clears them.
- Keep DB/schema migration as a separate explicit decision if 7E-1 proves Redis/existing fields insufficient.

## 7. Idempotency and duplicate guard plan

Recommended keys:
- `idempotencyKey = meetingId + source + transcriptHashPrefix`
- `lockKey = analysis:lock:{meetingId}`
- `stateKey = analysis:state:{meetingId}`
- `cooldownKey = analysis:cooldown:{meetingId}`

Rules:
- If `COMPLETED` with the same transcript hash, do not trigger again.
- If `RUNNING` or `PENDING`, return the existing state and do not start new work.
- If `FAILED` and the cooldown window is still active, do not trigger again; return the failed/not-ready state with `retryAfterSeconds`.
- If the transcript hash changes, allow a new analysis version only if the business flow explicitly wants a re-run.
- Duplicate realtime stop should log `REALTIME_ANALYSIS_SKIPPED` and never enqueue a second job for the same transcript.
- Duplicate upload should behave as success-style skipped/already_exists when the same transcript has already been analyzed.

Recommended initial defaults:
- analysis lock TTL: 2-5 minutes
- failure cooldown: 60-120 seconds
- duplicate skip log throttle: 30-60 seconds
- `retryAfterSeconds` should reflect remaining cooldown when cooldown is active

These are initial implementation defaults and can be adjusted after demo testing.

## 8. HTTP/API behavior plan

Priority is backward compatibility.

Polling endpoint `/processing/{meetingId}/analysis`:
- `COMPLETED` -> `200` with analysis body.
- `NOT_READY` / `PENDING` / `RUNNING` -> keep current FE-compatible pending behavior, usually `404 ANALYSIS_NOT_READY` with canonical 7C body.
- `FAILED` -> return the canonical error mapped to the failure cause, with safe body and traceId.
- `SKIPPED` -> return the existing success-style body or a cached completed response when analysis already exists.

Trigger semantics:
- Do not change current polling contract from `404` to `202` in 7E if that would break FE polling.
- If async trigger semantics are improved later, treat that as a separate contract/FE migration.

Recommended failure mapping:
- `AI_SERVICE_UNAVAILABLE` -> `503`
- `GEMINI_UNAVAILABLE` -> `503`
- `GEMINI_ANALYSIS_FAILED` -> `502`
- `EMPTY_TRANSCRIPT` -> `422`
- `DUPLICATE_REQUEST_SKIPPED` -> `200` or `202` depending on whether the endpoint is returning an existing result or an in-flight trigger response.

## 9. Gemini failure handling

Plan:
- Gemini failure must not delete transcript rows or transcript cache.
- Parse failure must not delete transcript rows or transcript cache.
- Save a safe failure state with safe `errorCode` and `retryAfterSeconds`.
- Do not expose raw provider payloads in the API response.
- Prefer structured output validation or a safe fallback object when provider schema is not fully reliable.
- Retry only for transient/provider-unavailable cases.
- Do not retry validation failures such as empty transcript or obviously invalid input.

## 10. Retry / circuit-breaker recommendation

Start with the smallest safe protection:
- short timeout
- 2-3 max attempts
- small backoff
- no retry for validation errors

If protection is needed on the Java side when calling ai-service, consider Spring Retry or Resilience4j only if the repo already uses it or the incremental risk stays low.

If protection is needed on the Python side for Gemini calls, keep retry bounded and keep logging sanitized.

Circuit breaker should only be introduced if provider instability proves real, not preemptively.

## 11. Error response mapping from 7C

Use these codes when analysis reliability work needs to communicate state:
- `ANALYSIS_NOT_READY`
- `TRANSCRIPT_NOT_READY`
- `AI_SERVICE_UNAVAILABLE`
- `GEMINI_UNAVAILABLE`
- `GEMINI_ANALYSIS_FAILED`
- `EMPTY_TRANSCRIPT`
- `DUPLICATE_REQUEST_SKIPPED`
- `INTERNAL_ERROR`

HTTP recommendation:
- Preserve current `404`-based not-ready polling behavior for compatibility.
- Use `503` for unavailable provider/service cases.
- Use `502` for analysis/parse failure when Gemini responded but the result was unusable.
- Use `422` for empty transcript.

## 12. Logging plan from 7D

Use these keys:
- `ANALYSIS_TRIGGER_REQUEST`
- `ANALYSIS_TRIGGER_SKIPPED`
- `ANALYSIS_TRIGGER_FAILED`
- `ANALYSIS_GET_REQUEST`
- `ANALYSIS_GET_RESULT`
- `ANALYSIS_GET_NOT_READY`
- `GEMINI_ANALYSIS_REQUEST`
- `GEMINI_ANALYSIS_RESPONSE_PARSED`
- `GEMINI_ANALYSIS_FAILED`
- `REALTIME_ANALYSIS_TRIGGERED`
- `REALTIME_ANALYSIS_SKIPPED`
- `REALTIME_ANALYSIS_SAVED`
- `REALTIME_ANALYSIS_FAILED`

Required fields:
- `traceId`
- `requestId`
- `meetingId`
- `source`
- `analysisStatus`
- `transcriptHashPrefix`
- `durationMs`
- `errorCode`
- `retryAfterSeconds`

Do not log full transcript text.

## 13. Test matrix

Upload:
- valid transcript upload -> analysis completed
- empty transcript upload -> `EMPTY_TRANSCRIPT`
- duplicate upload with same transcript -> no duplicate Gemini call
- ai-service down -> `AI_SERVICE_UNAVAILABLE`
- Gemini fail -> transcript kept and failed state preserved
- parallel polls while analysis is missing -> only one trigger is created
- repeated polls during RUNNING -> no duplicate Gemini call
- cooldown active after failure -> repeated polls do not call Gemini again

Realtime:
- stop once -> final transcript plus one analysis trigger
- duplicate stop -> no duplicate trigger
- concurrent duplicate stop events -> only one final transcript/analysis trigger
- duplicate stop after COMPLETED -> returns/skips safely without new Gemini call
- lock TTL expiry -> stuck RUNNING state can recover safely
- poll before ready -> stable not-ready behavior
- poll during running -> no duplicate trigger
- poll after completed -> `200` with data
- poll after failed within cooldown -> no retry spam
- poll after cooldown -> explicit behavior

Compatibility:
- pending analysis remains FE-compatible
- canonical error body still present
- traceId preserved

## 14. Manual validation plan

Commands:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml up -d
```

```bash
curl -i -H "X-Trace-Id: test-7e" http://localhost:8082/processing/<meetingId>/analysis
```

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api | Select-String -Pattern "test-7e|ANALYSIS_TRIGGER|REALTIME_ANALYSIS|GEMINI_ANALYSIS" -CaseSensitive:$false
```

Suggested smoke order:
1. Poll before analysis is ready.
2. Trigger upload or realtime stop.
3. Poll after completion.
4. Verify duplicate stop does not create a second trigger.
5. Verify logs by traceId and meetingId.

## 15. Implementation slices after this spec

- 7E-1: audit + state model / failure semantics in processing-service
- 7E-2: upload analysis idempotency / duplicate guard
- 7E-3: realtime stop analysis duplicate guard / cooldown
- 7E-4: ai-service Gemini failure / parse-safe handling
- 7E-5: tests + manual demo checklist

## 16. Risks and open decisions

- Should pending analysis stay `404` or move to `202` later?
- Should the durable analysis state live in Redis or a DB table?
- Is a DB schema migration needed at all, or can existing fields carry the state safely?
- How long should the cooldown window be after failure?
- Should transcript hash be computed in processing-service, ai-service, or both?
- Is Gemini structured output reliable enough today, or do we need a stronger validation fallback?
- Should retry live in processing-service, ai-service, or both?
- How do we prevent realtime log spam while still preserving useful failure visibility?

## 17. Acceptance criteria for implementation PR

- No duplicate Gemini analysis for the same meeting/transcript.
- Transcript remains available when analysis fails.
- Polling behavior remains FE-compatible.
- Failure state is visible and safe.
- Cooldown prevents retry spam.
- 7C error codes are used.
- 7D log keys are used.
- Targeted tests pass.
- No STT or multi-language behavior changes.
