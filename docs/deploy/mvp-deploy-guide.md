# MVP Deploy Guide

This guide describes the first AudioMind MVP deployment shape: one VPS, Docker
Compose, and a host-level HTTPS reverse proxy. It is intentionally small and
reversible.

## Scope

Core MVP services:

- `web`
- `meeting-api`
- `processing-api`
- `user-api`
- `ai-api`
- `celery-worker`
- `db`
- `redis`

The `legacy-offline` profile is not part of MVP deployment. Do not enable it for
the Deepgram plus Gemini default path.

## Reverse Proxy Assumption

Use a host-level reverse proxy such as Caddy or Nginx with HTTPS enabled.

Example placeholder domains:

- Frontend: `https://app.example.com`
- API gateway or API virtual host: `https://api.example.com`

The MVP compose override binds browser-facing app ports to `127.0.0.1` by
default so the host reverse proxy can reach them without exposing raw container
ports publicly.

Recommended public routing:

- `https://app.example.com` -> `127.0.0.1:8080`
- `https://api.example.com/meeting` -> `127.0.0.1:8081`
- `https://api.example.com/processing` -> `127.0.0.1:8082`
- `https://api.example.com/user` -> `127.0.0.1:8083`

Keep `db`, `redis`, `ai-api`, and `celery-worker` private. Do not publish
`ai-api` unless there is a separate protected operations workflow.

WebSocket routing must preserve upgrade headers:

- `wss://api.example.com/processing/ws/meetings` -> processing API WebSocket route

## Environment

Use `infra/.env.example` as the template for the deploy host env file.

Important values to replace:

- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `DEEPGRAM_API_KEY`
- `GEMINI_API_KEY`
- `CORS_ALLOWED_ORIGINS`
- `VITE_MEETING_API_BASE_URL`
- `VITE_PROCESSING_API_BASE_URL`
- `VITE_USER_API_BASE_URL`
- `VITE_API_BASE`
- `VITE_REALTIME_WS_BASE_URL`

For MVP, set:

```dotenv
APP_ENV=production
STT_PROVIDER=deepgram
ANALYSIS_PROVIDER=gemini
AI_PROVIDER=gemini
LOCAL_WHISPER_ENABLED=false
ALLOW_LEGACY_LOCAL_STT=false
OLLAMA_ENABLED=false
ALLOW_LEGACY_LOCAL_AI=false
CORS_ALLOWED_ORIGINS=https://app.example.com
```

The default production runtime uses Deepgram and Gemini only. It should not load
Whisper or Ollama unless the legacy local opt-in flags are deliberately enabled.

For local MVP smoke on a developer host, keep the same providers but use local
browser origins and shorter Gemini waits if quota is exhausted:

```dotenv
APP_ENV=development
CORS_ALLOWED_ORIGINS=http://localhost:8080,http://127.0.0.1:8080
GEMINI_ANALYSIS_RETRY_MAX_ATTEMPTS=1
GEMINI_RATE_LIMIT_RETRY_MAX_SECONDS=5
GEMINI_MAX_TOKENS_RETRY_ENABLED=false
```

For production, set Gemini retry and cost guards according to the deployment
policy. `GEMINI_RETRY_QUOTA_EXCEEDED=false` fails fast on quota-exceeded 429s;
`GEMINI_ANALYSIS_RETRY_MAX_ATTEMPTS`,
`GEMINI_RATE_LIMIT_RETRY_BASE_SECONDS`,
`GEMINI_RATE_LIMIT_RETRY_MAX_SECONDS`, `GEMINI_TIMEOUT_SECONDS`, and
`GEMINI_MAX_TOKENS_RETRY_ENABLED` control retry duration and max-token recovery.
Gemini cache/hash rerun policy is intentionally deferred to 7U.

`infra/docker-compose.mvp.yml` removes the production dependency on
`demoRecordAUDIOMID/ai-service/.env` for `ai-api` and `celery-worker`. Runtime
secrets should come from deploy-time Compose interpolation.

## Compose Config

The MVP override uses Docker Compose reset/override tags to remove dev-only
ports and the local AI-service `env_file`. Use a current Docker Compose v2
release before deployment.

Render and inspect config:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml config
```

Build:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml build
```

Start:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml up -d
```

Inspect service state:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml ps
```

## Health And Readiness

Container healthchecks are defined for:

- `db`: `pg_isready`
- `redis`: `redis-cli ping`
- `web`: nginx static root via `wget`
- `meeting-api`: `/ready` via `curl`
- `processing-api`: `/ready` via `curl`
- `user-api`: `/ready` via `curl`
- `ai-api`: `/ready` via Python stdlib HTTP request

The Java service images install `curl` for healthchecks. The nginx and database
images already provide the required tools. The AI image uses Python, which is
already available in the image.

Manual checks after startup:

```bash
curl -fsS https://app.example.com/
curl -fsS https://api.example.com/meeting/health
curl -fsS https://api.example.com/meeting/ready
curl -fsS https://api.example.com/processing/health
curl -fsS https://api.example.com/processing/ready
curl -fsS https://api.example.com/user/health
curl -fsS https://api.example.com/user/ready
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml exec ai-api python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/ready', timeout=4).read().decode())"
```

`/ready` should fail when required dependencies or required provider keys are
missing. `/health` should stay lightweight.

## Rollback

Before changing a running MVP deployment:

1. Back up PostgreSQL and uploads.
2. Keep the previous `infra/.env` and compose files on the host.
3. Render `docker compose config` before starting new containers.
4. Start the new version without deleting volumes.
5. Run readiness checks and the smoke checklist.

If smoke fails:

1. Restore the previous env/compose files.
2. Restart with the previous image set or previous checked-out revision.
3. Re-run `/ready` checks.
4. Restore database/uploads only if data was changed and rollback requires it.

Do not delete Docker volumes as part of routine rollback.

## Logs And Disk

Useful commands:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml logs --tail=200
docker system df
df -h
```

Avoid logging provider keys, JWTs, raw Deepgram frames, or full transcript
content during normal MVP operation.
