# Monitor And Cleanup

This runbook covers the MVP production monitor and safe cleanup flow for the
single-VPS Docker Compose deployment.

Production remains cloud-first:

- STT/transcription: Deepgram
- Analysis/summarization: Gemini
- Legacy Whisper/Ollama: not part of the default runtime path

Do not enable the `legacy-offline` profile or switch production back to
Whisper/Ollama while monitoring or cleaning up the VPS.

## Goals

- Catch disk, RAM, swap, container restart, and health drift before the app is
  down.
- Keep operator reports under a bounded host directory.
- Free safe disk space without deleting production data.
- Keep PostgreSQL, Redis, `ai-api`, and `celery-worker` private.

## Run Monitor

From the deployment checkout on the VPS:

```bash
cd /opt/audiomind/phase3-worktree
bash scripts/deploy/monitor-prod.sh
```

The monitor writes a timestamped report to:

```text
/opt/audiomind/ops-logs
```

Expected report names:

```text
monitor-prod-YYYYMMDDTHHMMSSZ.log
```

The script creates the directory if needed and applies `chmod 750`. Reports must
not contain `infra/.env` values, provider keys, JWTs, database passwords, or
other secrets.

The monitor records:

- timestamp, host, git branch, and git revision
- `free -h`
- `df -h`
- `docker system df`
- production `docker compose ps`
- `docker stats --no-stream`
- restart count/status/restarting/exit for Compose containers
- `/opt/audiomind/backups` size
- `bash scripts/deploy/health-prod.sh`

The monitor exits non-zero if `health-prod.sh` fails, root disk usage reaches
the fail threshold, or available RAM reaches the critical threshold.

MVP thresholds:

- warn when root filesystem usage is at least 80%
- fail when root filesystem usage is at least 90%
- warn when available RAM is below 700 MB
- fail when available RAM is below 300 MB
- warn when swap used is greater than 512 MB
- warn when any container restart count is greater than 0

Read the report from newest to oldest:

```bash
ls -lh /opt/audiomind/ops-logs
tail -n 200 /opt/audiomind/ops-logs/<monitor-report>.log
```

Monitor report retention keeps only script-owned `monitor-prod-*.log` files
older than 14 days. It does not delete backups or arbitrary files under
`/opt/audiomind`.

## Failure Capture

If monitor fails, collect redacted logs before sharing output:

```bash
bash scripts/deploy/collect-prod-logs-redacted.sh
```

The redacted log collector tails Compose logs and masks common provider/auth
secrets. Do not share raw logs if they may contain secrets.

## Safe Cleanup

Dry-run is the default:

```bash
bash scripts/deploy/cleanup-prod-safe.sh
```

`--apply` alone still does not delete anything:

```bash
bash scripts/deploy/cleanup-prod-safe.sh --apply
```

Actual cleanup requires explicit confirmation:

```bash
bash scripts/deploy/cleanup-prod-safe.sh --apply --yes
```

Before real cleanup, confirm recent backups exist:

```bash
du -sh /opt/audiomind/backups 2>/dev/null || true
ls -lh /opt/audiomind/backups 2>/dev/null || true
```

The cleanup script prints disk usage and `docker system df` before and after.
It may clean only:

- Docker builder cache older than 168 hours
- stopped containers older than 24 hours
- dangling images older than 168 hours
- old redacted log bundles matching
  `/opt/audiomind/audiomind-logs/prod-logs-redacted-*.log`
- old monitor reports matching
  `/opt/audiomind/ops-logs/monitor-prod-*.log`

It must not delete `/opt/audiomind/backups`. Backup retention remains owned by
the backup scripts.

Post-cleanup checks:

```bash
df -h
docker system df
bash scripts/deploy/health-prod.sh
```

Do not run real cleanup if dry-run output is surprising.

## Forbidden Commands

Never use these for routine cleanup, rollback, backup, or restore:

```bash
docker volume prune
docker compose down -v
docker system prune --volumes
```

Do not delete Docker volumes, `infra/.env`, Caddy certificate storage,
PostgreSQL data, uploads, or recent backups.

## Journal Cleanup

The safe cleanup script does not run journal cleanup automatically because it may
need sudo. If host journal logs are large and the operator approves, run:

```bash
sudo journalctl --disk-usage
sudo journalctl --vacuum-time=14d
```

## Docker Log Rotation

Docker `json-file` logs can grow without bound if no rotation is configured.
Use host-level Docker daemon defaults after manual review.

Example `/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "5"
  }
}
```

The same example is stored at
[infra/docker/daemon.json.example](../../infra/docker/daemon.json.example).

Editing `/etc/docker/daemon.json` and restarting Docker can briefly interrupt
containers. Apply this during a low-traffic window.

After restarting Docker, validate:

```bash
docker compose --env-file infra/.env \
  -f infra/docker-compose.dev.yml \
  -f infra/docker-compose.mvp.yml \
  -f infra/docker-compose.prod.yml \
  ps

bash scripts/deploy/health-prod.sh
```

If Docker fails to restart because `daemon.json` is invalid, restore the
previous file and restart Docker again. Do not delete Docker volumes as part of
log rotation.
