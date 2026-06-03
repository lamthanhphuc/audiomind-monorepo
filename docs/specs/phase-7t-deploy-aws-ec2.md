# Phase 7T Deploy AWS EC2 Spec

## Goal

Prepare the production deploy specification and operator artifacts for running
AudioMind on a single AWS EC2 Ubuntu host with Docker Compose and Caddy HTTPS.
This phase prepares docs, templates, and helper scripts only. It does not deploy
to AWS, run Docker, or change runtime application behavior.

## Target Architecture

AudioMind runs on one EC2 instance. Docker Compose starts the frontend, public
APIs, private stateful services, AI API, and Celery worker. Caddy runs on the
host and terminates HTTPS for the public subdomains, then proxies to loopback
ports exposed by Compose.

Recommended EC2 configuration:

- AMI: Ubuntu Server 24.04 LTS
- Instance type: `t3.medium`
- Architecture: x86_64
- Disk: 50 GB gp3
- Public IP: Elastic IP associated with the instance

## Security Group

Inbound rules:

- TCP 22 from the operator's current IP only
- TCP 80 from `0.0.0.0/0` for HTTP to HTTPS issuance/redirects
- TCP 443 from `0.0.0.0/0` for HTTPS traffic

Do not open these ports to the internet:

- `5432` Postgres
- `6379` Redis
- `8000` ai-api
- `8081` meeting-api
- `8082` processing-api
- `8083` user-api

## Public And Private Service Map

Public routes:

- `https://app.<domain>` -> `web`
- `https://meeting.<domain>` -> `meeting-api`
- `https://processing.<domain>` -> `processing-api`
- `https://user.<domain>` -> `user-api`

Private services:

- `db`
- `redis`
- `ai-api`
- `celery-worker`

The private services must stay on the Docker network only. The public services
must bind host ports to `127.0.0.1` so Caddy is the only public entry point.

## DNS Requirements

Create A records that point to the EC2 Elastic IP:

- `app.<domain>`
- `meeting.<domain>`
- `processing.<domain>`
- `user.<domain>`

Wait for DNS propagation before expecting Caddy to issue certificates.

## Env And Secrets Policy

- Use `infra/.env.production.example` as the production template.
- Create the real `infra/.env` on the EC2 host only.
- Do not commit `infra/.env`, `.env`, `.env.production`, or provider keys.
- Replace placeholders for `POSTGRES_PASSWORD`, `JWT_SECRET`,
  `DEEPGRAM_API_KEY`, and `GEMINI_API_KEY`.
- Keep `STT_PROVIDER=deepgram`, `ANALYSIS_PROVIDER=gemini`, and
  `AI_PROVIDER=gemini`.
- Keep local fallback providers disabled in production:
  `LOCAL_WHISPER_ENABLED=false`, `ALLOW_LEGACY_LOCAL_STT=false`,
  `OLLAMA_ENABLED=false`, and `ALLOW_LEGACY_LOCAL_AI=false`.

## Caddy HTTPS Approach

Use `infra/Caddyfile.example` as the starting point, replace `example.com` and
the ACME email, validate it with Caddy, then reload Caddy. Caddy listens on
ports 80 and 443 and proxies to `127.0.0.1:8080`, `127.0.0.1:8081`,
`127.0.0.1:8082`, and `127.0.0.1:8083`.

## Smoke Checklist

After DNS, Caddy, Compose config, build, startup, and container health checks
succeed, run:

- `docs/deploy/production-smoke-checklist.md`
- Public `/health` and `/ready` checks for meeting, processing, and user APIs
- Private ai-api `/ready` check from inside the Compose network
- Provider checks for Deepgram STT and Gemini analysis
- Log checks confirming no `Loading Whisper model` entry

## Rollback And Backup

Before an update, back up Postgres and keep the previous Git revision plus the
previous `infra/.env`. If smoke checks fail, return to the previous revision and
previous `infra/.env`, then restart the stack without deleting volumes.

Backups should be stored outside the repository checkout and copied to durable
storage when the deployment becomes important.

## Cost Safety

- Create an AWS Budget before launching test infrastructure.
- Release the Elastic IP if it is no longer associated with a running instance.
- Stop or delete unused EC2 instances when testing is complete.
- Review EBS volumes and snapshots so old deploy tests do not keep billing.

## Out Of Scope

- ECS
- RDS
- ElastiCache
- S3 migration
- 7U cache
- 7V search
- 7W paragraph
