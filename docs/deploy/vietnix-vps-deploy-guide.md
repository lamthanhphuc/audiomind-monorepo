# Vietnix VPS Deploy Guide

This guide prepares the AudioMind MVP for one Vietnix Ubuntu VPS using Docker
Compose production files, host Caddy HTTPS, Deepgram STT, Gemini analysis,
PostgreSQL, and Redis.

## VPS Recommendation

- Minimum: 2 vCPU, 4 GB RAM, 40 GB disk.
- Recommended: 4 vCPU, 8 GB RAM.
- Current choice: Vietnix VPS CHEAP 3, 4 CPU, 4 GB RAM, 40 GB SSD. This is
  acceptable for MVP and small smoke/load testing, but monitor RAM and container
  restarts during Vietnamese audio uploads.
- OS: Ubuntu 24.04 LTS.

The production MVP is cloud-first. Do not enable the legacy offline Whisper or
Ollama profile on the Vietnix VPS.

## Vietnix Panel Steps

1. Buy a Vietnix VPS that meets the sizing above.
2. Choose Ubuntu 24.04 LTS during provisioning.
3. Keep paid backup optional/off if you want to minimize initial cost.
4. Record the public IPv4 address and initial root access details.
5. In the Vietnix firewall/security panel, allow only:
   - `22/tcp` for SSH.
   - `80/tcp` for Caddy HTTP validation and redirects.
   - `443/tcp` for HTTPS.
6. Do not open PostgreSQL, Redis, `ai-api`, or Celery worker ports.

## DNS

Create A records pointing to the VPS public IP:

- `app.audiomind.pro.vn`
- `meeting.audiomind.pro.vn`
- `processing.audiomind.pro.vn`
- `user.audiomind.pro.vn`

Wait for DNS propagation before requesting Caddy certificates. A quick check
from your workstation is:

```bash
dig +short app.audiomind.pro.vn
dig +short meeting.audiomind.pro.vn
dig +short processing.audiomind.pro.vn
dig +short user.audiomind.pro.vn
```

## Server Setup

SSH to the VPS as root, then create a deploy user:

```bash
adduser deploy
usermod -aG sudo deploy
```

Install Docker Engine, Docker Compose v2, and Caddy using the official Ubuntu
packages. Confirm they are available:

```bash
docker --version
docker compose version
caddy version
```

Allow the deploy user to run Docker, then reconnect as that user:

```bash
usermod -aG docker deploy
su - deploy
```

Clone the repository as the deploy user:

```bash
sudo mkdir -p /opt/audiomind
sudo chown deploy:deploy /opt/audiomind
cd /opt/audiomind
git clone <repo-url> phase3-worktree
cd phase3-worktree
```

Create the production env file on the VPS only:

```bash
cp infra/.env.production.example infra/.env
nano infra/.env
```

Set at least:

- `DOMAIN_ROOT=audiomind.pro.vn`
- `APP_DOMAIN=app.audiomind.pro.vn`
- `MEETING_DOMAIN=meeting.audiomind.pro.vn`
- `PROCESSING_DOMAIN=processing.audiomind.pro.vn`
- `USER_DOMAIN=user.audiomind.pro.vn`
- `CORS_ALLOWED_ORIGINS=https://app.audiomind.pro.vn`
- `POSTGRES_PASSWORD=<strong random password>`
- `JWT_SECRET=<long random secret>`
- `DEEPGRAM_API_KEY=<Deepgram key>`
- `GEMINI_API_KEY=<Gemini key>`
- `VITE_MEETING_API_BASE_URL=https://meeting.audiomind.pro.vn`
- `VITE_PROCESSING_API_BASE_URL=https://processing.audiomind.pro.vn`
- `VITE_USER_API_BASE_URL=https://user.audiomind.pro.vn`
- `VITE_API_BASE=https://processing.audiomind.pro.vn`
- `VITE_REALTIME_WS_BASE_URL=wss://processing.audiomind.pro.vn/ws/meetings`

`DOMAIN_ROOT` is useful for humans and deploy scripts, but keep runtime/public
URL values literal in `infra/.env`; do not rely on nested shell-style expansion
such as `${APP_DOMAIN}` inside values consumed by Docker Compose or the app.

Keep these loopback values unchanged so Caddy is the only public entry point:

```dotenv
WEB_BIND_ADDRESS=127.0.0.1
MEETING_API_BIND_ADDRESS=127.0.0.1
PROCESSING_API_BIND_ADDRESS=127.0.0.1
USER_API_BIND_ADDRESS=127.0.0.1
```

Install Caddy config:

```bash
sudo cp infra/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Replace `example.com` and `admin@example.com` before reload.
For this deployment, the four Caddy sites should become:

- `app.audiomind.pro.vn`
- `meeting.audiomind.pro.vn`
- `processing.audiomind.pro.vn`
- `user.audiomind.pro.vn`

Run the production checks and startup scripts:

```bash
bash scripts/deploy/check-prod-config.sh
bash scripts/deploy/security-check-prod.sh
bash scripts/deploy/start-prod.sh
bash scripts/deploy/health-prod.sh
```

`security-check-prod.sh` is audit-only. It reports baseline security findings
without changing UFW, Caddy, SSH, Compose, Docker containers, or `infra/.env`,
and it avoids printing the full rendered Compose config because that can contain
secrets.

After the stack is healthy, use
[monitor-cleanup.md](monitor-cleanup.md) for daily resource checks, Docker log
rotation guidance, and safe dry-run-first cleanup.

After deploying the official production drift fix, remove the old temporary
Celery CORS override from the VPS if it exists:

```bash
rm -f infra/docker-compose.prod.celery-hotfix.yml
```

`start-prod.sh` uses only the official production Compose files. Do not include
the old hotfix override when restarting; `celery-worker` must receive
`CORS_ALLOWED_ORIGINS` from `infra/.env` through
`infra/docker-compose.mvp.yml`.

## Smoke Test

After health checks pass:

- Open `https://app.audiomind.pro.vn`.
- Register or log in.
- Upload a Vietnamese audio file.
- Confirm transcript text appears.
- Confirm Gemini analysis appears.
- Open meeting history and confirm the meeting is listed.
- Use re-analyze on the meeting and confirm it completes.
- Export the DOCX report.

## Troubleshooting

Collect redacted logs:

```bash
bash scripts/deploy/collect-prod-logs-redacted.sh
```

Run the production monitor for disk, RAM, Docker usage, container restarts, and
health status:

```bash
bash scripts/deploy/security-check-prod.sh
bash scripts/deploy/monitor-prod.sh
```

Use [monitor-cleanup.md](monitor-cleanup.md) before applying cleanup. Do not run
cleanup if dry-run output is surprising.

Common issues:

- DNS: A records still point somewhere else. Recheck `dig +short`.
- HTTPS: ports `80` or `443` are blocked, or Caddyfile domains still use
  `example.com`.
- Caddy: when the web container publishes host port `8080`, the app route must
  proxy to `127.0.0.1:8080`.
- Docker: the deploy user is not in the Docker group, or Docker Compose v2 is
  missing.
- Env: `infra/.env` still contains placeholders, localhost production URLs, or
  missing Deepgram/Gemini keys.
- CORS: `CORS_ALLOWED_ORIGINS` does not resolve to
  `https://app.audiomind.pro.vn`.
- Celery: `docker compose ps` must not show `celery-worker` as `Restarting` or
  `Exited`; rendered Compose must include
  `celery-worker.environment.CORS_ALLOWED_ORIGINS`.
- RAM: on VPS CHEAP 3, watch `docker compose ps`, container restarts, and memory
  usage during upload/transcript/analysis tests. Upgrade to 8 GB RAM if memory
  pressure causes restarts.
- Logs: use `bash scripts/deploy/collect-prod-logs-redacted.sh` before sharing
  failure output.

## Security

- Do not expose PostgreSQL or Redis to the internet.
- Do not expose `ai-api` or `celery-worker` publicly.
- Do not commit `infra/.env` or any real `.env` file.
- Use strong unique values for `POSTGRES_PASSWORD` and `JWT_SECRET`.
- Keep `STT_PROVIDER=deepgram`, `ANALYSIS_PROVIDER=gemini`,
  `LOCAL_WHISPER_ENABLED=false`, and `OLLAMA_ENABLED=false` for this MVP path.
