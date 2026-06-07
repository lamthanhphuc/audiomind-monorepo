# 7T-Ops-A Production Drift Fix Spec

## 1. Problem Summary

Production deployment on the Vietnix VPS is currently healthy only after a
temporary server-side hotfix. The repository should encode that fix in the
official production Compose path so the next `start-prod.sh` run does not need
an extra, untracked override file.

The production MVP remains cloud-first:

- STT/transcription: Deepgram
- Analysis/summarization: Gemini
- Legacy Whisper/Ollama services: not part of the default runtime path

## 2. Production Drift Observed

### Celery worker CORS env drift

On the VPS, `celery-worker` restarted because it booted with
`APP_ENV=production` but without `CORS_ALLOWED_ORIGINS`.

Observed error:

```text
Invalid production cors_allowed_origins: localhost is not allowed
```

Temporary VPS hotfix:

```yaml
services:
  celery-worker:
    environment:
      CORS_ALLOWED_ORIGINS: ${CORS_ALLOWED_ORIGINS}
```

After running Compose with that extra file, the worker stayed up and connected
to Redis.

### Caddy app port drift

The deployed web container publishes:

```text
127.0.0.1:8080 -> 80
```

The production Caddy example already proxies the app host to
`127.0.0.1:8080`. The only targeted `3000` hit found in the deploy surface is a
development fallback in `infra/docker-compose.dev.yml` for `user-api` CORS, not
a production Caddy route.

## 3. Root Cause

`infra/docker-compose.mvp.yml` resets the `ai-api` and `celery-worker`
`env_file` entries so production values come from `infra/.env` through Compose
interpolation.

`ai-api` receives:

```yaml
CORS_ALLOWED_ORIGINS: ${CORS_ALLOWED_ORIGINS:?Set CORS_ALLOWED_ORIGINS in infra/.env}
```

`celery-worker` does not. In production, `infra/docker-compose.prod.yml` sets
`APP_ENV: production` for both `ai-api` and `celery-worker`, so the worker runs
production config validation without the CORS value that the API gets.

## 4. Target Behavior

- `bash scripts/deploy/start-prod.sh` starts the full production stack with only:

```bash
docker compose --env-file infra/.env \
  -f infra/docker-compose.dev.yml \
  -f infra/docker-compose.mvp.yml \
  -f infra/docker-compose.prod.yml \
  ...
```

- No `infra/docker-compose.prod.celery-hotfix.yml` file is needed.
- `celery-worker` receives `CORS_ALLOWED_ORIGINS` from `infra/.env` through an
  official Compose file.
- `web` stays loopback-bound on host port `8080`, and Caddy routes
  `app.audiomind.pro.vn` to `127.0.0.1:8080`.
- `db`, `redis`, `ai-api`, and `celery-worker` remain private.
- Deepgram plus Gemini remain the default production providers.
- Whisper/Ollama are not re-enabled in the default path.

## 5. Files Likely To Change In Implementation Phase

- `infra/docker-compose.mvp.yml`
  - Add `CORS_ALLOWED_ORIGINS` to the `celery-worker.environment` block, using
    the same required interpolation pattern as `ai-api`.
- `scripts/deploy/check-prod-config.sh`
  - Must validate that rendered Compose includes
    `services.celery-worker.environment.CORS_ALLOWED_ORIGINS`.
  - Must check the `celery-worker` service block specifically, not just grep
    for `CORS_ALLOWED_ORIGINS` anywhere in the full rendered config, because
    `meeting-api`, `processing-api`, `user-api`, and `ai-api` can already have
    CORS configured.
- `scripts/deploy/health-prod.sh`
  - Must report/check `celery-worker` state so `Restarting` or `Exited` cannot
    be missed by public HTTP readiness checks.
  - Prefer a non-public check that uses the same Compose file stack as
    production, such as Compose `ps` state and/or the worker health endpoint if
    reachable inside the Compose network.
- `docs/deploy/vietnix-vps-deploy-guide.md`
  - Add a note that the old VPS hotfix override should be removed after the
    official compose fix is deployed.
- `docs/deploy/production-vps-deploy-guide.md`
  - Add the same cleanup note and mention that `celery-worker` should receive
    `CORS_ALLOWED_ORIGINS` in the rendered config.
- `docs/deploy/production-smoke-checklist.md`
  - Add an explicit check that `celery-worker` is not restarting.
- `infra/Caddyfile.example`
  - No change expected from current inspection; it already routes app to
    `127.0.0.1:8080`.

## 6. Implementation Plan

1. Update official Compose.
   Add `CORS_ALLOWED_ORIGINS:
   ${CORS_ALLOWED_ORIGINS:?Set CORS_ALLOWED_ORIGINS in infra/.env}` to
   `celery-worker.environment` in `infra/docker-compose.mvp.yml`.

2. Render-check the Compose model.
   Use `docker compose config` or the existing `check-prod-config.sh` path to
   confirm the worker receives the CORS value from `infra/.env`.

3. Strengthen config validation.
   Extend `scripts/deploy/check-prod-config.sh` to fail if the rendered
   `celery-worker` environment is missing `CORS_ALLOWED_ORIGINS`. The check
   must identify `celery-worker.environment.CORS_ALLOWED_ORIGINS` specifically;
   a broad grep for `CORS_ALLOWED_ORIGINS` is insufficient because other
   services can satisfy that grep while the worker remains broken.

4. Strengthen health validation.
   Extend `scripts/deploy/health-prod.sh` to report/check worker state. It must
   fail, or warn with a clearly visible message if the chosen policy is
   non-fatal, when `celery-worker` is `Restarting` or `Exited`.

5. Confirm Caddy/docs port guidance.
   Keep `infra/Caddyfile.example` on `127.0.0.1:8080` for the app route. Update
   docs only if stale `127.0.0.1:3000` production guidance appears.

6. Document hotfix removal.
   Add post-deploy cleanup instructions for removing
   `infra/docker-compose.prod.celery-hotfix.yml` from the VPS and restarting
   with only the official Compose files.

7. Re-run script-level validation only.
   Do not run Docker build/up/deploy from a developer agent session unless a
   human explicitly approves a production operation.

8. Avoid unrelated env template edits.
   Do not modify `infra/.env.example` or real `.env` files unless the
   implementation genuinely requires it. The worktree may already contain dirty
   changes in `infra/.env.example`; treat them as user-owned.

## 7. Acceptance Criteria

- `infra/docker-compose.prod.celery-hotfix.yml` is no longer needed.
- `celery-worker` receives `CORS_ALLOWED_ORIGINS` from `infra/.env` through the
  official Compose stack.
- Rendered Compose config shows
  `celery-worker.environment.CORS_ALLOWED_ORIGINS`.
- `start-prod.sh` can start the full production stack without a hotfix Compose
  file.
- Caddy docs/examples route the web app to `127.0.0.1:8080` when the web
  container publishes host port `8080`.
- `health-prod.sh` passes.
- `health-prod.sh` fails or warns clearly if `celery-worker` is `Restarting` or
  `Exited`.
- `docker compose ps` no longer shows `celery-worker` as `Restarting`.
- Production docs include steps to remove
  `infra/docker-compose.prod.celery-hotfix.yml` from the VPS after the official
  fix is deployed.
- `ai-api`, PostgreSQL, Redis, and `celery-worker` are not public.
- The default cloud-first policy remains unchanged: Deepgram stays the STT
  default, Gemini stays the analysis default, and Whisper/Ollama stay disabled
  unless the legacy profile is explicitly opted into.

## 8. Validation Plan

Run these on the deployment host after the implementation phase. Do not run
them from an agent session unless production actions are explicitly authorized.

```bash
bash scripts/deploy/check-prod-config.sh

bash scripts/deploy/start-prod.sh

docker compose --env-file infra/.env \
  -f infra/docker-compose.dev.yml \
  -f infra/docker-compose.mvp.yml \
  -f infra/docker-compose.prod.yml \
  ps

bash scripts/deploy/health-prod.sh

docker inspect celery-worker \
  --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -Ei 'APP_ENV|CORS'

docker compose --env-file infra/.env \
  -f infra/docker-compose.dev.yml \
  -f infra/docker-compose.mvp.yml \
  -f infra/docker-compose.prod.yml \
  config \
  | grep -A30 -E '^  celery-worker:'
```

Expected worker env output includes:

```text
APP_ENV=production
CORS_ALLOWED_ORIGINS=https://app.audiomind.pro.vn
```

Expected rendered `celery-worker` config block includes:

```text
APP_ENV: production
CORS_ALLOWED_ORIGINS: https://app.audiomind.pro.vn
```

Optional rendered-config inspection:

```bash
docker compose --env-file infra/.env \
  -f infra/docker-compose.dev.yml \
  -f infra/docker-compose.mvp.yml \
  -f infra/docker-compose.prod.yml \
  config
```

Check that:

- `celery-worker.environment.CORS_ALLOWED_ORIGINS` is present.
- `celery-worker.environment.APP_ENV` is `production`.
- `web` publishes `127.0.0.1:8080:80`.
- `db`, `redis`, `ai-api`, and `celery-worker` do not publish public host
  ports.

## 9. Rollback Plan

1. Keep the previous checked-out revision and current `infra/.env` available on
   the VPS.
2. If the official Compose fix fails, return to the previous revision and
   restart with the previous known-good Compose command.
3. If urgent service restoration is needed before a repo fix lands, temporarily
   reapply the VPS hotfix override, then remove it again after the official
   fix is verified.
4. Do not delete Docker volumes during rollback.

## 10. Out Of Scope

- No Docker build/up, production deployment, SSH, Caddy reload, or browser smoke
  test in this spec phase.
- No changes to real `infra/.env` files.
- No changes to `infra/.env.example` unless the implementation phase proves
  they are required.
- No commit or push.
- No public exposure of `ai-api`, PostgreSQL, Redis, or `celery-worker`.
- No switch back to Whisper/Ollama as the default runtime path.
- No redesign of the Compose layering beyond the production drift fix.

## 11. Risks / Notes

- `check-prod-config.sh` currently validates that `CORS_ALLOWED_ORIGINS` exists
  in `infra/.env`, but not that it reaches `celery-worker` in rendered Compose.
  The implementation should validate the rendered `celery-worker` service block
  specifically.
- `health-prod.sh` currently checks public app/API readiness and private
  `ai-api /ready`; it does not explicitly check `celery-worker` health/state.
- `celery-worker` starts an internal health endpoint on `WORKER_HEALTH_PORT`
  after Celery signals worker readiness. A Compose state check still matters
  because a restarting worker may never reach that point.
- `infra/Caddyfile.example` already uses `127.0.0.1:8080` for the app route.
- A targeted `3000` search found only one deploy-surface hit:
  `infra/docker-compose.dev.yml` includes `http://localhost:3000` as a dev CORS
  fallback for `user-api`.
- The current production Compose layering already keeps the legacy offline
  services behind the `legacy-offline` profile; this phase should preserve that
  behavior.
