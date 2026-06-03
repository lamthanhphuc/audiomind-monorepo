# AWS EC2 Deploy Guide

This guide prepares a single-host production deployment for AudioMind on AWS
EC2 with Ubuntu 24.04, Docker Compose, and Caddy HTTPS. It is an operator guide,
not an automated deploy.

## 1. Cost Guardrail

Create an AWS Budget before launching the instance. Set a low alert threshold
for the expected test spend. After testing, stop or delete unused EC2 instances,
delete unused EBS volumes and snapshots, and release any Elastic IP that is not
associated with a running instance.

## 2. Launch EC2

Recommended instance:

- AMI: Ubuntu Server 24.04 LTS
- Instance type: `t3.medium`
- Architecture: x86_64
- Disk: 50 GB gp3
- Public IP: Elastic IP

Create and download a key pair for SSH. Store the private key outside the repo,
for example under the Windows user `.ssh` directory.

Security Group inbound rules:

- TCP 22 from your current public IP only
- TCP 80 from `0.0.0.0/0`
- TCP 443 from `0.0.0.0/0`

Do not open `5432`, `6379`, `8000`, `8081`, `8082`, or `8083` to the internet.

Allocate an Elastic IP and associate it with the EC2 instance. Use the Elastic
IP for DNS records and keep it associated while the deployment is active.

## 3. DNS

Create A records pointing at the Elastic IP:

- `app.<domain>`
- `meeting.<domain>`
- `processing.<domain>`
- `user.<domain>`

Wait for DNS propagation before validating Caddy certificate issuance.

## 4. SSH From Windows PowerShell

Restrict key permissions, then connect:

```powershell
icacls "$env:USERPROFILE\.ssh\audiomind-ec2.pem" /inheritance:r /grant:r "$env:USERNAME:R"
ssh -i "$env:USERPROFILE\.ssh\audiomind-ec2.pem" ubuntu@<elastic-ip>
```

## 5. Install Host Packages

Run these on the EC2 host:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git gnupg nano ufw
```

Install Docker Engine and the Docker Compose plugin:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Log out and back in so the Docker group applies, then verify:

```bash
docker --version
docker compose version
```

Install Caddy:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
sudo apt update
sudo apt install -y caddy
caddy version
```

Optional host firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

## 6. Clone Repo

Choose a stable deployment path:

```bash
sudo mkdir -p /opt/audiomind
sudo chown "$USER":"$USER" /opt/audiomind
cd /opt/audiomind
git clone <repo-url> phase3-worktree
cd phase3-worktree
git checkout main
```

## 7. Create Production Env

Create the real env file on the EC2 host only:

```bash
cp infra/.env.production.example infra/.env
nano infra/.env
```

Replace the example domains and every secret placeholder. Keep these services
loopback-bound:

```dotenv
WEB_BIND_ADDRESS=127.0.0.1
MEETING_API_BIND_ADDRESS=127.0.0.1
PROCESSING_API_BIND_ADDRESS=127.0.0.1
USER_API_BIND_ADDRESS=127.0.0.1
```

Confirm provider selection remains production-ready:

```dotenv
STT_PROVIDER=deepgram
ANALYSIS_PROVIDER=gemini
AI_PROVIDER=gemini
LOCAL_WHISPER_ENABLED=false
ALLOW_LEGACY_LOCAL_STT=false
OLLAMA_ENABLED=false
ALLOW_LEGACY_LOCAL_AI=false
```

Do not commit `infra/.env`.

## 8. Configure Caddy

Copy the example, then replace `example.com` and the ACME email:

```bash
sudo cp infra/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Before reloading, confirm `/etc/caddy/Caddyfile` no longer contains
`example.com`.

Caddy should proxy:

- `app.<domain>` to `127.0.0.1:8080`
- `meeting.<domain>` to `127.0.0.1:8081`
- `processing.<domain>` to `127.0.0.1:8082`
- `user.<domain>` to `127.0.0.1:8083`

## 9. Compose Config, Build, And Start

Render config first:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml config
```

Verify the rendered config:

- `web`, `meeting-api`, `processing-api`, and `user-api` publish only
  `127.0.0.1` host bindings.
- `db`, `redis`, `ai-api`, and `celery-worker` do not publish host ports.
- `ai-api` and `celery-worker` do not load
  `demoRecordAUDIOMID/ai-service/.env`.

Build and start:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml build
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml up -d
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml ps
```

## 10. Health And Ready Checks

Public checks:

```bash
curl -fsS https://app.<domain>/
curl -fsS https://meeting.<domain>/health
curl -fsS https://meeting.<domain>/ready
curl -fsS https://processing.<domain>/health
curl -fsS https://processing.<domain>/ready
curl -fsS https://user.<domain>/health
curl -fsS https://user.<domain>/ready
```

Private ai-api ready check:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml exec ai-api python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/ready', timeout=4).read().decode())"
```

Then run [production-smoke-checklist.md](production-smoke-checklist.md).

You can also use:

```bash
DOMAIN_ROOT=<domain> bash scripts/deploy/health-prod.sh
```

## 11. Back Up Postgres

Create a compressed custom-format Postgres dump:

```bash
bash scripts/deploy/backup-postgres.sh
```

Store important backups outside the repository checkout.

## 12. Collect Redacted Logs

Collect logs through the redaction helper:

```bash
bash scripts/deploy/collect-prod-logs-redacted.sh
```

By default, generated redacted logs are written outside the repository checkout
under `../audiomind-logs`. Review the redacted file before sharing it. Do not
share raw provider keys, JWTs, database passwords, bearer tokens, or unredacted
request payloads.

## 13. Rollback

Before an update:

1. Run a Postgres backup.
2. Record the current Git revision.
3. Keep a copy of the working `infra/.env` on the server.
4. Render Compose config for the new revision before starting it.

If smoke checks fail:

```bash
git checkout <previous-known-good-revision>
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml up -d --build
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml ps
```

Do not delete Docker volumes during routine rollback.
