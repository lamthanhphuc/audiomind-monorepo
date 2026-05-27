# Phase 7C - Error Response Standardization

## 1. Status
- SPEC-ONLY
- Branch: chore/backend-error-responses-spec
- Date: 2026-05-26
- No code implementation in this branch

## 2. Link to previous phases
- Phase 7A proposed backend demo hardening, including error response standardization as a follow-up slice.
- Phase 7B already implemented health/readiness and should not be reopened here except for short references.
- Phase 7C focuses only on error response shape, error codes, and safe traceability.
- Out of scope for this phase: logging overhaul, analysis reliability, multi STT work, and FE polish.

## 3. Current state

| Service | Current error handler | Current response shape | Main gaps |
| ------- | --------------------- | ---------------------- | --------- |
| processing-api | `@RestControllerAdvice` in `GlobalExceptionHandler` plus `ResponseStatusException` from controller/service paths | JSON body is `code`, `message`, `timestamp`; `ResponseStatusException` names are passed through as `code`; no `traceId` in body | No canonical `error` field, no `status` field in body, no `path`/`details`, no safe registry for analysis/transcript pending states, and `ResponseStatusException` messages are still ad hoc |
| ai-api | FastAPI `@app.exception_handler(Exception)` only; `HTTPException` still uses FastAPI default handler unless raised locally | Mixed shapes: default `{\"detail\": ...}` for most `HTTPException` paths, custom `{\"code\", \"message\", \"trace_id\"}` only for unhandled exceptions | Mixed `detail`/`code`/`trace_id` shapes, no canonical `status` field, default 422 validation shape, and some error details still include internal request IDs or raw exception text |
| meeting-api | `@RestControllerAdvice` in `GlobalExceptionHandler` | JSON body is `code`, `message`, `timestamp` | Same missing canonical fields as processing-api, no `traceId`, and not yet aligned to the 7C registry |
| user-api | `@RestControllerAdvice` in `GlobalExceptionHandler`; validation, auth, and data-access handlers exist | JSON body is `code`, `message`, `timestamp`; `DataAccessException` maps to `503` with `DATA_ACCESS_ERROR` | No canonical `error` field, no `status` field in body, no `traceId`, validation is still `BAD_REQUEST` instead of a registry-driven code, and the current shape is not shared with other services |
| contracts/OpenAPI | `packages/contracts/error.schema.json` exists, but it is a legacy schema and not the canonical backend error contract | Legacy schema requires `code`, `message`, `retryable`; optional `http_status` and `correlation_id`; OpenAPI service specs do not yet expose a shared canonical error response component | No canonical `ApiErrorResponse`, no shared OpenAPI error response reference, generated clients do not model the target shape, and FE currently only relies on `detail`/`message` parsing |

## 4. Goals
- FE and demo operators can read backend failures quickly without hunting logs.
- Error payloads are machine-readable and stable.
- HTTP status is consistent enough to support retries and polling.
- Every backend error response includes `timestamp` and `traceId`.
- No secrets, raw stack traces, full transcripts, or long provider payloads are exposed.
- The rollout stays backward-compatible whenever possible.

## 5. Non-goals
- No health/readiness changes in this phase.
- No logging overhaul; that stays in Phase 7D.
- No analysis reliability or idempotency behavior changes; those stay in Phase 7E.
- No Deepgram multi-language work in this phase.
- No FE polish or UI redesign.
- No business logic changes.

## 6. Canonical error response contract

Target shape:

```json
{
  "error": "ANALYSIS_NOT_READY",
  "message": "Analysis is not ready yet",
  "status": 404,
  "timestamp": "2026-05-26T12:00:00Z",
  "traceId": "..."
}
```

Optional fields:

```json
{
  "path": "/processing/123/analysis",
  "details": {
    "meetingId": "123"
  }
}
```

Rules:
- `error` is a stable uppercase snake-case code.
- `message` is short, user-safe, and should not contain secrets or raw provider payloads.
- `status` is the HTTP status number repeated in the body for easy client handling.
- `timestamp` is ISO-8601 UTC.
- Every canonical error response should include `traceId` in the JSON body and also return the same value in the `X-Trace-Id` response header when possible.
- If the request has `X-Trace-Id`, preserve it.
- If `X-Trace-Id` is missing, generate one.
- `details` is optional and must stay safe. It may contain IDs or safe enums, but never tokens, passwords, API keys, or transcript text.

## 7. Error code registry

| Error code | HTTP status | Meaning | Primary service |
| ---------- | ----------- | ------- | --------------- |
| `ANALYSIS_NOT_READY` | `404` | Analysis is not ready yet | processing / ai |
| `TRANSCRIPT_NOT_READY` | `404` | Transcript is not ready yet | processing / ai |
| `RESOURCE_NOT_FOUND` | `404` | Requested resource does not exist | meeting / user / processing |
| `UNAUTHORIZED` | `401` | Authentication is missing or invalid | user / meeting |
| `FORBIDDEN` | `403` | Authenticated user cannot access the resource | user / meeting |
| `CONFLICT` | `409` | Resource state conflict or non-idempotent conflict | all |
| `AI_SERVICE_UNAVAILABLE` | `503` | ai-api is unavailable or not ready for the request | processing |
| `DATABASE_UNAVAILABLE` | `503` | Database dependency is unavailable | meeting / user / processing / ai if applicable |
| `SERVICE_UNAVAILABLE` | `503` | Generic downstream dependency unavailable when no more specific code applies | all |
| `DEEPGRAM_UNAVAILABLE` | `503` | Deepgram is unavailable or not configured for the requested path | ai |
| `GEMINI_UNAVAILABLE` | `503` | Gemini provider/config is unavailable | ai |
| `GEMINI_ANALYSIS_FAILED` | `502` | Gemini responded but analysis or parse failed safely | ai |
| `INVALID_LANGUAGE` | `400` | Language value is invalid or unsupported | processing / ai |
| `EMPTY_TRANSCRIPT` | `422` | Transcript is empty after normalization | processing / ai |
| `DUPLICATE_REQUEST_SKIPPED` | case-dependent | Duplicate request is already completed, currently running, or conflicts with a new client request | processing / ai |
| `VALIDATION_ERROR` | `400` | Request validation failed | all |
| `INTERNAL_ERROR` | `500` | Unexpected safe fallback | all |

Duplicate semantics:
- Duplicate already completed -> HTTP `200` with a success-style body that reports `status=skipped` or `status=already_exists`.
- Duplicate currently running -> HTTP `202` with `status=in_progress`.
- True conflicting client request -> HTTP `409`.

Notes:
- Keep `ANALYSIS_NOT_READY` and `TRANSCRIPT_NOT_READY` on `404` for the canonical error contract, but do not force existing polling flows to change status codes in the same rollout.
- `GEMINI_UNAVAILABLE` and `GEMINI_ANALYSIS_FAILED` should be distinguished in the target registry.
- For backward compatibility, an implementation may initially map both to `503` if current FE/demo retry behavior depends on it, but the target registry should still distinguish provider unavailability from a safe upstream bad-response failure.

## 8. HTTP status decisions to freeze

| Decision | Recommendation | Reason |
| -------- | -------------- | ------ |
| `ANALYSIS_NOT_READY` | `404` | Matches the existing not-found semantics and keeps the registry simple; existing polling behavior should be preserved until FE contract work is separate |
| `TRANSCRIPT_NOT_READY` | `404` | Same rationale as analysis pending |
| `GEMINI_UNAVAILABLE` | `503` | Best fit for provider/config unavailability and retryable demo failures |
| `GEMINI_ANALYSIS_FAILED` | `502` | Best fit for upstream response/parse failures when Gemini responds but the analysis result is not usable |
| `VALIDATION_ERROR` | `400` for Spring; `422` or `400` for FastAPI depending on compatibility | Spring validation should map to `400` with `VALIDATION_ERROR`; FastAPI `RequestValidationError` currently defaults to `422`, so Phase 7C should either keep `422` for backward compatibility while standardizing the body, or explicitly migrate to `400` only after confirming FE/client impact |
| Duplicate idempotent case | `200` / `202` / `409` | Preserve current idempotent semantics instead of collapsing them into one failure status |

Compatibility note:
- The main compatibility risk is not the body shape itself; it is changing polling endpoints from the current status-based flow to a new failure flow.
- If a caller already keys off `404` for missing analysis or transcript, the 7C implementation should keep that contract stable and only standardize the body.

## 9. Spring implementation plan

Applies to:
- processing-service
- meeting-service
- user-service

Plan:
- Introduce a small `ApiErrorResponse` DTO in each service or in a service-local shared package if one already exists.
- Add an `ErrorCode` enum only if it simplifies mapping and keeps the registry stable.
- Keep existing `@RestControllerAdvice` classes, but map exceptions into the canonical shape.
- Preserve a safe fallback for `Exception` -> `INTERNAL_ERROR`.
- Avoid raw exception messages if they may contain secrets or internal payloads.
- Resolve `traceId` from `X-Trace-Id`, then MDC/request context, then a generated fallback.
- Keep `ProblemDetail` optional. If it is used, it must still serialize to the canonical body shape.

Suggested mapping rules:
- `ResponseStatusException` -> canonical error body with the frozen status and a safe message.
- `IllegalArgumentException` and validation failures -> `VALIDATION_ERROR` or a more specific registry code if the service knows it.
- `NoSuchElementException` / not-found cases -> `ANALYSIS_NOT_READY`, `TRANSCRIPT_NOT_READY`, or `404`-mapped domain codes where appropriate.
- `DataAccessException` in user-service -> `AI_SERVICE_UNAVAILABLE` only if the dependency really is downstream availability; otherwise keep it separate as a service-local `INTERNAL_ERROR` / `SERVICE_UNAVAILABLE` mapping in implementation.

## 10. FastAPI implementation plan

Applies to ai-service.

Plan:
- Add a helper such as `build_error_response(error, message, status, request, details=None)`.
- Register handlers for:
  - `HTTPException`
  - `RequestValidationError`
  - provider/config/domain exceptions
  - generic `Exception`
- Keep the canonical shape in every branch.
- Convert FastAPI validation output into `VALIDATION_ERROR` with the frozen `400` status.
- Preserve `traceId` from `X-Trace-Id` or request state, with a fallback generator.
- Never expose stack traces, provider raw errors, or secrets in the response body.
- Keep internal logging separate from the client-facing body.

## 11. Contract/OpenAPI plan

Plan:
- Service response standardization can land before generated client changes.
- Check whether `packages/contracts` already exposes a reusable canonical error component; the current `error.schema.json` is legacy and not the target shape.
- Add a canonical `ApiErrorResponse` schema in `packages/contracts` only when implementation reaches 7C-4 or if services already expose OpenAPI components.
- Do not regenerate clients in this spec-only branch.
- If client regeneration is needed later, FE build and test are required.
- If the contract change is risky, defer full contract/client regeneration to 7I.
- Prefer backward-compatible rollout over a one-shot contract break.

## 12. FE compatibility notes

Current FE behavior:
- `FE-Audiomind/src/services/api.ts` reads error bodies by trying `detail` first, then `message`, and finally raw text.
- The FE also stores HTTP status and `traceId` from response headers.
- Most UI code surfaces `error.message` or a locally derived string rather than inspecting a nested error schema.

Implications:
- Standardizing the response body to include `message` is compatible with current FE parsing.
- Changing polling-related status codes without a coordinated FE change is the main regression risk.
- If the implementation keeps the current `404`/`200` status behavior for analysis polling, the body standardization is low risk.

## 13. Test plan

Spring tests:
- processing-service: analysis not ready -> canonical error body
- processing-service: ai-service unavailable -> canonical `503`
- processing-service: invalid language -> canonical `400` when the endpoint or service path rejects it
- processing-service: generic exception -> canonical `500`
- meeting-service and user-service: validation, not-found, and generic-error parity where handlers already exist

FastAPI tests:
- `HTTPException` -> canonical shape
- `RequestValidationError` -> canonical shape
- provider/config error -> canonical `503`
- generic exception -> canonical `500` without stack trace
- `traceId` header is propagated into the body and response header

Contract tests:
- Schema validation for `ApiErrorResponse` once the canonical schema exists

Manual checks:

```bash
curl -i http://localhost:8082/processing/999999/analysis
curl -i http://localhost:8000/api/meeting/999999/analysis
curl -i -H "X-Trace-Id: test-trace-123" http://localhost:8082/processing/999999/analysis
```

## 14. Implementation slices after this spec

- 7C-1: processing-service canonical error response
- 7C-2: ai-service canonical error response
- 7C-3: meeting-service and user-service parity
- 7C-4: contracts/OpenAPI update if needed
- 7C-5: FE compatibility smoke only if contract/client generation changes

## 15. Risks and open decisions

- Should analysis pending continue to be represented as `404`, or should a future polling contract move it to `202`?
- Should the implementation use RFC `Problem Details` or a custom canonical DTO?
- Should the canonical schema live in `packages/contracts` immediately, or should that be a follow-up after service handlers are in place?
- Should trace ID injection remain only in the existing filters/middleware, or should 7C also tighten any missing service-level propagation hooks?
- Could changing error bodies reveal latent FE assumptions about `detail` versus `message`?
- Are provider errors being logged too verbosely today even if the client response is sanitized?

## 16. Acceptance criteria for Phase 7C implementation PR

- Core backend errors return the canonical body shape.
- Stable error codes are documented and matched to the registry above.
- HTTP status decisions are consistent and explicitly frozen.
- `traceId` is present in every error response.
- No secret, raw stack trace, or full transcript is exposed in client-facing errors.
- Targeted tests pass for the touched services.
- No business logic changes are introduced.
- No logging overhaul is introduced.
- FE polling behavior remains intact.
