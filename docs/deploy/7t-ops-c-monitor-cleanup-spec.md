# 7T-Ops-C Monitor / Cleanup Spec

## 1. Problem Summary

The Vietnix production deployment is healthy and now has backup, retention,
restore dry-run, and local download coverage from 7T-Ops-B. The next risk is
operational drift after the system is left running: disk fills from Docker logs,
old images, build cache, log bundles, journal files, or backups; RAM pressure
restarts containers; and failures go unnoticed until the app is down.

This phase is spec-only. It plans production monitoring and safe cleanup support
without running Docker build/up, deploying, SSHing, browser smoke testing,
editing real `.env` files, or implementing code.

Production remains cloud-first:

- STT/transcription: Deepgram
- Analysis/summarization: Gemini
- Legacy Whisper/Ollama: not part of the default runtime path

Do not re-enable Whisper/Ollama as the default production runtime.

## 2. Current Production Ops State

The production Compose path is:

```bash
docker compose --env-file infra/.env \
  -f infra/docker-compose.dev.yml \
  -f infra/docker-compose.mvp.yml \
  -f infra/docker-compose.prod.yml \
  ...
```

`infra/docker-compose.prod.yml` sets:

```yaml
name: audiomind-prod
```

Current production exposure shape:

- Public through Caddy: `web`, `meeting-api`, `processing-api`, `user-api`
- Private: `db`, `redis`, `ai-api`, `celery-worker`
- Cloud providers: `STT_PROVIDER=deepgram`, `ANALYSIS_PROVIDER=gemini`,
  `AI_PROVIDER=gemini`
- Legacy local providers disabled:
  `LOCAL_WHISPER_ENABLED=false`, `ALLOW_LEGACY_LOCAL_STT=false`,
  `OLLAMA_ENABLED=false`, `ALLOW_LEGACY_LOCAL_AI=false`

Existing ops scripts:

- `scripts/deploy/check-prod-config.sh`
  validates production env/config shape, required provider settings, private
  runtime defaults, and rendered Compose config.
- `scripts/deploy/start-prod.sh`
  runs config validation, then builds and starts the production Compose stack.
- `scripts/deploy/health-prod.sh`
  checks public app/API readiness, private `ai-api /ready` through Compose, and
  `celery-worker` state through Compose plus `docker inspect`.
- `scripts/deploy/collect-prod-logs-redacted.sh`
  captures Compose logs with a tail limit and redacts common provider/auth
  secrets into a timestamped log file.
- `scripts/deploy/backup-prod.sh`, `backup-postgres.sh`, and
  `backup-uploads.sh`
  create Postgres/upload backups, checksums, manifests, locking, disk
  preflight, and backup retention under `/opt/audiomind/backups`.

Current health coverage:

- `https://app.../`
- `meeting-api` `/health` and `/ready`
- `processing-api` `/health` and `/ready`
- `user-api` `/health` and `/ready`
- private `ai-api` `/ready`
- `celery-worker` running/restarting/exit-code state

Current health gaps for monitoring:

- no disk, RAM, or swap summary
- no `docker system df`
- no backup directory size summary
- no container restart count summary for all production services
- no one-command daily monitor report
- no safe cleanup script or dry-run design
- no Docker log rotation policy in repo docs

## 3. Monitor Goals

The monitor plan should add a lightweight daily production check that can be run
manually first and automated later.

It should report:

- `free -h`
- `df -h`
- `docker system df`
- production `docker compose ps`
- `docker stats --no-stream`
- `bash scripts/deploy/health-prod.sh`
- backup directory size for `/opt/audiomind/backups`
- recent redacted log collection command when failures appear
- restart counts from `docker inspect` where available

It should fail non-zero when core health checks fail, or when hard thresholds
are exceeded. Suggested MVP thresholds for implementation:

- fail when root filesystem usage is at or above 90%
- warn when root filesystem usage is at or above 80%
- warn when available RAM is below 700 MB on the 4 GB VPS
- fail or warn clearly when available RAM is below 300 MB
- warn when swap used is greater than 512 MB
- warn when `/opt/audiomind/backups` is unexpectedly large
- fail when `health-prod.sh` fails
- warn when any container restart count is greater than 0
- fail or warn clearly when any core service is restarting or exited

The monitor output should avoid printing secrets and should not dump
`infra/.env`.

Monitor report retention:

- Store monitor reports under `/opt/audiomind/ops-logs`.
- Create the directory if it is missing.
- Apply `chmod 750` to the directory.
- Do not write secrets, env values, tokens, provider keys, JWTs, or database
  passwords into reports.
- Keep old monitor reports for a bounded period, with 14 days as the MVP
  default.
- Cleanup may delete only files matching script-owned report patterns, such as
  `monitor-prod-*.log`, inside `/opt/audiomind/ops-logs`.

## 4. Cleanup Goals

Cleanup should reduce disk pressure without touching durable data. The default
cleanup path must be conservative and support dry-run before deletion.

Safe cleanup candidates:

- Docker build cache older than a conservative age
- stopped containers older than a conservative age
- dangling images older than a conservative age
- old temporary log bundles generated by Audiomind ops scripts
- old host journal logs using `journalctl --vacuum-time=...`
- old backup files only through the existing backup retention rules and owned
  file patterns

The cleanup script should print disk usage before and after cleanup. It should
require explicit opt-in for actual deletion, with dry-run as the default.

## 5. What Must Never Be Deleted

Cleanup must never delete:

- Docker volumes
- `audiomind-prod_postgres_data`
- `audiomind-prod_uploads`
- `audiomind-prod_job_status` unless a future phase explicitly handles in-flight
  job state
- `infra/.env`
- any real service `.env`
- current or recent backups
- Caddy certificate storage
- production repository files
- uploaded audio or generated artifacts under the uploads volume

Forbidden cleanup commands:

```bash
docker volume prune
docker compose down -v
docker system prune --volumes
```

The MVP cleanup script should also avoid broad `docker system prune` and prefer
targeted prune commands so volume deletion cannot be introduced accidentally.

## 6. Proposed Scripts / Files To Add Or Modify

Add in implementation phase:

- `scripts/deploy/monitor-prod.sh`
  Daily/manual production resource and health report.

- `scripts/deploy/cleanup-prod-safe.sh`
  Conservative dry-run-first cleanup for build cache, stopped containers,
  dangling images, old temp log bundles, and optional journal vacuum guidance.

- `docs/deploy/monitor-cleanup.md`
  Runbook for daily checks, safe cleanup, log rotation, failure capture, and
  optional automation.

Modify in implementation phase:

- `docs/deploy/backup-restore.md`
  Cross-link backup disk usage and cleanup rules if needed.

- `docs/deploy/vietnix-vps-deploy-guide.md`
  Link the monitor/cleanup runbook from troubleshooting/ops sections.

- `docs/deploy/production-vps-deploy-guide.md`
  Link the monitor/cleanup runbook from rollback/readiness guidance.

Optional:

- `infra/docker/daemon.json.example`
  Example Docker daemon log rotation config for the VPS host.

- `infra/systemd/audiomind-monitor.service`
- `infra/systemd/audiomind-monitor.timer`
- `infra/systemd/audiomind-cleanup.service`
- `infra/systemd/audiomind-cleanup.timer`

Do not modify:

- real `infra/.env`
- provider defaults that keep Deepgram/Gemini active
- Compose exposure that keeps DB/Redis/AI/worker private

## 7. Docker Log Rotation Design

Docker container logs can grow without bound when the default `json-file`
logging driver has no rotation. This affects every service that writes stdout
or stderr, especially `ai-api`, `celery-worker`, Java APIs, and Caddy-facing web
traffic during demos.

Recommended MVP policy:

1. Document a host-level Docker daemon default in `/etc/docker/daemon.json`.
2. Use bounded `json-file` logs, for example `max-size=10m` and `max-file=5`.
3. Make clear that daemon changes require Docker daemon reload/restart by the
   user on the VPS.
4. Mention that daemon defaults may apply to newly created containers, so a
   controlled Compose recreate may be needed after manual validation.
5. Warn that editing `/etc/docker/daemon.json` and restarting Docker can cause a
   brief container interruption.
6. Recommend applying Docker daemon changes during a low-traffic window.
7. After Docker restart, run production Compose status and `health-prod.sh`.
8. If `daemon.json` is invalid or Docker fails to restart cleanly, restore the
   previous daemon config and restart Docker again.
9. Do not change Docker volumes or Compose data mounts.

Example daemon config for the runbook:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "5"
  }
}
```

Alternative implementation option:

- Add per-service Compose `logging` options through a production override.
- This is more versioned in the repo, but touches every service block and can
  be noisier than the daemon-level host policy.

Recommendation for 7T-Ops-C1:

- Start with documented host-level Docker log rotation.
- Consider per-service Compose logging only if the team wants the policy fully
  encoded in Compose after VPS validation.

## 8. Monitor Script Design

`scripts/deploy/monitor-prod.sh` should:

- use the same `ROOT_DIR`, `ENV_FILE`, `COMPOSE_FILES`, and `COMPOSE` pattern as
  existing deploy scripts
- fail early if `infra/.env` is missing
- create `/opt/audiomind/ops-logs` if missing and apply `chmod 750`
- create a timestamped report under `/opt/audiomind/ops-logs`, such as
  `monitor-prod-YYYYMMDDTHHMMSSZ.log`
- print all checks to stdout and tee them into the report
- avoid printing env values or secrets
- run `health-prod.sh` and preserve its exit code
- include `collect-prod-logs-redacted.sh` guidance when health fails
- keep monitor reports for a bounded retention window, with 14 days as the MVP
  default
- delete only script-owned report patterns such as `monitor-prod-*.log` when
  applying report retention

Suggested report sections:

- timestamp, hostname, git branch/revision if available
- memory: `free -h`
- RAM/swap threshold summary for the 4 GB VPS
- disk: `df -h`
- Docker disk: `docker system df`
- Compose status: production `docker compose ps`
- container resource snapshot: `docker stats --no-stream`
- container restart counts from `docker inspect`
- backup size:
  `du -sh /opt/audiomind/backups 2>/dev/null || true`
- health: `bash scripts/deploy/health-prod.sh`

Suggested MVP RAM/swap thresholds:

- warn when available RAM is below 700 MB
- fail or warn clearly when available RAM is below 300 MB
- warn when swap used is greater than 512 MB
- warn when any container restart count is greater than 0

Suggested restart-count approach:

```bash
docker compose --env-file infra/.env \
  -f infra/docker-compose.dev.yml \
  -f infra/docker-compose.mvp.yml \
  -f infra/docker-compose.prod.yml \
  ps -q |
while read -r container_id; do
  docker inspect \
    --format '{{.Name}} restart_count={{.RestartCount}} status={{.State.Status}} restarting={{.State.Restarting}} exit={{.State.ExitCode}}' \
    "$container_id"
done
```

Alerting for MVP:

- Use exit code plus a log file.
- Do not add Telegram/email until secrets/config and ownership are designed.
- Existing `infra/monitoring/alerts.yml` can remain a future Prometheus-style
  path, but it should not be required for 7T-Ops-C MVP.

## 9. Safe Cleanup Script Design

`scripts/deploy/cleanup-prod-safe.sh` should be dry-run by default. A possible
interface:

```bash
bash scripts/deploy/cleanup-prod-safe.sh
bash scripts/deploy/cleanup-prod-safe.sh --apply
bash scripts/deploy/cleanup-prod-safe.sh --apply --yes
```

Default dry-run should print what would run and current disk usage. `--apply`
alone should still refuse deletion and print a clear warning unless paired with
an explicit confirmation flag such as `--yes`. Actual deletion should require
`--apply --yes`, so an accidental `--apply` does not remove anything.

Safe command candidates for implementation:

```bash
docker builder prune --filter "until=168h"
docker container prune --filter "until=24h"
docker image prune --filter "dangling=true" --filter "until=168h"
find /opt/audiomind/audiomind-logs -maxdepth 1 -type f -name 'prod-logs-redacted-*.log' -mtime +14 -print
journalctl --disk-usage
```

With `--apply`, old redacted log bundle cleanup can add `-delete` only for the
owned log filename pattern and directory.

With `--apply --yes`, old monitor report cleanup can delete only
`/opt/audiomind/ops-logs/monitor-prod-*.log` files older than the configured
retention window. It must not delete arbitrary files in `/opt/audiomind` or
`/opt/audiomind/backups`.

Journal cleanup should be conservative:

```bash
sudo journalctl --vacuum-time=14d
```

Because `journalctl --vacuum-time` may require sudo, the cleanup script can
print the command as an operator step instead of running it automatically.

Backups:

- Do not invent a second backup cleanup path.
- Use existing `backup-prod.sh` retention rules for owned backup files.
- Before stronger cleanup, show:

```bash
du -sh /opt/audiomind/backups 2>/dev/null || true
ls -lh /opt/audiomind/backups 2>/dev/null || true
```

The script should warn the user to confirm recent backup health before applying
aggressive image/build-cache cleanup. It must not delete volumes.

Recommended cleanup flow:

1. Run dry-run mode.
2. Confirm the most recent backup files and manifest still exist.
3. Run `--apply --yes` only if the planned cleanup is acceptable.
4. Run `df -h` and `docker system df`.
5. Run `bash scripts/deploy/health-prod.sh`.

## 10. Optional Systemd Timer Design

Systemd timers should be optional and only added after manual validation.

Monitor timer candidate:

- service runs `bash scripts/deploy/monitor-prod.sh`
- schedule daily, for example early morning Asia/Ho_Chi_Minh time
- logs to journal and the script report file
- non-zero exit exposes failure through `systemctl status`

Cleanup timer candidate:

- service runs cleanup in dry-run or very conservative apply mode
- schedule weekly, not daily
- should not run destructive cleanup until the script has been manually
  validated
- should never run volume prune or `down -v`

Recommendation for 7T-Ops-C5:

- Document systemd units/timers as optional.
- Do not install or enable timers automatically.
- Keep manual monitor and dry-run cleanup as acceptance criteria before timer
  installation.

## 11. Step-By-Step Implementation Plan

### 7T-Ops-C1: Docker log rotation policy

1. Add Docker log rotation guidance to `docs/deploy/monitor-cleanup.md`.
2. Include `/etc/docker/daemon.json` example with bounded `json-file` logs.
3. Document validation commands for current log sizes and Docker restart
   impact.
4. Keep volumes untouched.
5. Keep Deepgram/Gemini defaults unchanged.

### 7T-Ops-C2: Daily production resource check script

1. Add `scripts/deploy/monitor-prod.sh`.
2. Reuse the production Compose stack from existing deploy scripts.
3. Include memory, disk, Docker disk, Compose status, Docker stats, restart
   counts, backup directory size, and `health-prod.sh`.
4. Write a timestamped report under `/opt/audiomind/ops-logs` and return
   non-zero on failed health.
5. Add RAM/swap thresholds for the 4 GB VPS: warn below 700 MB available RAM,
   fail or warn clearly below 300 MB available RAM, and warn when swap used is
   greater than 512 MB.
6. Add report retention for `monitor-prod-*.log`, keeping 14 days by default.
7. Add docs showing how to collect redacted logs after a failure.

### 7T-Ops-C3: Safe cleanup script

1. Add `scripts/deploy/cleanup-prod-safe.sh`.
2. Make dry-run the default.
3. Require `--apply --yes` for actual deletion; `--apply` without `--yes`
   should print a warning and do nothing destructive.
4. Use specific prune commands for builder cache, stopped containers, and
   dangling images.
5. Add old redacted log bundle and monitor report cleanup for owned filename
   patterns only.
6. Show backup disk usage and warn to confirm recent backups before stronger
   cleanup.
7. Document post-cleanup validation with `df -h`, `docker system df`, and
   `health-prod.sh`.
8. Explicitly block or avoid volume deletion commands.

### 7T-Ops-C4: Monitor/cleanup runbook docs

1. Add `docs/deploy/monitor-cleanup.md`.
2. Document daily monitor workflow.
3. Document safe cleanup dry-run and apply workflow.
4. Document Docker log rotation.
5. Document backup directory disk checks.
6. Link to `collect-prod-logs-redacted.sh` for failure capture.
7. Cross-link from existing production deploy docs.

### 7T-Ops-C5: Optional systemd timer after manual validation

1. Draft optional service/timer examples only after manual script validation.
2. Keep timer installation as a user-run step.
3. Prefer monitor automation before cleanup automation.
4. Keep cleanup timer conservative and never volume-destructive.

### 7T-Ops-C6: Optional alerting later

1. Keep MVP alerting to exit codes and log files.
2. Revisit Telegram/email only after secrets/config ownership is defined.
3. Treat existing `infra/monitoring/alerts.yml` as a future metrics path, not a
   required part of this phase.

## 12. Acceptance Criteria

- There is a plan to limit Docker logs so logs do not grow without bound.
- There is a monitor script/checklist covering RAM, disk, `docker ps`,
  `docker stats`, and `health-prod.sh`.
- `monitor-prod.sh` creates a report file in `/opt/audiomind/ops-logs`.
- `monitor-prod.sh` creates `/opt/audiomind/ops-logs` if missing and applies
  `chmod 750`.
- `monitor-prod.sh` keeps report retention bounded, with 14 days as the MVP
  default.
- `monitor-prod.sh` exits non-zero if `health-prod.sh` fails.
- `monitor-prod.sh` reports RAM/swap thresholds for the 4 GB VPS.
- The monitor plan reports `/opt/audiomind/backups` disk usage.
- The monitor plan includes container restart counts where Docker exposes them.
- The monitor plan warns when any container restart count is greater than 0.
- There is a safe cleanup script design that does not delete volumes.
- `cleanup-prod-safe.sh` is dry-run by default.
- `cleanup-prod-safe.sh` requires `--apply --yes` before it deletes anything.
- Cleanup does not use `docker volume prune`.
- Cleanup does not use `docker system prune --volumes`.
- Cleanup does not use `docker compose down -v`.
- Cleanup only targets safe cache/image/container/temp-log cleanup.
- `cleanup-prod-safe.sh` does not delete `/opt/audiomind/backups` outside
  retention owned by the backup scripts.
- Cleanup warns the operator to check recent backups before stronger cleanup.
- There is post-cleanup guidance to run `health-prod.sh`.
- There is guidance to inspect `/opt/audiomind/backups` disk usage.
- There is guidance to collect redacted logs when monitor detects a failure.
- Postgres, Redis, `ai-api`, and `celery-worker` remain private.
- Deepgram/Gemini cloud-first defaults remain unchanged.
- Whisper/Ollama are not re-enabled in the default runtime path.
- Systemd automation is optional and gated behind manual validation.
- MVP alerting is limited to log files and exit codes unless a future phase
  defines notification secrets/config.

## 13. Validation Plan

These commands are for the user to run on the VPS after implementation. Do not
run them during this spec phase.

Daily monitor baseline:

```bash
bash scripts/deploy/health-prod.sh

free -h
df -h
docker system df

docker compose --env-file infra/.env \
  -f infra/docker-compose.dev.yml \
  -f infra/docker-compose.mvp.yml \
  -f infra/docker-compose.prod.yml \
  ps

docker stats --no-stream

du -sh /opt/audiomind/backups 2>/dev/null || true
```

Monitor script validation after implementation:

```bash
bash scripts/deploy/monitor-prod.sh
echo $?
ls -lh /opt/audiomind/ops-logs 2>/dev/null || true
stat -c '%a %n' /opt/audiomind/ops-logs 2>/dev/null || true
```

Restart-count inspection:

```bash
docker compose --env-file infra/.env \
  -f infra/docker-compose.dev.yml \
  -f infra/docker-compose.mvp.yml \
  -f infra/docker-compose.prod.yml \
  ps -q |
while read -r container_id; do
  docker inspect \
    --format '{{.Name}} restart_count={{.RestartCount}} status={{.State.Status}} restarting={{.State.Restarting}} exit={{.State.ExitCode}}' \
    "$container_id"
done
```

Docker log rotation inspection:

```bash
docker info --format '{{.LoggingDriver}}'
sudo test -f /etc/docker/daemon.json && sudo cat /etc/docker/daemon.json
sudo du -sh /var/lib/docker/containers 2>/dev/null || true
```

Safe cleanup validation:

```bash
bash scripts/deploy/cleanup-prod-safe.sh
bash scripts/deploy/cleanup-prod-safe.sh --apply
```

Do not run cleanup destructive validation first. If implementation adds
`--apply --yes`, run dry-run mode first, inspect the planned deletions, confirm
recent backup health, and only then run:

```bash
bash scripts/deploy/cleanup-prod-safe.sh --apply --yes
df -h
docker system df
bash scripts/deploy/health-prod.sh
```

Backup checks before stronger cleanup:

```bash
du -sh /opt/audiomind/backups 2>/dev/null || true
ls -lh /opt/audiomind/backups 2>/dev/null || true
```

Failure capture:

```bash
bash scripts/deploy/collect-prod-logs-redacted.sh
```

Forbidden validation commands:

```bash
docker volume prune
docker compose down -v
docker system prune --volumes
```

## 14. Rollback / Safety Plan

Monitor rollback:

- If `monitor-prod.sh` fails incorrectly, disable any timer that calls it and
  run the existing `health-prod.sh` manually.
- Keep the existing health and log collection scripts unchanged unless the
  implementation phase intentionally updates them.

Cleanup rollback:

- Dry-run must be the default.
- If cleanup output is surprising, do not run `--apply`.
- If `--apply` removes cache/images and later an image is needed, rebuild or
  pull images through the normal deploy path.
- Never recover by deleting or recreating Docker volumes.

Docker log rotation rollback:

- Keep a copy of the previous `/etc/docker/daemon.json` before host changes.
- If Docker fails to reload after daemon config edits, restore the previous
  daemon config and restart Docker.
- Because Docker daemon restart can briefly interrupt containers, make the
  change during a low-traffic window and validate afterwards with
  `docker compose ps` and `health-prod.sh`.
- Do not delete `/var/lib/docker/volumes`.

Backup safety:

- Confirm recent backup manifests and checksums before aggressive cleanup.
- Keep backup retention cleanup inside the existing backup scripts and owned
  file patterns.
- Do not manually delete new backups to free space unless the user has verified
  older and newer backup coverage.

## 15. Out Of Scope

- Implementing monitor/cleanup code in this spec phase.
- Running Docker build/up.
- Deploying to the VPS.
- SSH access.
- Browser smoke tests.
- Editing real `infra/.env` or service `.env` files.
- Committing provider secrets.
- Deleting Docker volumes.
- Running Docker volume prune.
- Running Docker Compose down with `-v`.
- Running Docker system prune with `--volumes`.
- Making Postgres, Redis, `ai-api`, or `celery-worker` public.
- Switching production away from Deepgram/Gemini.
- Enabling Whisper/Ollama as default production services.
- Adding Telegram/email alerts before secret/config ownership exists.
- Installing or enabling systemd timers before manual validation.

## 16. Risks / Notes

- Host-level Docker daemon log rotation may require Docker daemon restart, and
  existing containers may need controlled recreation before the policy applies.
- Per-service Compose logging is more explicit but touches many services.
- `docker stats --no-stream` is a snapshot, not long-term metrics.
- `docker builder prune` and image cleanup can force future rebuilds or pulls,
  so cleanup should print what it will remove and remain conservative.
- `journalctl --vacuum-time` is host-level cleanup and may require sudo.
- Backup retention already exists; cleanup should not duplicate it with broader
  delete patterns.
- The current `collect-prod-logs-redacted.sh` captures recent Compose logs and
  redacts common secrets. It is suitable for failure capture after monitor
  alerts, but it is not a long-term monitoring store.
- Disk pressure is important on the current small VPS. Recent validation showed
  about 26 GB free on a 38 GB filesystem, but backup growth and Docker logs can
  change that quickly.
