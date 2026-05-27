# Backend Demo Debugging Guide

Purpose: quick operational guide for Phase 7B-7D demo hardening validation.
Scope: docker startup/rebuild/health/log triage for backend services only.
Last updated: 2026-05-27
Applies to: Phase 7B-7D backend demo hardening

## 1. Start and rebuild commands

Start stack:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml up -d
```

Rebuild selected services:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml build web ai-api processing-api
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml up -d --force-recreate web ai-api processing-api
```

Check service status:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml ps
```

## 2. Health and readiness checks

Core checks:

```bash
curl -fsS http://localhost:8082/health
curl -fsS http://localhost:8082/ready
curl -fsS http://localhost:8000/health
curl -fsS http://localhost:8000/ready
curl -fsS http://localhost:8081/health
curl -fsS http://localhost:8081/ready
curl -fsS http://localhost:8083/health
curl -fsS http://localhost:8083/ready
```

If any check fails, inspect logs for that service first, then dependency chain (`db`, `redis`, `ai-api`).

Phase 7C note:
- When a backend call fails, read `error`, `message`, `status`, and `traceId` first.
- `traceId` should also match the `X-Trace-Id` response header when present.
- `path` and `details` are optional and should stay safe if they are present.
- Ignore raw stack traces or provider payloads in client-facing responses; those belong in logs only.

Port note:
- If `curl` fails, confirm host port mappings in `infra/docker-compose.dev.yml` first; container ports and host-exposed ports may differ.

Phase 7B note:
- After Phase 7B, `/ready` is the primary endpoint for dependency readiness checks.
- `/health` only checks that the app is alive.
- If Docker healthcheck fails, verify the command available inside the container first (`curl`, `wget`, or another lightweight option).

## 3. Focused log commands

Tail logs for primary backend path:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs -f processing-api ai-api meeting-api user-api
```

Cross-shell filter alternatives (use the same keyword pattern per case):

Windows CMD:
```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs ai-api | findstr /I "keyword1 keyword2"
```

PowerShell:
```powershell
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs ai-api | Select-String -Pattern "keyword1|keyword2" -CaseSensitive:$false
```

Git Bash/Linux/macOS:
```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs ai-api | grep -Ei "keyword1|keyword2"
```

### 3.1 ai-api 503
```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs ai-api | findstr /I "503 unavailable analysis service"
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs ai-api | Select-String -Pattern "503|unavailable|analysis service" -CaseSensitive:$false
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs ai-api | grep -Ei "503|unavailable|analysis service"
```

### 3.2 Deepgram key missing
```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs ai-api | findstr /I "deepgram api_key unavailable"
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs ai-api | Select-String -Pattern "deepgram|api_key|unavailable" -CaseSensitive:$false
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs ai-api | grep -Ei "deepgram|api_key|unavailable"
```

### 3.3 Gemini key missing
```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs ai-api | findstr /I "gemini api_key analysis_provider"
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs ai-api | Select-String -Pattern "gemini|api_key|analysis_provider" -CaseSensitive:$false
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs ai-api | grep -Ei "gemini|api_key|analysis_provider"
```

### 3.4 Redis down symptoms
```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api user-api | findstr /I "redis connection refused timeout"
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api user-api | Select-String -Pattern "redis|connection refused|timeout" -CaseSensitive:$false
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api user-api | grep -Ei "redis|connection refused|timeout"
```

### 3.5 processing-api cannot reach ai-api
```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api | findstr /I "ai-service failed bad_gateway service_unavailable"
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api | Select-String -Pattern "ai-service|failed|bad_gateway|service_unavailable" -CaseSensitive:$false
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api | grep -Ei "ai-service|failed|bad_gateway|service_unavailable"
```

### 3.6 realtime analysis not triggered
```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api | findstr /I "REALTIME_ANALYSIS_TRIGGERED REALTIME_ANALYSIS_SKIPPED REALTIME_ANALYSIS_FAILED"
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api | Select-String -Pattern "REALTIME_ANALYSIS_TRIGGERED|REALTIME_ANALYSIS_SKIPPED|REALTIME_ANALYSIS_FAILED" -CaseSensitive:$false
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api | grep -Ei "REALTIME_ANALYSIS_TRIGGERED|REALTIME_ANALYSIS_SKIPPED|REALTIME_ANALYSIS_FAILED"
```

### 3.7 analysis poll 404
```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api | findstr /I "analysis 404 not found ANALYSIS_NOT_READY"
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api | Select-String -Pattern "analysis|404|not found|ANALYSIS_NOT_READY" -CaseSensitive:$false
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api | grep -Ei "analysis|404|not found|ANALYSIS_NOT_READY"
```

## 4. Realtime path quick checks

1. Start realtime session and send chunks.
2. Send one `stream.stop`.
3. Verify logs show one finalization path and no duplicate trigger spam.
4. Call analysis polling endpoint before/after ready and verify transition behavior.

Expected key logs to inspect:
- `REALTIME_ANALYSIS_TRIGGER_ATTEMPT`
- `REALTIME_ANALYSIS_ENQUEUED`
- `REALTIME_ANALYSIS_TRIGGERED`
- `REALTIME_ANALYSIS_SKIPPED`
- `REALTIME_ANALYSIS_SAVED`
- `REALTIME_ANALYSIS_FAILED`

## 5. Upload path quick checks

1. Upload audio and start processing with explicit language (`vi`, `en`, `multi`).
2. Confirm effective language in logs.
3. Poll transcript and analysis until terminal state.
4. Ensure duplicate upload does not trigger duplicate processing for same idempotency key.

## 6. Safety notes

- Never put real API keys, passwords, or tokens into logs/docs.
- Do not copy/paste full transcript content into logs or issue comments.
- Use short hash prefixes and meeting IDs for correlation.

## 7. Suggested troubleshooting order

1. `docker compose ps` for container state.
2. `/health` and `/ready` checks for processing-api and ai-api.
3. dependency services (`db`, `redis`) health.
4. processing-api -> ai-api connectivity/logs.
5. ai-api provider config availability (Deepgram/Gemini non-secret indicators).
6. realtime and analysis guard logs for duplicate/cooldown behavior.

## 8. Logging filters

Use these patterns when you need fast demo triage on Phase 7D logging.

traceId:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api meeting-api user-api | findstr /I "traceId=test-trace-123"
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api meeting-api user-api | Select-String -Pattern "traceId=test-trace-123" -CaseSensitive:$false
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api meeting-api user-api | grep -Ei "traceId=test-trace-123"
```

meetingId:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api meeting-api | findstr /I "meetingId=123"
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api meeting-api | Select-String -Pattern "meetingId=123" -CaseSensitive:$false
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api meeting-api | grep -Ei "meetingId=123"
```

event key:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api meeting-api user-api | findstr /I "ANALYSIS_GET_RESULT REALTIME_ANALYSIS_FAILED UPLOAD_TRANSCRIPT_COMPLETED"
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api meeting-api user-api | Select-String -Pattern "ANALYSIS_GET_RESULT|REALTIME_ANALYSIS_FAILED|UPLOAD_TRANSCRIPT_COMPLETED" -CaseSensitive:$false
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api meeting-api user-api | grep -Ei "ANALYSIS_GET_RESULT|REALTIME_ANALYSIS_FAILED|UPLOAD_TRANSCRIPT_COMPLETED"
```

analysis failure:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api | findstr /I "ANALYSIS_TRIGGER_FAILED GEMINI_ANALYSIS_FAILED REALTIME_ANALYSIS_FAILED"
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api | Select-String -Pattern "ANALYSIS_TRIGGER_FAILED|GEMINI_ANALYSIS_FAILED|REALTIME_ANALYSIS_FAILED" -CaseSensitive:$false
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api | grep -Ei "ANALYSIS_TRIGGER_FAILED|GEMINI_ANALYSIS_FAILED|REALTIME_ANALYSIS_FAILED"
```

language / STT config:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api meeting-api | findstr /I "UPLOAD_LANGUAGE_EFFECTIVE BATCH_STT_EFFECTIVE_CONFIG DEEPGRAM_STT_CONFIG"
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api meeting-api | Select-String -Pattern "UPLOAD_LANGUAGE_EFFECTIVE|BATCH_STT_EFFECTIVE_CONFIG|DEEPGRAM_STT_CONFIG" -CaseSensitive:$false
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api meeting-api | grep -Ei "UPLOAD_LANGUAGE_EFFECTIVE|BATCH_STT_EFFECTIVE_CONFIG|DEEPGRAM_STT_CONFIG"
```
