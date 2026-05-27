# Phase 7D - Logging & Debuggability

## 1. Status
- SPEC-ONLY
- Branch: chore/backend-demo-logging-spec
- Date: 2026-05-27
- No implementation code in this branch

## 2. Link to previous phases
- Phase 7B already standardized health checks and readiness semantics.
- Phase 7C already standardized error bodies and traceId propagation in responses.
- Phase 7D only standardizes logging and demo debuggability.
- Out of scope for 7D: analysis reliability, idempotency/cooldown tuning, multi en+vi STT work, FE changes, and contract changes.

## 3. Current state

| Service | Current logging style | TraceId support | Main gaps |
| ------- | --------------------- | --------------- | --------- |
| processing-api | Mostly Java logger calls with key=value style messages; includes upload, queue, status, transcript fallback, and realtime analysis lifecycle logs. MDC currently carries `jobId`; request methods also pass traceId explicitly. | Yes, via `TraceIdFilter` plus downstream `X-Trace-Id` and `X-Request-ID` headers in the AI client. | Some logs still emit downstream `body={}` or raw exception messages; log keys are not fully standardized; no stable registry for upload/realtime/analysis events; no explicit `requestId` field in the Spring log context. |
| ai-api | Loguru-based structured logging with serialized output at startup and request time; logs provider selection, STT config summary, transcript/analysis lifecycle, and Redis/job state warnings. | Yes, via FastAPI middleware that reads/generates `X-Trace-Id` and `X-Request-ID`, stores them on request state, and returns both headers. | Several warnings/errors still use raw `repr(e)`; provider failures can be overly verbose; some startup/service logs are informative but not normalized to a stable event key registry; traceId/requestId are not uniformly present in every log line. |
| meeting-api | Spring logger usage is lighter; controller logs upload language and the exception layer already returns canonical errors with traceId. Security/config also resolves and emits traceId headers. | Yes, via `TraceIdFilter` and trace header echoing in security/error handlers. | No broad request lifecycle log registry; meeting lifecycle logs are not fully standardized around `meetingId`; request/error logs are sparse, so demo debugging still requires hopping between code paths. |
| user-api | Spring logger usage is minimal but present in register/login/logout and in the global exception handler. Security also writes `userId` to MDC during authenticated requests. | Yes, via `TraceIdFilter` and canonical error handling. | Auth and service logs are generic, not event-key driven, and do not consistently include traceId/requestId in the message body; user-facing operations need safer and more consistent logging keys. |
| docker/debug guide | Existing guide already has health and several grep/findstr examples for ai-api and processing-api failures. | Indirect; it assumes traceId exists but does not yet show the standard traceId/event/meetingId filters. | Missing a compact 7D-focused filter section for traceId, meetingId, event keys, analysis failures, and language/STT config across shells. |

## 4. Goals
- Logs must be easy to grep during a demo failure.
- Log keys must be stable across backend services.
- traceId/requestId must be visible across request boundaries when a request context exists.
- meetingId must appear whenever a log is about meeting, transcript, or analysis flow.
- requestedLanguage and effectiveLanguage must be present for STT-related logging where applicable.
- source must be visible for upload, realtime, and internal triggers.
- analysisStatus must be visible for analysis lifecycle logs.
- durationMs should be logged for important external or cross-service calls.
- Secrets, full transcripts, and raw provider payloads must never be exposed in logs.

## 5. Non-goals
- No business logic changes.
- No FE changes.
- No STT, Deepgram, or Gemini behavior changes.
- No analysis retry/idempotency/cooldown behavior changes.
- No API contract or response-shape changes.
- No large observability rollout such as OpenTelemetry or a new metrics stack if the repo does not already use one.

## 6. Logging contract

Target convention: stable, grep-friendly log lines with a small shared field set. The implementation can keep text logs or key=value logs, but the emitted fields should stay consistent.

Recommended fields:
- event
- traceId
- requestId
- meetingId
- source
- requestedLanguage
- effectiveLanguage
- model
- provider
- analysisStatus
- transcriptHashPrefix
- durationMs
- errorCode
- httpStatus
- path

Illustrative examples:

Java style:

```text
event=ANALYSIS_GET_RESULT traceId=... meetingId=... analysisStatus=completed durationMs=123
```

Python style:

```text
event=GEMINI_ANALYSIS_FAILED traceId=... meetingId=... provider=gemini errorCode=GEMINI_UNAVAILABLE durationMs=850
```

Implementation note:
- Fields may be emitted through plain text, structured logging, or logger context, but the 7D PR should make the chosen shape consistent within each service.

## 7. Safe logging policy

Do not log:
- API keys
- Authorization headers
- JWTs, tokens, or passwords
- secret env values
- full transcript text
- raw uploaded file contents
- raw provider payloads or full provider responses
- raw Gemini prompts
- raw Deepgram responses
- long private file paths if they may reveal user-local details

Safe to log:
- transcriptHashPrefix
- transcriptLength
- language
- model name
- provider name
- safe error code
- short sanitized error message
- durationMs
- status

## 8. Standard event key registry

Request lifecycle:
- REQUEST_RECEIVED
- REQUEST_COMPLETED
- REQUEST_FAILED

Upload / STT:
- UPLOAD_REQUEST_RECEIVED
- UPLOAD_LANGUAGE_EFFECTIVE
- BATCH_STT_EFFECTIVE_CONFIG
- UPLOAD_TRANSCRIPT_STARTED
- UPLOAD_TRANSCRIPT_COMPLETED
- UPLOAD_TRANSCRIPT_FAILED

Realtime:
- REALTIME_SESSION_STARTED
- REALTIME_STOP_RECEIVED
- REALTIME_TRANSCRIPT_FINALIZED
- REALTIME_ANALYSIS_TRIGGERED
- REALTIME_ANALYSIS_SKIPPED
- REALTIME_ANALYSIS_SAVED
- REALTIME_ANALYSIS_FAILED

Analysis:
- ANALYSIS_GET_REQUEST
- ANALYSIS_GET_RESULT
- ANALYSIS_GET_NOT_READY
- ANALYSIS_TRIGGER_REQUEST
- ANALYSIS_TRIGGER_SKIPPED
- ANALYSIS_TRIGGER_FAILED

Gemini:
- GEMINI_ANALYSIS_REQUEST
- GEMINI_ANALYSIS_RESPONSE_PARSED
- GEMINI_ANALYSIS_FALLBACK
- GEMINI_ANALYSIS_FAILED

Deepgram:
- DEEPGRAM_STT_REQUEST
- DEEPGRAM_STT_CONFIG
- DEEPGRAM_STT_COMPLETED
- DEEPGRAM_STT_FAILED

Backend dependency:
- AI_SERVICE_CALL_STARTED
- AI_SERVICE_CALL_COMPLETED
- AI_SERVICE_CALL_FAILED
- DB_OPERATION_FAILED
- REDIS_OPERATION_FAILED

Auth / error:
- AUTH_UNAUTHORIZED
- AUTH_FORBIDDEN
- ERROR_RESPONSE_SENT

## 9. Service-by-service plan

### 9.1 processing-api
Plan:
- Keep or standardize traceId into MDC if missing in any request path that still bypasses the current filter chain.
- Emit upload start, effective language, and upload completion/failure keys.
- Emit ai-service call start/completion/failure with durationMs.
- Emit analysis polling request/result/not-ready keys.
- Emit realtime stop, finalization, trigger, skip, save, and failure keys.
- Preserve skip cooldown behavior, but suppress noisy duplicate logs.
- Do not log full transcript content, raw audio payloads, or raw provider bodies.
- Avoid logging downstream response bodies except for short sanitized summaries if absolutely necessary.

### 9.2 ai-api
Plan:
- Keep middleware that preserves or generates traceId/requestId.
- Make the log context consistently include traceId and requestId.
- Log Deepgram config safely: language, model, endpointing, source, and other non-secret config only.
- Log Gemini analysis lifecycle: request started, response parsed, fallback used, failed.
- Log transcript length and hash prefix only, never the full transcript.
- Sanitize provider errors before logging them.
- Keep secrets and raw provider payloads out of logs.

### 9.3 meeting-api
Plan:
- Keep traceId propagation in the request and error path.
- Log meeting lifecycle operations with meetingId when the event is about upload, retrieval, or auth-gated access.
- Keep error-response logs minimal and safe.
- Avoid PII-heavy request dumps.

### 9.4 user-api
Plan:
- Keep traceId propagation in the request and error path.
- Log auth failures with safe reason only.
- Do not log tokens or passwords.
- Log userId only when it is needed for debugging and is already present in the authenticated context.

## 10. TraceId/requestId propagation plan

The 7C error-response work already established that error bodies should include traceId. 7D should make the same traceId visible in logs and, where practical, in downstream requests.

Spring plan:
- A request filter or interceptor should read `X-Trace-Id`, fall back to a generated value, and write it into MDC.
- Clear MDC at the end of the request.
- If the service performs downstream HTTP calls, propagate `X-Trace-Id` and, if used, `X-Request-ID`.
- Use the same traceId in logs and error responses so demo operators can correlate one request across services.

FastAPI plan:
- Middleware should read or generate traceId and requestId.
- Store both on request state and include them in the response headers.
- Keep the logger context bound to the request-scoped IDs for the whole request.
- Propagate trace headers on outbound calls when practical.

Current-state note:
- processing-api already propagates `X-Trace-Id` and `X-Request-ID` on AI-service calls.
- processing-api already propagates `X-Trace-Id` and `X-Request-ID` downstream, but `requestId` is not yet consistently written into MDC/log fields.
- meeting-api and user-api already resolve traceId in filters/error handlers.
- ai-api already binds traceId and requestId in middleware.

## 11. Docker/dev debugging guide update plan

Update `docs/backend/demo-debugging-guide.md` with a short 7D logging filter section.

Add commands for Windows CMD, PowerShell, and Git Bash that filter by:
- traceId
- meetingId
- event key
- analysis failure
- language/STT config

Suggested examples:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api | findstr /I "traceId=test-trace-123 ANALYSIS_GET_RESULT"
```

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api | Select-String -Pattern "traceId=test-trace-123|ANALYSIS_GET_RESULT"
```

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api | grep -Ei "traceId=test-trace-123|ANALYSIS_GET_RESULT"
```

Keep the section short and demo-oriented.

## 12. Test plan

This branch is spec-only, so no implementation tests should be run here. The implementation PR should target focused tests only.

Spring tests:
- traceId appears in logs or MDC if testable.
- error response still carries traceId after logging filter behavior.
- outgoing AI-service client propagates `X-Trace-Id` if that behavior is touched.

FastAPI tests:
- middleware preserves or generates traceId and requestId.
- helper logic redacts secrets.
- provider errors are sanitized before logging.

Manual validation:
- Start the stack.
- Send a request with `X-Trace-Id: test-trace-123`.
- Trigger an upload, analysis poll, or realtime stop path.
- Verify logs contain the same traceId.
- Verify secrets and full transcript text are absent from logs.

## 13. Implementation slices after this spec

- 7D-1: processing-api traceId/MDC cleanup plus upload, analysis, and realtime log keys.
- 7D-2: ai-api traceId middleware hardening plus Deepgram/Gemini safe logs.
- 7D-3: meeting-api and user-api logging parity.
- 7D-4: debug guide log filters for traceId, meetingId, event key, and language.
- 7D-5: optional cleanup of noisy or redundant log lines.

## 14. Risks and open decisions

- Should logs be plain text key=value or a more structured JSON format?
- Should outgoing HTTP clients propagate `X-Trace-Id` in the first 7D PR, or stay limited to request/log context only?
- Should meetingId be logged in user-service only when it is already part of the request context?
- Should provider failures use warn or error level when they are retryable versus terminal?
- Do we need a shared redaction helper, or is service-local sanitization enough for 7D?
- Should old log text be preserved for backward compatibility with existing grep scripts?
- Is there any risk of log spam in realtime streaming that requires a throttle beyond the existing skip guards?

## 15. Acceptance criteria for Phase 7D implementation PR

- Backend logs use stable event keys for upload, realtime, analysis, provider, and dependency flows.
- Logs include traceId/requestId when a request context exists.
- Meeting-related and analysis-related logs include meetingId when available.
- STT-related logs include requestedLanguage/effectiveLanguage/model when available.
- Provider and dependency logs do not expose secrets, raw provider payloads, or full transcripts.
- Debug guide includes commands to filter traceId, meetingId, event keys, and STT config.
- Targeted tests or manual validation pass.
- No business logic changes are introduced.
