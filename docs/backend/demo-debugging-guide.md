# Backend Demo Debugging Guide

Purpose: quick operational guide for final backend demo validation.
Scope: Docker startup/rebuild/health/log triage for backend services and web demo surface.
Last updated: 2026-05-28
Applies to: Phase 7H-7J backend final demo

## 1. Docker startup, config, and rebuild commands

Validate compose config first:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml config
```

Check service state:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml ps
```

Build selected services:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml build processing-api ai-api meeting-api user-api web
```

Bring up selected services with force recreate:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml up -d --force-recreate processing-api ai-api meeting-api user-api web
```

Optional full stack start (when dependencies are not running yet):

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml up -d db redis ai-api celery-worker processing-api meeting-api user-api web
```

Safety note:
- Do not run destructive cleanup commands in final demo prep.
- Avoid `docker system prune -a`, volume/database deletion, or reset scripts unless explicitly approved.

## 2. Health and readiness checks

Use `/ready` for dependency readiness and `/health` for liveness.

```bash
curl -fsS http://localhost:8082/health
curl -fsS http://localhost:8082/ready
curl -fsS http://localhost:8000/health
curl -fsS http://localhost:8000/ready
curl -fsS http://localhost:8081/health
curl -fsS http://localhost:8081/ready
curl -fsS http://localhost:8083/health
curl -fsS http://localhost:8083/ready
curl -fsS http://localhost:8080
```

Expected endpoints:

| Service | URL | Expected |
| ------- | --- | -------- |
| processing-api | http://localhost:8082/health, http://localhost:8082/ready | `200` |
| ai-api | http://localhost:8000/health, http://localhost:8000/ready | `200` |
| meeting-api | http://localhost:8081/health, http://localhost:8081/ready | `200` |
| user-api | http://localhost:8083/health, http://localhost:8083/ready | `200` |
| web | http://localhost:8080 | `200` or browser opens |

If `curl` fails, check port mappings in `infra/docker-compose.dev.yml` before deeper triage.

## 3. Focused log commands

Follow logs with timestamps and bounded tail:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs -f --tail 200 --timestamps processing-api ai-api meeting-api user-api web
```

Single-service focused view:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs --tail 300 --timestamps ai-api
```

Cross-shell filtering examples:

Windows CMD:
```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs --tail 300 --timestamps processing-api ai-api | findstr /I "traceId= meetingId= ANALYSIS_ REALTIME_ANALYSIS_"
```

PowerShell:
```powershell
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs --tail 300 --timestamps processing-api ai-api | Select-String -Pattern "traceId=|meetingId=|ANALYSIS_|REALTIME_ANALYSIS_|requestedLanguage|effectiveLanguage|deepgramLanguage" -CaseSensitive:$false
```

Git Bash/Linux/macOS:
```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs --tail 300 --timestamps processing-api ai-api | grep -Ei "traceId=|meetingId=|ANALYSIS_|REALTIME_ANALYSIS_|requestedLanguage|effectiveLanguage|deepgramLanguage"
```

## 4. Troubleshooting table

| Symptom | What to check first | Useful filter keywords | Next action |
| ------- | ------------------- | ---------------------- | ----------- |
| service not ready | `docker compose ... ps`, then `/ready` for the service | `ready`, `connection refused`, `timeout` | Verify dependency order (`db`, `redis`, `ai-api`) and restart only affected services. |
| Redis down | `redis` container state and `processing-api`/`ai-api` logs | `redis`, `connection refused`, `timeout` | Bring up `redis`, then recreate dependent services if needed. |
| ai-api unreachable | `/health` + `/ready` on `ai-api`; outbound call logs from `processing-api` | `AI_SERVICE_CALL_FAILED`, `bad_gateway`, `service_unavailable` | Rebuild/recreate `ai-api`, validate env and internal DNS/service name. |
| analysis loading forever | poll `/processing/<meetingId>/analysis`; check trigger/skip/fail logs | `ANALYSIS_GET_NOT_READY`, `REALTIME_ANALYSIS_TRIGGERED`, `REALTIME_ANALYSIS_SKIPPED`, `GEMINI_ANALYSIS_FAILED` | Confirm one trigger path only; verify transcript exists and provider is reachable. |
| upload stuck | upload request logs and queue/worker logs | `UPLOAD_`, `BATCH_STT_`, `job`, `queue` | Check `celery-worker` status, Redis queue depth, and ai-api availability. |
| realtime transcript empty | realtime diagnostic events and final segment counters | `REALTIME_STT_DIAGNOSTIC_CONFIG`, `REALTIME_STT_SEGMENT_FINAL`, `finalSegmentCount`, `speechFinalCount`, `isFinalCount` | Verify mic/input flow, one clean stop, and final segment persistence. |
| multi wrong-language output | compare vi/en/multi runs and endpointing values | `requestedLanguage`, `effectiveLanguage`, `deepgramLanguage`, `endpointing` | Keep realtime `multi` experimental; prefer explicit `vi` or `en` for final demo. |
| token/API key leak check | scan logs/report snippets before sharing | `api_key`, `token`, `authorization`, `secret`, `password` | Redact immediately, rotate key if leaked, and keep only safe short identifiers. |

## 5. Quick final-demo sanity flow

1. Start selected services with force recreate.
2. Confirm `ps` and all `/ready` checks.
3. Run upload smoke (`vi`, `en`, `multi`) and verify non-empty transcript plus analysis visible.
4. Run realtime smoke (`vi`, `en`) and verify single-stop analysis behavior.
5. Treat realtime `multi` as experimental and non-default.
6. Filter logs by `traceId`, `meetingId`, `ANALYSIS_*`, `REALTIME_ANALYSIS_*`, and STT language keys.

## 6. What not to commit

- `.env`
- `debug-*`
- `*.zip`
- audio files
- logs
- `.codegraph/`

## 7. Safety warnings

- Do not paste full transcript content.
- Do not paste API key/token/password/secret values.
- Do not paste raw provider payloads.
- Use `meetingId`, `traceId`, and short hash prefixes for correlation.
