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

- Set `PUBLIC_DOMAIN`, `PUBLIC_ORIGIN`, `CORS_ALLOWED_ORIGINS`, and `VITE_REALTIME_WS_BASE_URL` to your domain.
- Replace every `CHANGE_ME*` secret (Postgres, JWT, internal token, Gemini, Deepgram, Google token encryption key).
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

1. Validates Docker and required env vars (no secret values logged)
2. Builds images (`SKIP_BUILD=1` to skip)
3. Starts Postgres + Redis and waits for health
4. Runs `./scripts/vps-migrate.sh` (Flyway bootstrap → user → meeting → AI migrations)
5. Starts user/meeting/processing/AI APIs, Celery worker/beat, and frontend
6. Waits for loopback health on published ports
7. Runs `./scripts/smoke-vps.sh` (`SKIP_SMOKE=1` to skip)

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
| `/auth/*`, `/api/users/*`, `/api/billing/*` | user-api `:8083` |
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

Optional authenticated smoke (JWT already issued):

```bash
SMOKE_JWT='<access-token>' ./scripts/smoke-vps.sh
```

## 9. Backups

```bash
./scripts/backup-vps.sh
ls -lh backups/
```

Backups are gzip SQL dumps under `backups/` (gitignored). Schedule with cron:

```cron
0 3 * * * cd /path/to/audiomind && ./scripts/backup-vps.sh >> /var/log/audiomind-backup.log 2>&1
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
| Code complete | Scripts, env template, Nginx example, FE same-origin sentinel merged |
| Compose validated | `docker compose config` + local `deploy-vps.sh` on a machine with Docker |
| Local smoke | `smoke-vps.sh` passes loopback checks |
| Real VPS | DNS + Nginx + Certbot + public browser login/recording verified manually |

## Troubleshooting

- **Migration failure**: `./scripts/vps-migrate.sh` then inspect `user-db-migrate` / `meeting-db-migrate` / `ai-db-migrate` logs.
- **502 from Nginx**: confirm loopback ports (`curl http://127.0.0.1:8080/`) and `docker compose ps`.
- **CORS errors**: `CORS_ALLOWED_ORIGINS` must exactly match browser origin (`https://your-domain.com`).
- **WebSocket failures**: confirm `VITE_REALTIME_WS_BASE_URL=wss://your-domain.com/ws/meetings` and Nginx `/ws/meetings` upgrade headers.
