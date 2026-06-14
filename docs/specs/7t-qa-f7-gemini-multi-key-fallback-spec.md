# Phase 7T-QA-F7 - Gemini Multi-Key Fallback

Status: SPEC-ONLY

Branch: `docs/7t-qa-f6-start-resume-preroll-mic-sensitivity-spec`

Date: 2026-06-11

## 1. Title / Status

Phase 7T-QA-F7 plans a backward-compatible Gemini multi-key fallback design for Audiomind analysis. This document is a spec and implementation plan only. It does not implement production code.

External docs verification completed against official Google/Gemini docs:

- Gemini API rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
- Gemini troubleshooting/errors: https://ai.google.dev/gemini-api/docs/troubleshooting
- Gemini API keys: https://ai.google.dev/gemini-api/docs/api-key
- Gemini billing/key quota relationship: https://ai.google.dev/gemini-api/docs/billing
- Google retry guidance with exponential backoff and jitter: https://docs.cloud.google.com/iam/docs/retry-strategy

Important docs finding: Gemini rate limits and billing/quota are project-scoped, not independent per API key. Multiple keys in the same Google Cloud project may share quota. F7 must be framed as resilience and failover, not quota evasion.

## 2. Problem Statement

Current Gemini analysis can fail in ways that are visible to users as missing, delayed, failed, or fallback-quality analysis:

- Quota or rate-limit errors can stop analysis during busy periods.
- Temporary Gemini service failures can make otherwise valid transcripts fail.
- Invalid, expired, blocked, or permission-limited keys can make the configured provider unusable.
- Network timeouts and transient transport failures can interrupt analysis.
- A single `GEMINI_API_KEY` creates one operational dependency with no automatic failover path.

The current single-key behavior is insufficient because ai-api has no key health model, no per-key cooldown state, no alias-safe fallback logs, and no way to continue with another configured key when one key is invalid or temporarily unavailable. The goal is to improve reliability while preserving existing analysis contracts and avoiding any behavior that looks like bypassing Google quota limits.

## 3. Current Implementation Audit

Files and symbols inspected:

| Area | File/symbol | Finding |
| ---- | ----------- | ------- |
| ai-api config | `demoRecordAUDIOMID/ai-service/app/config.py::Settings` | Current Gemini env is single-key: `gemini_api_key`, `gemini_analysis_model`, `gemini_summary_model`, `gemini_timeout_seconds`, `gemini_analysis_retry_max_attempts`, `gemini_rate_limit_retry_base_seconds`, `gemini_rate_limit_retry_max_seconds`, `gemini_retry_quota_exceeded`, `gemini_max_tokens_retry_enabled`, `gemini_max_single_request_chars`, `gemini_request_delay_seconds`. |
| analyzer factory | `demoRecordAUDIOMID/ai-service/app/services/analysis_factory.py::build_analysis_analyzer` | Builds a single `GeminiAnalyzer(api_key=settings.gemini_api_key, ...)`. If missing, raises `AnalysisConfigError`. Legacy Ollama/local analysis is blocked unless `ALLOW_LEGACY_LOCAL_AI=true`. |
| Gemini wrapper | `demoRecordAUDIOMID/ai-service/app/services/gemini_analyzer.py::GeminiAnalyzer` | Thin subclass over `AIAnalyzer`; no key manager or multi-key state. |
| Gemini HTTP call | `demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py::_call_gemini_text` | Sends `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with `x-goog-api-key: self.api_key`. Retries 429/500/502/503/504 inside one key. Uses `Retry-After` for 429 if present, otherwise configured wait. |
| Gemini error handling | `AIAnalyzer._call_gemini_text` | 401/403 raise `AnalysisConfigError`; 400 raises `AnalysisUnavailableError` and may trigger schema retry without schema; timeout/HTTP transport errors raise `AnalysisUnavailableError`; 429 quota can raise `AnalysisUnavailableError` immediately unless `gemini_retry_quota_exceeded` is true. |
| Gemini top-level batch behavior | `AIAnalyzer.analyze_meeting` | For provider `gemini`, catches `AnalysisConfigError`, `AnalysisParseError`, and `AnalysisUnavailableError`, logs safe messages, and returns `_default_structured_analysis`. This means batch may complete with fallback content instead of surfacing the provider failure. |
| realtime analyzer path | `demoRecordAUDIOMID/ai-service/app/main.py::_analyze_and_persist_realtime_transcript` | For Gemini, bypasses `analyze_meeting` and calls `analyzer._analyze_with_gemini(...)` directly. Provider exceptions surface to route-level error mapping. |
| realtime route mapping | `demoRecordAUDIOMID/ai-service/app/main.py::analyze_realtime_transcript` | `AnalysisRateLimitError` marks run `RATE_LIMITED`, logs `GEMINI_RATE_LIMITED`, returns HTTP 429. `AnalysisParseError` returns 502. `AnalysisConfigError` and `AnalysisUnavailableError` mark failed and return 503 `GEMINI_UNAVAILABLE`. |
| ai-api global error mapping | `demoRecordAUDIOMID/ai-service/app/main.py::analysis_provider_exception_handler` | `AnalysisProviderError` from Gemini generally maps to `GEMINI_UNAVAILABLE` 503, except parse errors map to `GEMINI_ANALYSIS_FAILED` 502. |
| analysis status persistence | `demoRecordAUDIOMID/ai-service/app/services/analysis_runs.py`, `main.py`, `pipeline.py` | Analysis runs track provider, model, cache identity, status, failed/rate-limited states, and metadata. `AnalysisResponse` already includes `retryAfterSeconds`. |
| batch pipeline | `demoRecordAUDIOMID/ai-service/app/pipeline.py::process_meeting` | Loads analyzer through factory, calls `self.ai_analyzer.analyze_meeting(formatted_transcript)`, saves results, and marks analysis run failed only if an exception escapes. Gemini fallback structured analysis may be saved as completed. |
| processing-api analysis GET | `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java::getAnalysisInternal` | Reads job state/analysis state, falls back to ai-service, lazily triggers realtime analysis, and preserves `retryAfterSeconds` plus `errorCode` in responses when analysis state has them. |
| processing-api lazy trigger | `ProcessingService::runLazyRealtimeAnalysis` | Calls `AIServiceClient.analyzeRealtimeTranscript`, maps `FAILED`, `COMPLETED`, `SKIPPED`, and HTTP exceptions into `JobStateStore` analysis state. |
| processing-api error mapping | `ProcessingService::mapAnalysisFailureCode`, `toAnalysisFailureException` | 503 or body/status text containing Gemini maps to `GEMINI_UNAVAILABLE`; 502 maps to `GEMINI_ANALYSIS_FAILED`. 429 is not currently distinguished as `GEMINI_RATE_LIMITED` here. |
| processing-api client | `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java` | `getAnalysis` has Spring retry/circuit breaker plus `@Retryable(maxAttempts=3, backoff=1000ms*2)`. `analyzeRealtimeTranscript` posts JSON to `/api/internal/realtime-analysis`. |
| tests | `demoRecordAUDIOMID/ai-service/tests/test_gemini_analyzer.py`, `test_analysis_factory.py`, `test_realtime_analysis_endpoint.py`; processing `ProcessingServiceTest`, `AIServiceClientTest` | Existing tests cover safe Gemini HTTP error logging, factory behavior, realtime unavailable/parse/cooldown behavior, and processing lazy-analysis state handling. No current multi-key tests. |
| deployment/env | `demoRecordAUDIOMID/ai-service/.env.example`, `infra/.env.example`, `infra/.env.production.example`, `infra/docker-compose.dev.yml`, `infra/docker-compose.mvp.yml` | Examples/compose expose single-key `GEMINI_API_KEY` and model vars. `infra/docker-compose.mvp.yml` requires `GEMINI_API_KEY`. No `GEMINI_API_KEYS` or multi-key toggles exist. |

Current logs around Gemini/analysis are mostly safe and metadata-oriented: examples include `GEMINI_ANALYSIS_REQUEST`, `GEMINI_ANALYSIS_HTTP_ERROR`, `GEMINI_QUOTA_EXCEEDED`, `GEMINI_ANALYSIS_RATE_LIMIT_RETRY`, `GEMINI_ANALYSIS_TIMEOUT`, `REALTIME_ANALYSIS_FAILED`, `ANALYSIS_CACHE_HIT`, and `ANALYSIS_CACHE_MISS`. Existing tests assert the API key and transcript are not present in a safe HTTP error preview log.

Assumptions:

- Current deployment likely uses `ANALYSIS_PROVIDER=gemini` and one `GEMINI_API_KEY`, based on config defaults and env examples.
- No real secrets were inspected.
- F6 realtime recorder/VAD/WebSocket files were not read for implementation details because F7 is backend analysis resilience and must not modify F6 behavior.

## 4. Constraints

- Do not expose API keys.
- Do not log prompts, transcripts, raw meeting content, raw Gemini responses that can contain meeting content, Authorization headers, env secrets, or API key material.
- Do not re-enable Whisper/Ollama.
- Do not change F6 realtime recorder/VAD/WebSocket behavior. F6 markers must remain intact:
  - `useVoiceActivityDetection.ts` high sensitivity around `minStartRms: 0.0035`.
  - `useRealtimeMeetingStream.ts` logs/markers `RECORDING_WS_READY` and `REALTIME_CHUNK_SEND`.
  - `useAudioRecorder.ts` has `noiseSuppressionEnabled` and `startRecording` returns `Promise<number | null>`.
  - `RealtimeDashboardScene.tsx` includes `Khử nhiễu microphone`.
  - `App.tsx` wires `selectedMicSensitivity` and `noiseSuppressionEnabled`.
- Do not change billing, admin, export, or upload validation.
- Keep the existing processing-api contract unless a minimal compatible extension is explicitly implemented.
- Multi-key is for resilience/failover, not quota evasion.
- Multiple keys in the same Google Cloud project may share quota.
- MVP must work with one key and remain backward-compatible with `GEMINI_API_KEY`.

## 5. Recommended Architecture

Add the F7 logic inside ai-api first. Processing-api should only receive cleaner metadata and should not own Gemini key selection.

Recommended components:

- `GeminiKeyManager`: parses config into key aliases and secret values, tracks in-memory key state, selects eligible key, and applies cooldown/disable decisions.
- `GeminiClient` wrapper or retry orchestrator: owns one Gemini HTTP attempt at a time, calls `GeminiKeyManager` for key selection, classifies errors, schedules backoff, and returns either parsed text or typed provider errors.
- Existing `GeminiAnalyzer` remains the public analyzer object. It should delegate HTTP generation to the wrapper so `analyze_meeting`, realtime `_analyze_with_gemini`, summary generation, and schema retry use the same key policy.

Key state model:

| Field | Purpose |
| ----- | ------- |
| `alias` | Safe human-readable key id such as `primary` or `backup1`. Logs only alias. |
| `secret` | API key value. Never logged. |
| `disabled_until_monotonic` | Short or hard cooldown deadline. |
| `last_selected_at` | Supports round-robin or least-recently-used selection. |
| `consecutive_failures` | Helps hard-cooldown repeated invalid/permission failures. |
| `last_error_code` | Safe code only, such as `RESOURCE_EXHAUSTED`, `PERMISSION_DENIED`, `UNAVAILABLE`. |
| `last_retry_after_seconds` | Derived from provider header or configured cooldown. |

MVP state:

- In-memory per ai-api process is acceptable for F7-1/F7-2.
- Use a lock around key state updates if the ai-api handles concurrent requests in-process.
- Future multi-replica production can move key state to Redis using existing Redis patterns, but this is not part of MVP unless deployment already runs multiple ai-api replicas and repeated failing keys cause operational pain.

Selection policy:

- Use round-robin among keys that are not disabled and not cooled down.
- If a request fails with retryable provider or network errors, select the next eligible key for the next attempt.
- If all keys are cooled down or disabled, fail with retryable metadata and the shortest `retryAfterSeconds`.
- Least-recently-used is also acceptable, but round-robin is simpler and deterministic for tests.

Retry/backoff:

- Use truncated exponential backoff with jitter.
- Respect `Retry-After` for 429 when present, bounded by F7 max backoff/cooldown settings.
- Apply a fail-fast deadline across all attempts and keys so one request cannot sleep for minutes when all keys are unhealthy.
- Do not retry non-retryable request/prompt errors.
- The F7 Gemini wrapper/orchestrator must own the provider retry budget. Avoid nested retry amplification.
- Existing retry logic inside `AIAnalyzer._call_gemini_text` must either move into the wrapper or be disabled/bypassed when the F7 wrapper is active.
- Do not allow `GEMINI_MAX_ATTEMPTS` multiplied by old retry attempts multiplied by number of keys. There must be one total provider-call budget per analysis request.

Concurrency safety:

- Key cooldown and selection state must be protected by a lock or equivalent synchronization because ai-api may handle concurrent analysis requests.
- MVP in-memory state is acceptable for one ai-api process.
- Redis/shared cooldown state remains future work for multi-replica ai-api deployments.

## 6. Env Config Proposal

Keep existing vars:

- `GEMINI_API_KEY`: backward-compatible single-key secret.
- `GEMINI_ANALYSIS_MODEL`: current default `gemini-2.5-flash`.
- `GEMINI_SUMMARY_MODEL`: current default `gemini-2.5-flash`.
- Existing retry/timeouts remain supported during migration.

Add F7 vars:

- `GEMINI_API_KEYS`: optional multi-key list.
- `GEMINI_MULTI_KEY_ENABLED`: default `false` for first deploy, can be true when keys are configured.
- `GEMINI_MAX_ATTEMPTS`: default should map from `GEMINI_ANALYSIS_RETRY_MAX_ATTEMPTS` or use `3`.
- `GEMINI_KEY_COOLDOWN_SECONDS`: default `90`.
- `GEMINI_KEY_HARD_COOLDOWN_SECONDS`: default `900`.
- `GEMINI_BACKOFF_BASE_MS`: default `500` or `1000`.
- `GEMINI_BACKOFF_MAX_MS`: default `10000`.
- `GEMINI_BACKOFF_JITTER`: default `true`.
- `GEMINI_FAIL_FAST_SECONDS`: default `30` for realtime/lazy path; batch may optionally use the same value first.

Attempt budget:

- `GEMINI_MAX_ATTEMPTS` is a total per-analysis request budget across all keys, not a per-key budget.
- Example: `GEMINI_MAX_ATTEMPTS=4` means at most 4 Gemini HTTP calls total for one analysis request.
- With 3 keys, attempts may be `keyA` attempt 1, `keyB` attempt 2, `keyC` attempt 3, `keyA` attempt 4 after cooldown only if eligible.
- Do not do 4 attempts per key.

Accepted `GEMINI_API_KEYS` formats:

- Prefer JSON array for production: `[{"alias":"primary","key":"..."},{"alias":"backup1","key":"..."}]`
- Support comma-separated alias/key pairs as a dev-friendly format: `primary:xxx,backup1:yyy`

Parsing rules:

- If `GEMINI_MULTI_KEY_ENABLED=false`, use `GEMINI_API_KEY` exactly as today.
- If `GEMINI_MULTI_KEY_ENABLED=true` and `GEMINI_API_KEYS` is set, parse all valid alias/key pairs.
- If `GEMINI_MULTI_KEY_ENABLED=true` and `GEMINI_API_KEYS` is missing, fall back to `GEMINI_API_KEY` as alias `primary`.
- If both are set, `GEMINI_API_KEYS` should define the active list. Optionally include `GEMINI_API_KEY` as `primary` only when `GEMINI_API_KEYS` is empty to avoid duplicate use.
- Alias is required for configured multi-key entries.
- Alias must match lowercase letters, numbers, dash, and underscore only: `^[a-z0-9_-]+$`.
- Duplicate alias is invalid.
- Duplicate key value is invalid.
- Empty key is invalid.
- If parsing fails, return or log only a safe error message. Never log invalid raw `GEMINI_API_KEYS` values.
- No real keys should be committed.

Secret-safe key model:

- The key object/dataclass must not expose key material in `repr` or logs.
- Use `repr=False` for secret fields or implement a custom safe `__repr__`.
- Never derive alias from an API key prefix or suffix.
- If an alias must be generated for a dev fallback, generate `key1`, `key2`, etc. independent of the secret value.

## 7. Error Classification and Behavior

| Provider result | Classification | Key behavior | Retry behavior | Response behavior |
| --------------- | -------------- | ------------ | -------------- | ----------------- |
| 429 `RESOURCE_EXHAUSTED` | `GEMINI_RATE_LIMITED` or `GEMINI_QUOTA_EXHAUSTED` | Put current key/project into cooldown. Use `Retry-After` if present, else `GEMINI_KEY_COOLDOWN_SECONDS`. | Try next eligible key if deadline allows. If all fail, return retryable metadata with shortest cooldown. | `retryable=true`, `provider=gemini`, `retryAfterSeconds`. |
| 500 `INTERNAL` | `GEMINI_UNAVAILABLE` | Do not hard-disable key. Optionally short cooldown after repeated failures. | Retry with backoff and maybe next key. | Retryable if exhausted. |
| 503 `UNAVAILABLE` | `GEMINI_UNAVAILABLE` | Do not hard-disable key. Optionally short cooldown after repeated failures. | Retry with backoff and maybe next key. | Retryable if exhausted. |
| 504 `DEADLINE_EXCEEDED` | `GEMINI_UNAVAILABLE` or timeout | Short cooldown only if repeated. | Limited retry until fail-fast deadline. | Retryable timeout/unavailable. |
| 403 `PERMISSION_DENIED` | `GEMINI_PERMISSION_DENIED` | Hard cooldown or disable alias. | Try next key. | If all fail, non-retryable or long retryable depending on policy; safe detail only. |
| 401 or invalid key | `GEMINI_INVALID_KEY` | Hard cooldown or disable alias. | Try next key. | If all fail, `GEMINI_UNAVAILABLE` or config-style failure with safe detail. |
| 400 `INVALID_ARGUMENT` | `GEMINI_INVALID_REQUEST` | Do not cooldown key. | Do not retry, except preserve existing schema-retry-without-schema behavior where applicable. | Non-retryable prompt/request error. |
| Network timeout | `GEMINI_UNAVAILABLE` timeout | Do not hard-disable key. | Retry/backoff until fail-fast deadline, maybe next key. | Retryable. |

Implementation note: current `AnalysisRateLimitError` exists but `_call_gemini_text` does not consistently raise it for 429. F7 should introduce a richer typed provider error or extend `AnalysisProviderError` with `error_code`, `retry_after_seconds`, and `retryable` so ai-api and processing-api can preserve canonical metadata.

## 8. Logging Plan

Safe log examples:

- `GEMINI_KEY_SELECTED alias=primary attempt=1`
- `GEMINI_CALL_FAILED alias=primary status=429 reason=RESOURCE_EXHAUSTED`
- `GEMINI_KEY_COOLDOWN alias=primary cooldownMs=90000 reason=rate_limit`
- `GEMINI_RETRY_SCHEDULED nextAlias=backup1 delayMs=1234 attempt=2`
- `GEMINI_CALL_SUCCEEDED alias=backup1 attempt=2 latencyMs=456`
- `GEMINI_ALL_KEYS_EXHAUSTED retryable=true cooldownActive=3`

Forbidden logs:

- API key values or key prefixes.
- Full prompt.
- Transcript content.
- Raw Gemini response if it includes meeting content.
- Env secrets.
- Authorization headers.
- Full request payload.

Use aliases only. If a key has no alias, derive `key1`, `key2`, etc. Do not derive aliases from key substrings.

## 9. API / Error Response Plan

Canonical ai-api metadata:

```json
{
  "error": "GEMINI_RATE_LIMITED",
  "message": "Gemini rate limit reached",
  "status": 429,
  "details": {
    "provider": "gemini",
    "retryable": true,
    "retryAfterSeconds": 90
  }
}
```

Canonical error codes:

- `GEMINI_RATE_LIMITED`
- `GEMINI_QUOTA_EXHAUSTED`
- `GEMINI_UNAVAILABLE`
- `GEMINI_INVALID_REQUEST`
- `GEMINI_INVALID_KEY`
- `GEMINI_PERMISSION_DENIED`

Compatible route behavior:

- ai-api realtime `/api/internal/realtime-analysis` should preserve `retryAfterSeconds`, `errorCode`, `provider`, and `retryable` for failed/skipped JSON responses when it returns JSON.
- For HTTP exceptions, ai-api should include only safe structured details. Do not include provider raw messages that might contain prompt excerpts.
- processing-api should keep existing response shape and pass through/add `errorCode`, `retryAfterSeconds`, `retryable`, and `provider` when present.
- If processing-api cannot parse structured details from ai-api errors yet, F7-3 can add minimal parsing from canonical error response JSON.

## 10. Implementation Slices

F7-1: ai-api config + key manager + unit tests only

- Add config fields to `Settings`.
- Add parser for `GEMINI_API_KEYS`.
- Add `GeminiKeyManager` with in-memory state, alias-safe selection, cooldown, hard cooldown, and all-keys-exhausted behavior.
- Unit-test parser and state transitions.
- No production Gemini call path change yet.
- F7-1 must not change `AIAnalyzer._call_gemini_text` call behavior.
- F7-1 must not route real Gemini HTTP calls through the new wrapper.

F7-2: integrate wrapper into analysis service + error mapping + tests

- Introduce `GeminiClient` wrapper/retry orchestrator.
- Route `AIAnalyzer._call_gemini_text` through the wrapper without changing prompts/schema behavior.
- Preserve existing schema retry and max-token retry behavior.
- Raise typed safe errors with `error_code`, `retryable`, `retryAfterSeconds`.
- Extend `test_gemini_analyzer.py` for fallback behavior and no secret/content logs.
- F7-2 is the first slice allowed to route Gemini HTTP calls through the new wrapper.

F7-3: processing-api status/error persistence if needed

- Update `mapAnalysisFailureCode` to distinguish 429/rate-limit canonical responses.
- Preserve `retryAfterSeconds` and `retryable` from ai-api.
- Add focused `ProcessingServiceTest` cases for `GEMINI_RATE_LIMITED` and all-keys-exhausted metadata.

Batch vs realtime decision gate:

- F7-1/F7-2 should preserve current batch fallback behavior unless explicitly changed.
- Realtime should keep existing `RATE_LIMITED`/`FAILED` persistence behavior and improve metadata.
- Any change to batch persistence from fallback-completed to `RATE_LIMITED`/`FAILED` should be deferred to F7-3 or documented as a separate decision before implementation.

F7-4: ops/env/docs + local/prod validation scripts

- Update `.env.example` files and compose env pass-through.
- Add docs for local and VPS env updates.
- Add safe log grep commands.
- Document rollback to single-key mode.

## 11. Test Plan

Unit tests:

- Single-key backward compatibility with only `GEMINI_API_KEY`.
- Multi-key parsing and selection.
- Duplicate alias/key validation.
- 429 cooldown on current key then next key succeeds.
- 500/503 retry with backoff and jitter.
- 403/401 hard-cooldown or disable current key then next key succeeds.
- 400 no retry and no key cooldown.
- All keys exhausted returns retryable metadata.
- Cooldown expiry makes a key eligible again.
- Jitter/backoff is clamped by max settings.
- Fail-fast deadline prevents long sleeps.
- Existing schema retry on 400 still works.
- Existing max-token retry still works.
- No key, prompt, transcript, raw response, or env secret appears in logs.
- Mock time/monotonic clock.
- Mock sleep/backoff.
- Mock random jitter.
- Do not use real Gemini calls.
- Do not use real API keys.
- No tests should require internet.

Integration tests:

- Key A returns 429, key B succeeds.
- All keys return 429 and response includes `retryAfterSeconds`.
- Invalid key then valid key succeeds.
- Timeout then success.
- Existing analysis endpoint remains compatible.
- Realtime `/api/internal/realtime-analysis` preserves failure metadata.
- Batch processing still completes with one key.

## 12. Manual Validation Plan

Use local mocks/simulation before any real Gemini calls:

- Normal one-key success.
- First key invalid, second key success.
- First key simulated 429, backup success.
- All keys simulated 429.
- 500/503 transient failure then success.
- Long prompt or timeout simulation.
- No secret logs check.
- Analysis status visible and retryable through processing-api.
- Existing F6 realtime browser test remains separate and unchanged.
- Start with mock/simulation flags or a monkeypatched Gemini client.
- Use real Gemini keys only after mock validation passes.
- Do not copy raw prompts or transcripts into test logs.

Manual safe-log checks:

```bash
rtk docker logs <ai-api-container> | rtk grep "GEMINI_KEY_"
rtk docker logs <ai-api-container> | rtk grep "GEMINI_ALL_KEYS_EXHAUSTED"
rtk docker logs <ai-api-container> | rtk grep "AIza"
```

The last command should return no real key material.

## 13. Deployment / Ops Plan

- Add keys locally in `infra/.env` or service `.env`; never commit real keys.
- Back up existing VPS env before editing, for example copy `infra/.env` to a timestamped private file outside git.
- Prefer `GEMINI_MULTI_KEY_ENABLED=false` for first deploy after code lands, then enable with one key to verify backward compatibility, then add backups.
- Update docker compose env pass-through for services that run ai-api and workers. Current likely files: `infra/docker-compose.dev.yml`, `infra/docker-compose.mvp.yml`, and env examples.
- Services likely needing rebuild/recreate: ai-api and ai worker containers that instantiate `ProcessingPipeline` or realtime analyzer. Processing-api only needs rebuild if F7-3 is implemented.
- Verify logs for alias-only key messages and absence of secrets.
- Rollback: set `GEMINI_MULTI_KEY_ENABLED=false`, keep `GEMINI_API_KEY`, recreate ai-api/worker services, and confirm analysis works with the previous single-key path.

## 14. Acceptance Criteria

- Analysis still works with only `GEMINI_API_KEY`.
- With multiple keys, fallback succeeds when the first retryable key fails.
- 429 puts the current alias into cooldown.
- 401/403 hard-cooldown or disable the current alias and tries the next key.
- All keys exhausted returns retryable metadata instead of crashing.
- `retryAfterSeconds`, `retryable`, `provider=gemini`, and safe `errorCode` are available where compatible.
- No secrets or meeting content appear in logs.
- Existing Gemini analyzer, realtime analysis, and processing-api analysis tests pass.
- F6 markers remain unchanged.
- No Whisper/Ollama fallback is re-enabled.

## 15. Non-goals

- No quota evasion.
- No Gemini provider replacement.
- No Whisper/Ollama fallback.
- No UI redesign.
- No billing/admin changes.
- No upload/export validation changes.
- No full queue system unless later evidence requires it.
- No production key values in repo.
- No Redis/shared key state in MVP unless deployment topology requires it.

## 16. Open Questions

- Are backup keys in separate Google Cloud projects or the same project?
- Should production cooldown state remain in-memory, or should it use Redis for multi-replica ai-api deployments?
- Should batch analysis continue saving default structured fallback on Gemini failure, or should it persist `RATE_LIMITED`/`FAILED` like realtime?
- Should processing-api persist `RATE_LIMITED` separately from `FAILED` for all Gemini rate-limit cases?
- Should frontend expose `retryAfterSeconds`, or reuse existing retry/not-ready behavior?
- Should admins later see key alias health without any key material?
- Should `GEMINI_RETRY_QUOTA_EXCEEDED` be deprecated once F7 has explicit rate-limit handling?

## 17. Recommended Next Step

Implement F7-1 first: config, key parsing, `GeminiKeyManager`, and unit tests only. Keep F6 browser validation separate. Do not deploy F7 until local mock validation confirms key fallback, cooldown, all-keys-exhausted metadata, and safe logs.
