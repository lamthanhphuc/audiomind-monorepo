# Production VPS Deploy Guide

This is the Phase 7T-Deploy artifact path for one Ubuntu VPS, Docker Compose,
and Caddy HTTPS.

For the AWS EC2 version of this path, use
[aws-ec2-deploy-guide.md](aws-ec2-deploy-guide.md). The EC2 guide keeps the same
Compose layering and public/private service shape, with AWS-specific instance,
Security Group, Elastic IP, and cost-safety steps.

## Target Shape

Public domains:

- `app.<domain>` -> `web`
- `meeting.<domain>` -> `meeting-api`
- `processing.<domain>` -> `processing-api`
- `user.<domain>` -> `user-api`

Private services:

- `db`
- `redis`
- `ai-api`
- `celery-worker`

The production path layers these files:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml ...
```

## DNS And Firewall

1. Point these DNS records at the VPS public IP:
   - `app.<domain>`
   - `meeting.<domain>`
   - `processing.<domain>`
   - `user.<domain>`
2. Open only SSH, HTTP, and HTTPS on the VPS firewall.
3. Do not expose PostgreSQL, Redis, `ai-api`, or `celery-worker` ports publicly.

## Host Setup

Install Docker Engine, Docker Compose v2, and Caddy using the official package
instructions for the Ubuntu version on the VPS.

Confirm versions:

```bash
docker --version
docker compose version
caddy version
```

## Repository And Env

From the deployment checkout:

```bash
cd /opt/audiomind/phase3-worktree
cp infra/.env.vps.example infra/.env
```

Edit `infra/.env` on the VPS once (domain, JWT, provider keys, PayOS/OAuth as needed).
Never commit that file. Project name is `audiomind-prod` (volumes are not shared with Local).

Official bring-up (no `--profile migrate`, no manual migration step):

```bash
docker compose --env-file infra/.env \
  -f infra/docker-compose.dev.yml \
  -f infra/docker-compose.mvp.yml \
  -f infra/docker-compose.prod.yml \
  build

docker compose --env-file infra/.env \
  -f infra/docker-compose.dev.yml \
  -f infra/docker-compose.mvp.yml \
  -f infra/docker-compose.prod.yml \
  up -d
```

Optional helper: `./scripts/deploy-vps.sh`. `scripts/vps-migrate.sh` is troubleshooting only.

Render the final Compose configuration before starting anything (do not paste the
full output into tickets — it contains secrets):

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml config --quiet
```

Verify in the rendered config:

- `web`, `meeting-api`, `processing-api`, `user-api`, and `ai-api` publish only
  `127.0.0.1` host bindings.
- `db` and `redis` have no published host ports.
- `ai-api` and `celery-worker` do not use `demoRecordAUDIOMID/ai-service/.env`.
- `celery-worker.environment.CORS_ALLOWED_ORIGINS` is present and comes from
  `infra/.env`.
- Frontend build args use `https://app.<domain>`,
  `https://meeting.<domain>`, `https://processing.<domain>`, and
  `https://user.<domain>`, not localhost.

Run the audit-only production security baseline check:

```bash
bash scripts/deploy/security-check-prod.sh
```

This script reports `PASS`/`WARN`/`FAIL` findings only. It does not change the
firewall, Caddy, SSH, Compose, Docker containers, or `infra/.env`, and it does
not print the full rendered Compose config.

## Caddy

Copy [infra/Caddyfile.example](../../infra/Caddyfile.example) to the host Caddy
config and replace `example.com` plus the ACME email.

Example commands:

```bash
sudo cp infra/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Confirm Caddy listens publicly on ports 80 and 443, while Compose services stay
on loopback ports `8080`, `8081`, `8082`, and `8083`.
When the web container publishes host port `8080`, the app site must proxy to
`127.0.0.1:8080`.

## Start Or Update

Build images:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml build
```

Start services:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml up -d
```

Do not include `infra/docker-compose.prod.celery-hotfix.yml` in the production
Compose command. After this official fix is deployed, remove the old temporary
override from the VPS if it exists:

```bash
rm -f infra/docker-compose.prod.celery-hotfix.yml
```

`celery-worker` must receive `CORS_ALLOWED_ORIGINS` through the official
Compose stack.

Inspect status:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml ps
```

Follow logs without printing secrets:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml logs --tail=200
```

## Readiness Checks

Run these after Compose reports healthy containers:

```bash
curl -fsS https://app.<domain>/
curl -fsS https://meeting.<domain>/health
curl -fsS https://meeting.<domain>/ready
curl -fsS https://processing.<domain>/health
curl -fsS https://processing.<domain>/ready
curl -fsS https://user.<domain>/health
curl -fsS https://user.<domain>/ready
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml exec ai-api python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/ready', timeout=4).read().decode())"
```

Then run [production-smoke-checklist.md](production-smoke-checklist.md).

## Monitor And Cleanup

After readiness passes, use [monitor-cleanup.md](monitor-cleanup.md) for the
daily production monitor, `/opt/audiomind/ops-logs` reports, safe cleanup
dry-runs, and Docker log rotation guidance.

Start with:

```bash
bash scripts/deploy/security-check-prod.sh
bash scripts/deploy/monitor-prod.sh
bash scripts/deploy/cleanup-prod-safe.sh
```

Only run real cleanup after reviewing dry-run output and recent backups:

```bash
bash scripts/deploy/cleanup-prod-safe.sh --apply --yes
```

## Rollback Notes

Before changing a running VPS:

1. Back up PostgreSQL and uploads.
2. Keep the previous `infra/.env` and checked-out revision available.
3. Render `docker compose config`.
4. Start the new version without deleting volumes.
5. Run readiness checks and the smoke checklist.

If smoke fails, return to the previous checked-out revision and previous
`infra/.env`, then restart with the same Compose command. Do not delete Docker
volumes during routine rollback.
