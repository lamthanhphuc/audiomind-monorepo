# Dev Environment Guide

This guide helps new developers onboard quickly to the `audiomind-monorepo` workspace.

## 1. Prerequisites

Install the following tools before running the stack:

- Java 21
- Python 3.10+
- Node.js 20+
- Docker Desktop (with Docker Compose)
- PowerShell 7+ (recommended on Windows)

Quick checks:

```powershell
java -version
python --version
node --version
docker --version
docker compose version
pwsh -Version
```

## 2. Monorepo Structure (High-level)

- `demoRecordAUDIOMID/meeting-service` (Java, meeting metadata)
- `demoRecordAUDIOMID/processing-service` (Java, orchestration)
- `demoRecordAUDIOMID/user-service` (Java, auth/user)
- `demoRecordAUDIOMID/ai-service` (Python, AI pipeline + STT adapter)
- `demoRecordAUDIOMID/whisper-service` (Python, STT support)
- `demoRecordAUDIOMID/diarization-service` (Python, speaker diarization)
- `demoRecordAUDIOMID/ai-processing-service` (Python processing support)
- `FE-Audiomind` (React + Vite frontend)
- `packages/contracts` (OpenAPI/proto/schema contracts)

## 3. Default Local Ports

- `meeting-api`: 8081
- `processing-api`: 8082
- `user-api`: 8083
- `ai-api`: 8000
- `whisper-service`: 8011
- `diarization-service`: 8012
- `ai-processing-service`: 8010
- `frontend web`: 8080 (container) / 5173 (Vite dev)
- `postgres`: 5432
- `redis`: 6379
- `ollama`: 11434

## 4. Start Full System (Docker Compose)

From workspace root:

```powershell
docker compose -f infra/docker-compose.dev.yml up -d --build
```

Check services:

```powershell
docker compose -f infra/docker-compose.dev.yml ps
curl http://localhost:8082/health
curl http://localhost:8000/health
curl http://localhost:8083/actuator/health
```

Stop stack:

```powershell
docker compose -f infra/docker-compose.dev.yml down -v
```

## 5. Core Build/Test/Lint Commands

From workspace root:

```powershell
npm ci
npm run lint
npm run validate:schema
npm run check:openapi
npm test
```

Java services:

```powershell
cd demoRecordAUDIOMID
./mvnw -B test
```

Python services (example):

```powershell
python -m pytest demoRecordAUDIOMID/ai-service
python -m pytest demoRecordAUDIOMID/whisper-service
python -m pytest demoRecordAUDIOMID/diarization-service
```

Frontend:

```powershell
cd FE-Audiomind
npm ci
npm run test
npm run build
```

## 6. Required Environment Variables

### Local compose/dev essentials

- `JWT_SECRET` (required by Java services)
- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` (optional override)
- `OLLAMA_MODEL` (optional override)
- `HUGGINGFACE_TOKEN` (required for some diarization features)
- `DEEPGRAM_API_KEY` (required for Deepgram realtime STT path)

### E2E essentials

- `PLAYWRIGHT_REAL_BACKEND=1`
- `E2E_USERNAME`
- `E2E_PASSWORD`
- Optional: `E2E_USER_SERVICE_BASE_URL`

### FE realtime feature flag

- `VITE_REALTIME_WS_ENABLED=true|false`

## 7. Create `.env` Files

1. Copy template files when available (`.env.example` to `.env`).
2. Set runtime-only secrets locally.
3. Never commit `.env` files.

Example (PowerShell current session):

```powershell
$env:JWT_SECRET = "<your-secret>"
$env:DEEPGRAM_API_KEY = "<your-deepgram-key>"
```

## 8. Common Issues and Fixes

1. `ENVIRONMENT_BLOCKED` in E2E:
- Check `E2E_USERNAME` and `E2E_PASSWORD`.
- Run `scripts/setup-e2e-account.ps1` before Playwright.

2. AI service cannot stream realtime STT:
- Verify `DEEPGRAM_API_KEY` is set.
- Check outbound network access to Deepgram endpoint.

3. DB connection errors:
- Confirm `db` container is healthy.
- Validate `POSTGRES_*` values used by compose and services.

4. Contract drift errors in CI:
- Run `npm run generate:client` and `npm run check:openapi`.
- Commit regenerated client files if drift is expected.

5. Port conflicts:
- Stop old containers/processes using the same ports.
- Use `docker compose ... down -v` then start again.

## 9. Recommended First-day Workflow

1. Start compose stack.
2. Run lint + schema + OpenAPI checks.
3. Run Java + Python + FE tests.
4. Verify one end-to-end happy path (upload -> process -> transcript/analysis).
5. If working on realtime, enable feature flag and validate WebSocket flow.
