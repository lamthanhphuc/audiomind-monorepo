# VPS deployment guide (single-domain Docker Compose)

This guide deploys AudioMind on a single VPS using `infra/docker-compose.vps.yml`, host Nginx for TLS/path routing, and the scripts under `scripts/`.

## Prerequisites

- Ubuntu 22.04+ (or similar Linux VPS)
- Docker Engine 24+ with the Compose plugin
- Domain DNS `A`/`AAAA` record pointing at the VPS public IP
- Outbound HTTPS for Deepgram and Gemini API calls

## 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
newgrp docker
docker compose version
```

## 2. Clone and configure environment

```bash
git clone <your-repo-url> audiomind
cd audiomind
cp .env.production.example .env.production
chmod 600 .env.production
```

Edit `.env.production`:

- Set `DEPLOYMENT_MODE=vps` and `DATABASE_TLS_MODE=disable` (private Docker Postgres only).
- Set `PUBLIC_DOMAIN`, `PUBLIC_ORIGIN`, `CORS_ALLOWED_ORIGINS`, and `VITE_REALTIME_WS_BASE_URL`.
- Replace every `CHANGE_ME*` secret (Postgres, JWT, internal token, Gemini, Deepgram, Google token encryption key).
- Build `AI_DATABASE_URL` with a **URL-encoded** password (required; do not paste raw `${POSTGRES_PASSWORD}` into a Python URL):

```bash
python3 scripts/generate-vps-db-url.py \
  --user "$POSTGRES_USER" \
  --password "$POSTGRES_PASSWORD" \
  --host postgres \
  --port 5432 \
  --database "$POSTGRES_DB"
# Copy printed URL into AI_DATABASE_URL=...
```

- Keep `REDIS_HOST=redis` / `USER_REDIS_DB=3` (user-api Bucket4j + Spring Data Redis).
- Keep shared audio path `AUDIO_STORAGE_PATH=/app/uploads` and `FINAL_AUDIO_ALLOWED_ROOTS=/app/uploads`.
- Keep loopback host ports (`FRONTEND_HOST_PORT=8080`, etc.) unless you changed bindings.

Generate a 32-byte base64 encryption key:

```bash
python3 -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"
```

## 3. DNS

Create DNS records before requesting TLS:

- `your-domain.com` → VPS public IP

Wait for propagation (`dig +short your-domain.com`).

## 4. Deploy application stack

From the repo root:

```bash
chmod +x scripts/deploy-vps.sh scripts/vps-migrate.sh scripts/smoke-vps.sh scripts/backup-vps.sh
./scripts/deploy-vps.sh
```

What the deploy script does:

1. Validates Docker and required env vars via `scripts/load-compose-env.py` (no `source`/eval of the env file)
2. Builds images **once** (`SKIP_BUILD=1` skips build; `up` never uses `--build`)
3. Starts Postgres + Redis and waits for health
4. Runs `./scripts/vps-migrate.sh` (Flyway bootstrap → user → meeting → AI Alembic)
5. Starts user/meeting/processing/AI APIs, Celery worker/beat, and frontend
6. Waits for loopback health on published ports
7. Runs `./scripts/smoke-vps.sh` (`SKIP_SMOKE=1` to skip)

```bash
# Rebuild everything then start
./scripts/deploy-vps.sh

# Restart apps without rebuilding images
SKIP_BUILD=1 ./scripts/deploy-vps.sh
```

Re-run migrations only:

```bash
./scripts/vps-migrate.sh
# Windows: ./scripts/vps-migrate.ps1
```

## 5. Host Nginx (path-based same-origin routing)

Copy the example config:

```bash
sudo cp infra/nginx/audiomind-vps.conf.example /etc/nginx/sites-available/audiomind
sudo ln -sf /etc/nginx/sites-available/audiomind /etc/nginx/sites-enabled/audiomind
```

Edit `/etc/nginx/sites-available/audiomind`:

- Replace `your-domain.com`
- Confirm upstream ports match `.env.production` loopback binds

Test and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Routing summary (matches FE same-origin bases):

| Path prefix | Backend |
|-------------|---------|
| `/`, static SPA | frontend `:8080` |
| `=/auth/google/success`, `=/auth/google/error` | frontend (SPA OAuth landing) |
| `/auth/*` (callbacks/start/exchange) | user-api `:8083` |
| `/users/*` (Google/Zoom/Teams integrations) | user-api `:8083` |
| `/api/users/*`, `/api/billing/*` | user-api `:8083` |
| `/meetings*`, `/subjects*`, `/study-folders*`, `/api/v1/meetings*`, `=/api/config/upload` | meeting-api `:8081` |
| `/processing*`, `/api/v1/jobs*`, `/ws/meetings`, `/api/config/transcript-quality` | processing-api `:8082` |
| `/api/config/lexicon`, `/api/meeting*`, `/api/search*`, `/api/process*`, `/api/stt*`, `/api/upload*`, `/api/v1/stt*`, `/api/v1/process*`, broader `/api/` | ai-api `:8000` |

## 6. TLS with Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Certbot adds HTTPS and auto-renewal. Re-run `sudo nginx -t` after edits.

## 7. Firewall (UFW)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

Only Nginx should be public; Docker services bind to `127.0.0.1` via `.env.production`.

## 8. Logs and operations

```bash
docker compose --env-file .env.production -f infra/docker-compose.vps.yml ps
docker compose --env-file .env.production -f infra/docker-compose.vps.yml logs -f user-api
docker compose --env-file .env.production -f infra/docker-compose.vps.yml logs --tail=200 processing-api
```

Optional authenticated / Phase 2 smoke:

```bash
SMOKE_JWT='<access-token>' SMOKE_SUBJECT_ID='12' ./scripts/smoke-vps.sh
```

Public Nginx smoke runs automatically when `PUBLIC_ORIGIN` is a real domain (not `your-domain.com`). Skip with `SKIP_PUBLIC_SMOKE=1`.

Smoke verdict lines:

```text
VPS INFRA HEALTHY
VPS LOOPBACK APPLICATION HEALTHY
VPS PUBLIC NGINX HEALTHY   # or NOT RUN
PHASE 2 FUNCTIONAL SMOKE PASS|NOT RUN
```

## 9. Backups

```bash
./scripts/backup-vps.sh
ls -lh backups/
gzip -t backups/audiomind-postgres-*.sql.gz
```

Backups are gzip SQL dumps under `backups/` (gitignored). Schedule with cron:

```cron
0 3 * * * cd /path/to/audiomind && ./scripts/backup-vps.sh >> /var/log/audiomind-backup.log 2>&1
```

Restore (stop write traffic first; forward-only migrations do not replace restore):

```bash
gunzip -c backups/audiomind-postgres-YYYYMMDDTHHMMSSZ.sql.gz |
  docker compose --env-file .env.production -f infra/docker-compose.vps.yml exec -T postgres \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

## 10. Updates

```bash
git pull
./scripts/deploy-vps.sh
```

Migrations are forward-only. Do not downgrade Flyway/Alembic versions on production.

## 11. Rollback strategy

- **Application**: redeploy a known-good git tag/commit and rerun `./scripts/deploy-vps.sh`.
- **Database**: restore from `backups/*.sql.gz` (requires maintenance window; test on staging first).
- **Migrations**: no automatic down migration — restore DB backup if a migration must be reversed.

## 12. Readiness checklist

| Gate | Meaning |
|------|---------|
| Compose config validated | `docker compose --env-file … config` succeeds |
| Images built | `docker compose … build` succeeds |
| Local stack healthy | migrations + APIs/worker/beat/frontend up; loopback smoke pass |
| Real VPS healthy | DNS + containers healthy on the VPS |
| HTTPS functional | Certbot + public HTTPS smoke |
| Phase 2 functional smoke | `SMOKE_JWT` + `SMOKE_SUBJECT_ID` synthesis/artifacts |

## Troubleshooting

- **Migration failure**: `./scripts/vps-migrate.sh` then inspect migrate profile logs.
- **user-api Redis errors**: confirm compose sets `REDIS_HOST=redis` (not localhost).
- **AI TLS / sslmode errors on VPS**: `DEPLOYMENT_MODE=vps` + `DATABASE_TLS_MODE=disable` + host `postgres` in allowlist; managed DBs still require `sslmode=require|verify-full`.
- **AI cannot open meeting audio**: mounts must be `uploads:/app/uploads` for meeting-api, ai-api, and celery-worker.
- **502 from Nginx**: confirm loopback ports (`curl http://127.0.0.1:8080/`) and `docker compose ps`.
- **OAuth success blank / API JSON**: ensure exact `location = /auth/google/success` proxies to frontend before `/auth/`.
- **CORS errors**: `CORS_ALLOWED_ORIGINS` must exactly match browser origin.
- **WebSocket failures**: confirm `VITE_REALTIME_WS_BASE_URL` and Nginx `/ws/meetings` upgrade headers.
