# Phase 7A - Backend Reliability & Demo Hardening

Status: SPEC-ONLY (no backend/frontend implementation in this branch)
Date: 2026-05-24
Branch: chore/backend-demo-hardening

## 1. Current backend state

### 1.1 Upload transcript + Gemini analysis flow (current)
- FE upload path currently goes through meeting + processing + ai-service pipeline.
- `processing-service` accepts `/processing/start` and `/processing/start/{meetingId}`; request language is normalized to `vi|en|multi` and falls back to `vi` when invalid.
- `processing-service` has idempotency claim via `JobStateStore.claimIdempotency(fileId, meetingId)` to avoid duplicate upload processing for the same file key.
- For analysis reads (`/processing/{meetingId}/analysis`), `processing-service` attempts in this order:
  1. analysis from Redis/job-state result,
  2. fallback to ai-service `/api/meeting/{meeting_id}/analysis`,
  3. if still missing, lazy-trigger internal realtime analysis path from transcript.
- `ai-service` exposes `/api/meeting/{meeting_id}/analysis` and returns normalized analysis payload with fields like `summary`, `keywords`, `technicalTerms`, `painPoints`, `actionItems`, `domainMode`, `status`, `source`, `transcript_hash`.

### 1.2 Realtime stop + transcript persisted/hydrated + Gemini analysis flow (current)
- Realtime stream uses `processing-service` WebSocket handler.
- On `stream.stop`, handler finalizes STT once, sets finalization guard (`FINALIZED_ATTR`), attempts synthetic final chunk to ai-service, broadcasts/caches final transcript, then triggers realtime analysis async when transcript is final/non-empty.
- Duplicate stop/finalize is guarded:
  - duplicate `stream.stop` ignored,
  - duplicate finalization replay from ai-service treated as terminal no-op,
  - transcript cache for fallback exists with TTL and max-size cap.
- `processing-service` realtime analysis trigger computes `meetingId + transcriptHash` guard to skip `in_progress` and `already_exists` duplicate analysis for same transcript hash.
- `ai-service` internal endpoint `/api/internal/realtime-analysis` has its own guard maps (`in_progress`, `completed_hash`) and returns `completed`/`skipped`/`failed` semantics.

### 1.3 Services involved
- `web` (FE Vite static container)
- `meeting-api` (Spring)
- `processing-api` (Spring, REST + WebSocket, bridges to ai-service)
- `user-api` (Spring)
- `ai-api` (FastAPI, Deepgram + analysis provider)
- `celery-worker` (async ai processing)
- infra dependencies: `db` (Postgres), `redis`, `ollama-service`, plus optional `whisper-service`, `diarization-service`, `processing-service` (ai-processing-service).

### 1.4 What is already stable vs what remains

Likely already stabilized from recent phases (based on current code/tests):
- Upload language normalization and fallback (`vi|en|multi`), including tests.
- Realtime endpointing resolution by language with env fallback and tests.
- Realtime finalize duplicate guards and reset-required paths.
- Lazy realtime analysis trigger with transcript-hash duplicate guard in processing-service.
- ai-service realtime-analysis idempotency for same transcript hash.

Remaining debt for demo hardening:
- Error response shape is not unified across Spring + FastAPI + endpoint families.
- Logging keys/fields are partially structured but not fully standardized end-to-end.
- Health/readiness conventions differ (`/health`, `/ready`, no compose healthcheck blocks yet).
- Cooldown behavior differs by path:
  - `ProcessingService` lazy path has failure cooldown,
  - `MeetingWebSocketHandler` realtime path currently removes guard on failure (no cooldown), allowing rapid retrigger.
- Contract/error-code checklist is not formalized as a single backend reliability spec.

## 2. Goals

- Backend stable for live demo scenarios.
- Health checks explicit and actionable.
- Consistent error responses across backend services.
- Logging standardization for fast grep/debugging.
- Clear idempotency/cooldown behavior for upload/realtime/analysis polling.
- Reliable `/processing/{meetingId}/analysis` semantics for both upload and realtime paths.
- Docker/dev debugging guide with reproducible commands.
- Contract validation checklist before implementation.
- Structured investigation plan for multi-language `en+vi` STT behavior.

## Phase 7 follow-up mapping

- `7B` Health Check & Service Readiness
  - materialized from section 4 (health plan + readiness acceptance criteria)
- `7C` Error Response Standardization
  - materialized from section 5 (canonical error shape and code/status mapping)
- `7D` Logging & Debuggability
  - materialized from section 6 and the debugging guide split
- `7E` Analysis Reliability Hardening
  - materialized from sections 7 and 8 (idempotency/cooldown + endpoint semantics)
- `7F` Multi `en+vi` STT Investigation
  - materialized from section 11 test matrix + open questions
- `7G` Multi `en+vi` STT Implementation if needed
  - only after 7F evidence and sign-off
- `7H` Docker & Demo Debugging Guide
  - materialized from section 9 + `docs/backend/demo-debugging-guide.md`
- `7I` Contract & CI Hardening
  - materialized from section 10 and freeze decisions in section 5.2
- `7J` Backend Final Demo Checklist
  - final consolidation of acceptance criteria and runbook checks

## 3. Non-goals / Out of scope

- No FE polish and no UI redesign.
- No DB schema change unless a separate approved spec requires it.
- No immediate Deepgram/Gemini behavior change.
- No blind transcript quality tuning without matrix-driven evidence.
- No API contract breaking change without dedicated contract spec/review.
- No backend code implementation in this branch.

## 4. Health check plan

### 4.1 Proposed endpoint standard
- `processing-api`
  - Keep `/health` for liveness.
  - Keep `/ready` for readiness (already checks Redis + ai-service health).
  - Evaluate adding Actuator (`/actuator/health`) only if needed for richer dependency detail.
- `ai-api`
  - Keep `/health` and `/ready`.
  - Add explicit non-secret signals in health/readiness payload:
    - app status,
    - DB/Redis connectivity state,
    - analysis provider availability state,
    - Deepgram key configured true/false (boolean only),
    - Gemini key configured true/false (boolean only).
- `meeting-api` / `user-api`
  - Keep `/health` and `/ready` parity.

### 4.2 Docker compose plan
- Add `healthcheck` to core services first:
  - `meeting-api`, `processing-api`, `user-api`, `ai-api`, `db`, `redis`.
- Move key dependencies to `depends_on: condition: service_healthy` where supported by compose version in project tooling.
- Keep startup resilient when optional services are unavailable (avoid hard failing non-core demo path).

### 4.3 Acceptance criteria
- Manual curl checks return expected health/readiness for each core service.
- Broken dependency yields clear readiness failure, not ambiguous success.
- Health output never exposes secrets.

### 4.4 Suggested manual commands
- `docker compose --env-file infra/.env -f infra/docker-compose.dev.yml up -d`
- `curl -fsS http://localhost:8082/health`
- `curl -fsS http://localhost:8082/ready`
- `curl -fsS http://localhost:8000/health`
- `curl -fsS http://localhost:8000/ready`
- `curl -fsS http://localhost:8081/health`
- `curl -fsS http://localhost:8083/health`

## 5. Error response standardization

### 5.1 Target error shape

```json
{
  "error": "ANALYSIS_NOT_READY",
  "message": "Analysis is not ready yet",
  "status": 404,
  "timestamp": "2026-05-24T00:00:00Z",
  "traceId": "..."
}
```

### 5.2 Error code mapping proposal
- `ANALYSIS_NOT_READY` -> `404`
- `TRANSCRIPT_NOT_READY` -> `404`
- `AI_SERVICE_UNAVAILABLE` -> `503`
- `DEEPGRAM_UNAVAILABLE` -> `503`
- `GEMINI_ANALYSIS_FAILED` -> `502` (or `503` if provider unavailable/config missing)
- `INVALID_LANGUAGE` -> `400`
- `EMPTY_TRANSCRIPT` -> `422`
- `DUPLICATE_REQUEST_SKIPPED` semantics (recommended decision):
  - duplicate already completed -> `HTTP 200` with `status=skipped` (or `already_exists`)
  - duplicate currently running -> `HTTP 202` with `status=in_progress`
  - true conflicting client request -> `HTTP 409`

Decision note:
- Freeze this duplicate/idempotent contract behavior during `7C` and `7I` to avoid FE treating idempotent duplicates as hard errors.

### 5.3 Spring plan (no implementation in this branch)
- Introduce unified error DTO for all `@RestControllerAdvice` responses.
- Option A: custom DTO returned by `ControllerAdvice`.
- Option B: wrap Spring `ProblemDetail` with compatibility adapter preserving above shape.
- Ensure `traceId` propagated from `x-trace-id`/MDC.

### 5.4 FastAPI plan (no implementation in this branch)
- Add custom exception handlers for `HTTPException` + domain exceptions.
- Keep one canonical shape for all business errors and unhandled exceptions.
- Keep global exception fallback aligned with Spring fields (`error`, `message`, `status`, `timestamp`, `traceId`).

## 6. Logging standardization

### 6.1 Safe log keys to enforce
- `UPLOAD_REQUEST_RECEIVED`
- `UPLOAD_LANGUAGE_EFFECTIVE`
- `BATCH_STT_EFFECTIVE_CONFIG`
- `UPLOAD_TRANSCRIPT_COMPLETED`
- `GEMINI_ANALYSIS_REQUEST`
- `GEMINI_ANALYSIS_RESPONSE_PARSED`
- `GEMINI_ANALYSIS_FALLBACK`
- `REALTIME_STOP_RECEIVED`
- `REALTIME_TRANSCRIPT_FINALIZED`
- `REALTIME_ANALYSIS_TRIGGERED`
- `REALTIME_ANALYSIS_SKIPPED`
- `REALTIME_ANALYSIS_SAVED`
- `REALTIME_ANALYSIS_FAILED`
- `ANALYSIS_GET_REQUEST`
- `ANALYSIS_GET_RESULT`

### 6.2 Must-not-log policy
- Never log API keys.
- Never log full long transcript text.
- Never log secret env values.
- Never log token/password credentials.

### 6.3 Required structured fields
- `traceId` / `requestId`
- `meetingId`
- `source` (`upload` / `realtime` / internal trigger source)
- `requestedLanguage`
- `effectiveLanguage`
- `model`
- `analysisStatus`
- `transcriptHashPrefix` (short prefix only)
- `durationMs`
- `errorCode`

## 7. Idempotency/cooldown review

### 7.1 Upload duplicate guard
- Existing: `claimIdempotency(fileId, meetingId)` in processing-service.
- Plan: formalize ownership windows, replay semantics, and response shape for duplicate uploads.

### 7.2 Realtime stop duplicate guard
- Existing: `FINALIZED_ATTR` and replay handling in websocket finalize path.
- Plan: ensure duplicate stop always yields deterministic status event and no duplicate persistence.

### 7.3 Analysis in-progress guard
- Existing:
  - processing lazy path has in-progress + completed-hash + failure cooldown.
  - websocket analysis path has in-progress + completed-hash but no failure cooldown.
  - ai-service internal endpoint has in-progress + completed-hash.
- Plan: unify behavior and define one cooldown contract for all trigger sources.

### 7.4 Failed analysis cooldown
- Existing mismatch:
  - `ProcessingService`: failure cooldown present.
  - `MeetingWebSocketHandler`: failure currently clears guard (retrigger possible).
- Plan: adopt common cooldown semantics and telemetry for repeated fail loops.

### 7.5 Key strategy
- Canonical key: `meetingId + transcriptHash`.
- Keep lazy trigger idempotent under FE polling and websocket close race.

### 7.6 Polling after fail and repeated stop
- Define exact behavior when Gemini fails and FE polls continuously:
  - no trigger spam,
  - transparent status (`failed` with reason),
  - retry window bounded by cooldown.
- Define repeated `stream.stop` semantics:
  - no duplicate finalize call,
  - no duplicate analysis trigger.

## 8. Analysis endpoint reliability

Target endpoint: `/processing/{meetingId}/analysis`

### 8.1 Unified semantics for upload + realtime
- Both flows must converge to same externally visible status semantics:
  - `pending`/`queued`/`running`
  - `completed`
  - `failed`.

### 8.2 Status and HTTP behavior
- `404` only when truly not found/not ready (no transcript/analysis yet).
- `500/502/503` must not be masked into fake `404`.
- Response should include machine-readable status and optional reason.

### 8.3 Data durability guarantees
- Gemini/analysis failure must never remove persisted transcript.
- Internal realtime-analysis must be independent from batch upload processing pipeline availability where possible.

### 8.4 Anti-spam requirements
- FE polling must not repeatedly trigger analysis for same transcript hash.
- Retry logic must be bounded and observable via logs/metrics.

### 8.5 Manual acceptance tests
- Upload path: trigger analysis, poll until completed, verify no duplicate trigger logs.
- Realtime path: stop once and stop duplicate, verify exactly one effective analysis trigger per hash.
- Failure path: force analyzer unavailable, verify stable cooldown + explicit failed/unavailable signal.

## 9. Docker/dev debugging guide

Detailed runbook is split into:
- `docs/backend/demo-debugging-guide.md`

Scope includes:
- compose up/rebuild commands,
- health checks,
- grep/filter examples for 503/missing keys/redis/downstream failures,
- troubleshooting decision tree for realtime analysis + analysis polling 404.

## 10. Contract validation checklist

- Verify `packages/contracts` schemas reflect planned stable error/status semantics.
- Verify `packages/api-clients` generated client models for analysis/error shape.
- Verify processing-service response envelope (`meeting_id`, `status`, analysis fields) remains backward compatible.
- Verify ai-service internal endpoint payload/response remains stable for processing-service integration.
- Verify FE current expectation compatibility before changing shape (especially polling and non-200 handling).
- Prepare error-shape migration plan:
  - phase-in with compatibility adapter,
  - deprecate legacy fields after FE/client rollout.

## 11. Multi en+vi STT investigation plan

### 11.1 Current in-code language behavior
- Allowed language set in current code paths: `vi`, `en`, `multi`.
- Invalid values fallback to configured default or `vi`.
- Realtime endpointing supports language-specific env settings for `vi`, `en`, `multi`.

### 11.2 External findings status
- Verified guidance from official Deepgram documentation (to be validated in-project via matrix tests before production changes):
- Setting a specific `language` such as `en` or `vi` constrains recognition toward that language; speech in other languages may not be transcribed reliably.
- For multilingual audio, Deepgram guidance is to consider `language=multi` with multilingual-capable models.
- Multilingual code-switching uses `language=multi`.
- Nova-2/Nova-3 support multilingual code-switching for documented multilingual language sets in both pre-recorded and streaming paths; Vietnamese (`vi`) is listed as a supported monolingual language, but `en+vi` under `language=multi` must be verified explicitly in our model/account and test matrix.
- Streaming multilingual examples can use `language=multi&model=nova-3`, and docs recommend considering endpointing around `100ms` for code-switching responsiveness.
- `detect_language` is not supported for streaming realtime; realtime multilingual should use multilingual-capable models (Nova-2/Nova-3 path) instead of streaming language detection.
- If language is not explicitly set, defaults may resolve to `en` in provider behavior/model defaults; project logs must always capture selected and effective language.

Sources to verify manually:
- Deepgram Languages Support
- Deepgram Multilingual Codeswitching
- Deepgram Language Detection
- Deepgram Models & Languages Overview

### 11.3 Test matrix

Upload matrix:
- `vi` only audio, request `language=vi`
- `en` only audio, request `language=en`
- mixed `vi+en`, request `language=vi`
- mixed `vi+en`, request `language=en`
- mixed `vi+en`, request `language=multi`
- missing/null/invalid language -> fallback path (`vi` expected unless configured default says otherwise)

Realtime matrix:
- `vi` only
- `en` only
- mixed `vi+en` with current mapping
- mixed `vi+en` with `language=multi` (if supported)
- stop once
- stop duplicate
- poll analysis before ready and after ready

### 11.4 Log/metadata checkpoints
- selected language
- effective language
- Deepgram model
- Deepgram `language` param
- `detect_language` flag (if used)
- transcript quality observation
- confidence/language metadata if available

### 11.5 Open questions before implementation
- Which Deepgram model/account tier is currently active in demo env for realtime and batch?
- Does current account/model provide reliable `en+vi` multilingual performance in streaming mode?
- Is automatic language detection supported/allowed in realtime for our selected model path?
- Should `language=multi` be opt-in only, or become default for mixed-language meetings?
- What is the accepted quality threshold and fallback policy when mixed-language confidence drops?
- Should failure cooldown and retry windows be identical across:
  - processing lazy analysis trigger,
  - websocket stop-triggered analysis,
  - ai-service internal analysis endpoint?

### 11.6 Recommended implementation slices
- `7A-1` backend reliability/demo hardening
  - health/readiness standardization
  - error shape unification
  - logging keys/fields standardization
  - cooldown/idempotency alignment across trigger paths
  - analysis endpoint semantics hardening
- `7A-2` multi `en+vi` STT investigation
  - verify provider docs manually
  - execute matrix and collect objective logs/quality notes
  - decide runtime mapping policy (`vi/en/multi`) by evidence
- `7A-3` implementation after test matrix only
  - apply Deepgram mapping/model changes only after matrix sign-off
  - update contracts/clients only with approved compatibility plan

## 12. Acceptance criteria

Spec branch is accepted when:
- Branch name is `chore/backend-demo-hardening`.
- `docs/specs/backend-demo-hardening.md` exists and includes all required sections.
- `docs/backend/demo-debugging-guide.md` exists for operational guide split.
- No backend/frontend source code changed.
- No `.codegraph/` staged.
- No env/log/debug zip/local runtime artifacts staged.
- `git diff` limited to `docs/specs` and `docs/backend`.

Validation for this SPEC-ONLY phase:
- No full FE/BE test run required.
- Run `git diff --stat` and path check.
- Re-read markdown docs for completeness and consistency.
- Keep command outputs concise.
