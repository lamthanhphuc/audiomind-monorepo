# Beta Ops — VPS Overlay

Production path: Docker Compose on Vietnix VPS.

## Stack invocation

```bash
docker compose --env-file infra/.env \
  -f infra/docker-compose.dev.yml \
  -f infra/docker-compose.mvp.yml \
  -f infra/docker-compose.prod.yml
```

## Deploy and health

```bash
bash scripts/deploy/start-prod.sh
bash scripts/deploy/health-prod.sh
bash scripts/deploy/monitor-prod.sh
```

### health-prod.sh expectations

- Public HTTPS: `app`, `meeting`, `processing`, `user` — `/health` and `/ready` return JSON with `status=UP`
- Private `ai-api`: `/ready` via `compose exec`
- `celery-worker`: container running; sidecar `http://127.0.0.1:8080/health` inside container

### Celery verify (7T-Ops-A)

```bash
docker compose ... exec celery-worker \
  python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8080/health').read())"
```

## Logging and debug

```bash
docker compose logs processing-api meeting-api user-api ai-api 2>&1 | grep 'traceId=<id>'
bash scripts/deploy/collect-prod-logs-redacted.sh
bash scripts/ci/log-bundle.sh --profile BETA_OPS --since 1h
```

## OTEL on VPS

**Default:** OTEL disabled — no Jaeger required.

```bash
OTEL_SDK_DISABLED=true
OTEL_ENABLED=false
```

**Optional debug session** (profile `observability`):

```bash
docker compose ... --profile observability up -d jaeger
# Rebuild ai-api with OTEL deps: docker build --build-arg INSTALL_OTEL=true ...
# Set OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318 on core services
```

## Optional cron (7T-Ops-B/C)

- `scripts/deploy/backup-prod.sh` — manual or cron
- `scripts/deploy/monitor-prod.sh` — daily resource check
- `scripts/deploy/cleanup-prod-safe.sh` — after backup + health pass

## Rollback

```bash
git checkout <previous-tag>
bash scripts/deploy/start-prod.sh
bash scripts/deploy/health-prod.sh
```
