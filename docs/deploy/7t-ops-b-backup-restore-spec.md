# 7T-Ops-B Backup / Restore Spec

## 1. Problem Summary

The Vietnix production deployment is now healthy after 7T-Ops-A, but production
data has no complete, documented backup and restore workflow. A failed deploy,
VPS disk issue, operator mistake, or Docker volume loss could currently remove
meeting records, transcripts, analysis results, users, and uploaded audio.

This phase is spec-only. It plans production backup and restore support without
running Docker, deploying, SSHing, editing real `.env` files, or implementing
backup/restore code.

Production remains cloud-first:

- STT/transcription: Deepgram
- Analysis/summarization: Gemini
- Legacy Whisper/Ollama: not part of the default runtime path

## 2. Current Production Data Shape

The production Compose path is:

```bash
docker compose --env-file infra/.env \
  -f infra/docker-compose.dev.yml \
  -f infra/docker-compose.mvp.yml \
  -f infra/docker-compose.prod.yml \
  ...
```

`infra/docker-compose.prod.yml` sets the Compose project name:

```yaml
name: audiomind-prod
```

Expected production services and volumes:

- Postgres service: `db`
- Postgres container data path: `/var/lib/postgresql/data`
- Postgres Compose volume: `postgres_data`
- Expected concrete Docker volume: `audiomind-prod_postgres_data`
- Upload Compose volume: `uploads`
- Expected concrete Docker volume: `audiomind-prod_uploads`
- Shared upload mount path: `/app/uploads`
- Operational storage volume: `job_status`, mounted at `/app/storage` for
  `ai-api` and `celery-worker`
- Redis service: `redis`, private and not publicly exposed

Upload path details:

- `meeting-api` stores uploaded files under its working directory `uploads/`.
  In the container this is backed by the shared `uploads:/app/uploads` mount.
- `ai-api` uses `resolve_upload_dir()` and prefers `/app/uploads`, then
  `/app/storage/uploads`, then `./storage/uploads`.
- `processing-api`, `ai-api`, and `celery-worker` all need the uploaded audio
  paths to remain consistent after restore.

Production exposure constraints already established by 7T-Ops-A:

- Public: `web`, `meeting-api`, `processing-api`, `user-api` through Caddy.
- Private: `db`, `redis`, `ai-api`, `celery-worker`.
- `health-prod.sh` checks public readiness plus private `ai-api /ready` through
  Compose and confirms `celery-worker` is running.

## 3. What Must Be Backed Up

Minimum recoverable production backup set:

1. PostgreSQL logical backup from service `db`.
   This preserves users, meetings, transcripts, analyses, auth-related rows,
   meeting ownership, upload metadata, and processing history stored in the DB.

2. Uploads volume archive from `audiomind-prod_uploads`.
   This preserves uploaded audio and any generated artifacts stored under
   `/app/uploads`.

3. Backup manifest metadata.
   Each backup run should record timestamp, source Compose project, service,
   volume, generated files, sizes, checksums, and retention policy.

Usually optional:

- Redis/job status state.
  Redis DBs and `job_status` are operational/in-flight state. For a normal MVP
  disaster recovery target, completed business data should come from Postgres
  plus uploads. A later phase can add optional Redis or `job_status` backup if
  preserving in-flight jobs becomes necessary.

## 4. What Should Not Be Backed Up

The backup workflow must not archive:

- `infra/.env`
- provider API keys
- `JWT_SECRET`
- `POSTGRES_PASSWORD`
- Caddy private keys or certificate storage
- redacted or unredacted production logs unless separately requested
- `model_cache`
- `ollama_cache`
- real local `.env` files from service directories

The workflow must not make private services public:

- Do not expose Postgres.
- Do not expose Redis.
- Do not expose `ai-api`.
- Do not expose `celery-worker`.

The workflow must not change the runtime provider policy:

- Do not enable `legacy-offline`.
- Do not set Whisper/Ollama as defaults.
- Keep `STT_PROVIDER=deepgram`.
- Keep `ANALYSIS_PROVIDER=gemini`.
- Keep `AI_PROVIDER=gemini`.
- Keep `LOCAL_WHISPER_ENABLED=false`.
- Keep `OLLAMA_ENABLED=false`.

## 5. Backup Design

### 7T-Ops-B1: Backup Postgres

Extend or replace `scripts/deploy/backup-postgres.sh` so it is production-safe.
The existing script already:

- uses `infra/.env`
- uses the production Compose file stack
- runs `pg_dump` through service `db`
- writes a custom-format dump
- uses `--no-owner --no-privileges`

Current gaps:

- default backup directory is `../audiomind-backups`, not the requested stable
  VPS path
- no retention cleanup
- no checksum
- no manifest
- no backup size validation
- no uploads backup
- no restore or dry-run guidance
- no lock to prevent concurrent runs

Target behavior:

- Default `BACKUP_DIR=/opt/audiomind/backups`.
- Create `BACKUP_DIR` if it does not exist.
- Keep `BACKUP_DIR` on the VPS host filesystem, not inside a Docker volume.
- Prefer owner `deploy:deploy`.
- Apply safe permissions, preferably `chmod 700` or `chmod 750`.
- Run a disk preflight before writing backups. Use `df -Pk "$BACKUP_DIR"` for
  script-friendly checks and optionally print `df -h "$BACKUP_DIR"` for human
  diagnostics.
- Fail before backup if available disk under `BACKUP_DIR` is below 2 GB.
- Warn clearly if available disk under `BACKUP_DIR` is below 5 GB.
- Create timestamped files such as:
  `audiomind-postgres-YYYYMMDDTHHMMSSZ.dump`.
- Write the dump to a `.tmp` file first.
- Write a `sha256` checksum for every dump.
- Move `.tmp` to the final filename only after `pg_dump` succeeds, the file is
  greater than zero bytes, and checksum creation succeeds.
- Fail if the final dump file is missing or size is zero.
- Use a lock file or `flock` to prevent concurrent runs. Suggested lock path:
  `/tmp/audiomind-backup.lock`.
- If another backup is running, fail with a clear message instead of running in
  parallel.
- Keep `pg_dump --format=custom --no-owner --no-privileges`.
- Run only through the private Compose `db` service.

### 7T-Ops-B2: Backup uploads volume

Add `scripts/deploy/backup-uploads.sh` or add an explicit uploads mode to a
combined backup script.

Target behavior:

- Archive expected concrete Docker volume `audiomind-prod_uploads`.
- Mount the source volume read-only.
- Write a timestamped archive such as:
  `audiomind-uploads-YYYYMMDDTHHMMSSZ.tar.gz`.
- Write the archive to a `.tmp` file first.
- Write a checksum.
- Move `.tmp` to the final filename only after `tar` succeeds, the file is
  greater than zero bytes, and checksum creation succeeds.
- Fail if the final archive is missing or size is zero.
- Validate the archive can be listed with `tar -tzf`.
- Do not mount or archive `infra/.env`.
- Reuse the same backup lock as the Postgres backup, or have the combined
  wrapper own the lock for both backup types.

Safety checks before archiving:

- Confirm `docker volume inspect audiomind-prod_uploads` succeeds.
- Confirm the resolved volume name exactly matches the production Compose
  project and expected volume, not a dev volume such as
  `phase3-worktree_uploads`.
- Mount source as `:ro`.

### 7T-Ops-B3: Retention cleanup

Add retention cleanup for both Postgres and uploads backups.

Recommended MVP policy:

- Default retention: 14 days.
- Allow override with `RETENTION_DAYS`.
- Minimum accepted retention: 7 days unless an explicit force flag is used.

Rationale:

- 7 days is cheaper but thin for a small team that may not notice an issue
  immediately.
- 14 days gives more recovery room while still being modest for a 40 GB VPS.

Cleanup rules:

- Delete only files matching owned backup patterns inside `BACKUP_DIR`.
- Do not delete `.tmp` files that may belong to the currently running backup.
  If stale `.tmp` cleanup is implemented, it must only remove files older than
  a conservative threshold and only when the backup lock is not held.
- Never delete directories recursively.
- Never delete Docker volumes.
- Never run `docker volume prune`.
- Never run `docker compose down -v`.
- Never run `docker system prune --volumes`.

### 7T-Ops-B4: Restore dry-run / restore guide

Create a restore guide and optionally a dry-run script in the implementation
phase. Default restore validation must not overwrite production.

Preferred safe restore checks:

- Postgres dry-run level 1: `pg_restore --list <dump>` to verify the custom
  dump is readable.
- If `pg_restore` is not installed on the VPS host, run validation through a
  Postgres helper container using the same major version as production
  (`postgres:15.7`), with the backup directory mounted read-only.
- Postgres dry-run level 2: restore into a temporary test database/container,
  never the production database.
- Upload dry-run: `tar -tzf <uploads-backup>.tar.gz | head`.

Required restore warning:

```text
Do not restore over the production database until a fresh backup exists and the
user has explicitly confirmed the destructive operation.
```

Production restore order, when explicitly approved:

1. Take a fresh Postgres backup and uploads backup.
2. Stop app services that write to data: `web`, `meeting-api`,
   `processing-api`, `user-api`, `ai-api`, `celery-worker`.
3. Keep `db` running for logical restore, or use a controlled restore
   container.
4. Restore Postgres using the approved dump.
5. Restore uploads only after deciding whether to merge or replace files.
6. Start services with the same production Compose files.
7. Run readiness checks and the smoke checklist.

No implementation should drop production data as an ad hoc step.

### 7T-Ops-B5: Download backup to local

Document `scp` download commands for Windows PowerShell and Unix shells.

Example PowerShell:

```powershell
scp deploy@14.225.204.225:/opt/audiomind/backups/<backup-file> "$env:USERPROFILE\Downloads\"
```

Example Unix shell:

```bash
scp deploy@14.225.204.225:/opt/audiomind/backups/<backup-file> ~/Downloads/
```

The guide should recommend downloading both:

- the Postgres dump plus checksum
- the uploads archive plus checksum

### 7T-Ops-B6: Optional cron/systemd timer

For implementation, prefer a systemd timer over cron if the deploy user has the
needed host permissions, because logs and status are clearer.

Suggested schedule:

- Daily during low-traffic hours, for example `03:15 Asia/Ho_Chi_Minh`.
- Also run manually before every deploy that changes persistence or upload
  behavior.

Timer design notes:

- Run as `deploy`.
- Working directory: `/opt/audiomind/phase3-worktree`.
- Command: a single backup wrapper script that backs up Postgres, uploads, and
  applies retention.
- Logs: systemd journal, plus a compact manifest file in `BACKUP_DIR`.
- Do not store secrets in the unit file.
- Do not print `infra/.env` values.

## 6. Restore Design

Restore documentation should be more conservative than backup documentation.
The default user path should prove a backup is readable before touching
production.

Postgres restore design:

- Use custom-format dumps so `pg_restore --list` and selective restore checks
  are possible.
- Do not require `pg_restore` to be installed on the host. Document a helper
  container fallback:

```bash
docker run --rm \
  -v /opt/audiomind/backups:/backups:ro \
  postgres:15.7 \
  pg_restore --list /backups/<postgres-backup>.dump | head
```

- For dry-run, restore into an isolated test database or temporary container.
- For production restore, require explicit confirmation and a fresh pre-restore
  backup.
- Keep `--no-owner --no-privileges` compatible with the production DB user.

Uploads restore design:

- Validate archive listing first.
- Restore into a temporary directory or test volume for dry-run.
- For production, decide merge vs replace before running any extraction.
- Do not clear the uploads volume without a separate explicit confirmation.
- Never use Docker volume deletion as a restore shortcut.

Redis/job status restore design:

- Do not include Redis restore in the default MVP recovery path.
- If Redis loss occurs, active/in-flight jobs may need to be retried from the UI
  or service workflow.
- Completed meeting records, transcripts, and analyses should be recovered from
  Postgres.

## 7. Retention Policy

Default policy:

- Keep 14 days of backups.
- Permit `RETENTION_DAYS=7` for disk-constrained VPS operation.
- Reject retention below 7 days unless a future implementation adds an explicit
  override.

Backup directory:

```text
/opt/audiomind/backups
```

Directory requirements:

- Create the directory if missing.
- Prefer owner `deploy:deploy`.
- Use `chmod 700` or `chmod 750`.
- Do not place it inside a Docker volume.
- Run disk preflight against this path before any backup write. This matters on
  the current 40 GB SSD VPS.

Owned file patterns:

- `audiomind-postgres-*.dump`
- `audiomind-postgres-*.dump.sha256`
- `audiomind-uploads-*.tar.gz`
- `audiomind-uploads-*.tar.gz.sha256`
- `audiomind-backup-manifest-*.json`

Implementation must never delete files outside `BACKUP_DIR`.

## 8. Manifest Schema

The implementation should create a JSON manifest for every combined backup run.
The manifest must not include environment variables, credentials, API keys, JWT
secrets, database passwords, or full command output.

Example:

```json
{
  "backup_id": "YYYYMMDDTHHMMSSZ",
  "created_at": "2026-06-07T03:15:00Z",
  "compose_project": "audiomind-prod",
  "backup_dir": "/opt/audiomind/backups",
  "retention_days": 14,
  "files": [
    {
      "type": "postgres",
      "path": "audiomind-postgres-YYYYMMDDTHHMMSSZ.dump",
      "sha256": "...",
      "size_bytes": 123
    },
    {
      "type": "uploads",
      "path": "audiomind-uploads-YYYYMMDDTHHMMSSZ.tar.gz",
      "sha256": "...",
      "size_bytes": 456
    }
  ]
}
```

## 9. Proposed Scripts / Files To Add Or Modify

Add:

- `docs/deploy/7t-ops-b-backup-restore-spec.md`
  This spec.

Implementation phase candidates:

- `scripts/deploy/backup-postgres.sh`
  Update existing script for stable backup dir, checksum, manifest, size check,
  lock, and retention integration.

- `scripts/deploy/backup-uploads.sh`
  New script to archive `audiomind-prod_uploads` read-only.

- `scripts/deploy/backup-prod.sh`
  Optional wrapper that runs Postgres backup, uploads backup, and retention in
  one command.

- `scripts/deploy/restore-postgres-dry-run.sh`
  Optional safe restore validation script. It must not target the production DB
  by default.

- `docs/deploy/backup-restore.md`
  Update the existing generic runbook to reference the production project name,
  `audiomind-prod_*` volumes, `/opt/audiomind/backups`, retention, scp download,
  and dry-run warnings.

Optional:

- `infra/systemd/audiomind-backup.service`
- `infra/systemd/audiomind-backup.timer`

Do not modify:

- real `infra/.env`
- provider defaults that keep Deepgram/Gemini active
- Compose exposure that keeps DB/Redis/AI private

## 10. Step-By-Step Implementation Plan

1. Add a shared production Compose command helper inside backup scripts.
   Use the same stack as `start-prod.sh`, `health-prod.sh`, and
   `check-prod-config.sh`.

2. Add backup directory preflight.
   Create `/opt/audiomind/backups` if missing, verify ownership/permissions,
   confirm it is not a Docker volume, and run `df -Pk` disk checks before any
   backup writes.

3. Add concurrency protection.
   Use `flock` or an equivalent lock file at `/tmp/audiomind-backup.lock`.
   Fail clearly if another backup is running.

4. Harden `backup-postgres.sh`.
   Set `BACKUP_DIR=/opt/audiomind/backups` by default, create timestamped custom
   dumps, write to `.tmp`, validate file size, write checksums, atomically
   rename to the final filename, and avoid printing secrets.

5. Add uploads backup.
   Archive `audiomind-prod_uploads` read-only through a disposable helper
   container. Validate volume name before use and use the same `.tmp` to final
   rename pattern.

6. Add retention cleanup.
   Delete only owned backup file patterns older than `RETENTION_DAYS` inside
   `BACKUP_DIR`. Do not delete `.tmp` files for an active run.

7. Add backup manifest.
   Record timestamp, host, Compose project, service names, volume names, output
   file names, byte sizes, checksums, and retention setting. Keep secrets out
   of the manifest.

8. Add restore dry-run guidance.
   Document `pg_restore --list`, the `postgres:15.7` helper container fallback,
   optional isolated restore, and uploads archive listing. Make production
   overwrite warnings loud.

9. Update `docs/deploy/backup-restore.md`.
   Replace generic volume examples with production-safe names and include local
   download commands.

10. Optionally add systemd timer assets.
   Keep them disabled until explicitly installed on the VPS by the user.

11. Validate only at script/doc level in the implementation PR.
   Do not run Docker build/up, deploy, SSH, or browser smoke from the coding
   agent unless explicitly requested.

## 11. Acceptance Criteria

- A Postgres production backup creates a timestamped file.
- An uploads volume or upload data path backup creates a timestamped archive.
- Backup scripts check disk availability before running.
- Backup scripts fail when available disk is below 2 GB and warn below 5 GB.
- Backup scripts use atomic `.tmp` writes followed by final rename.
- Backup scripts use a lock or `flock` to prevent concurrent runs.
- Backup directory exists with safe ownership and permissions.
- Backup outputs do not include `.env`, API keys, `JWT_SECRET`, or provider
  secrets.
- Backups are stored in a clear VPS directory, defaulting to
  `/opt/audiomind/backups`.
- Retention automatically removes owned backup files older than 7 to 14 days,
  with 14 days as the default recommendation.
- Retention does not delete `.tmp` files from a currently running backup.
- Manifest JSON is created and does not contain secrets.
- There is guidance to download backups to local with `scp`.
- There is a restore guide or dry-run path that does not overwrite production.
- `pg_restore` validation has a `postgres:15.7` container fallback if the VPS
  host does not have `pg_restore`.
- The guide warns not to use `docker compose down -v`,
  `docker volume prune`, or `docker system prune --volumes`.
- Validation commands check that backup files exist and have size greater than
  zero.
- Validation commands can list uploads archives with `tar -tzf`.
- Postgres, Redis, `ai-api`, and `celery-worker` remain private.
- The phase does not switch production away from Deepgram/Gemini.
- No Docker build/up, deploy, SSH, browser smoke, or real `.env` edits are part
  of this spec phase.

## 12. Validation Plan

These commands are for the user to run on the VPS after implementation. Do not
run them during this spec phase.

Postgres backup:

```bash
bash scripts/deploy/backup-postgres.sh

df -h /opt/audiomind/backups
df -Pk /opt/audiomind/backups

ls -lh /opt/audiomind/backups

test -s /opt/audiomind/backups/<postgres-backup>.dump

sha256sum -c /opt/audiomind/backups/<postgres-backup>.dump.sha256

pg_restore --list /opt/audiomind/backups/<postgres-backup>.dump | head
```

If `pg_restore` is not installed on the host:

```bash
docker run --rm \
  -v /opt/audiomind/backups:/backups:ro \
  postgres:15.7 \
  pg_restore --list /backups/<postgres-backup>.dump | head
```

Uploads backup:

```bash
bash scripts/deploy/backup-uploads.sh

ls -lh /opt/audiomind/backups

test -s /opt/audiomind/backups/<uploads-backup>.tar.gz

sha256sum -c /opt/audiomind/backups/<uploads-backup>.tar.gz.sha256

tar -tzf /opt/audiomind/backups/<uploads-backup>.tar.gz | head
```

Combined backup, if implemented:

```bash
bash scripts/deploy/backup-prod.sh

ls -lh /opt/audiomind/backups
```

Local download from Windows PowerShell:

```powershell
scp deploy@14.225.204.225:/opt/audiomind/backups/<backup-file> "$env:USERPROFILE\Downloads\"
scp deploy@14.225.204.225:/opt/audiomind/backups/<backup-file>.sha256 "$env:USERPROFILE\Downloads\"
```

Production safety checks:

```bash
stat -c '%U %G %a %n' /opt/audiomind/backups

docker compose --env-file infra/.env \
  -f infra/docker-compose.dev.yml \
  -f infra/docker-compose.mvp.yml \
  -f infra/docker-compose.prod.yml \
  ps

docker volume inspect audiomind-prod_postgres_data
docker volume inspect audiomind-prod_uploads
```

Exposure checks:

```bash
docker compose --env-file infra/.env \
  -f infra/docker-compose.dev.yml \
  -f infra/docker-compose.mvp.yml \
  -f infra/docker-compose.prod.yml \
  config \
  | grep -A20 -E '^  (db|redis|ai-api|celery-worker):'
```

Confirm from rendered config that `db`, `redis`, `ai-api`, and
`celery-worker` do not publish public ports.

## 13. Rollback / Safety Plan

Backup safety:

- Use logical Postgres dumps instead of copying live database files.
- Check disk capacity before starting backup work.
- Use a lock to avoid concurrent backup runs.
- Write every backup artifact to `.tmp` first, then atomically rename after
  validation and checksum creation.
- Mount uploads read-only during backup.
- Validate every backup file exists and has size greater than zero.
- Write checksums.
- Keep manifests for auditability.
- Do not print secrets.

Restore safety:

- Do not restore over production without a fresh backup.
- Do not restore over production without explicit user confirmation.
- Prefer dry-run validation first.
- Restore into a test DB/container before production when possible.
- Decide uploads merge vs replace before extraction.
- Do not delete production Docker volumes as part of routine restore.

Forbidden destructive commands:

```bash
docker compose down -v
docker volume prune
docker system prune --volumes
```

If a backup implementation fails:

1. Do not delete existing backups.
2. Do not prune volumes.
3. Fix the script and rerun backup validation.
4. If disk pressure occurs, manually inspect `/opt/audiomind/backups` and delete
   only clearly identified old backup files.

## 14. Out Of Scope

- Implementing backup/restore code in this spec phase.
- Running Docker build/up.
- Deploying to the VPS.
- SSH access.
- Browser smoke tests.
- Editing real `infra/.env` or service `.env` files.
- Committing provider secrets.
- Backing up Caddy certificate storage.
- Backing up `model_cache` or `ollama_cache`.
- Re-enabling Whisper/Ollama as default runtime.
- Making private services public.
- Designing cross-region or object-storage backups.

## 15. Risks / Notes

- The existing `scripts/deploy/backup-postgres.sh` is a useful start, but it is
  only a Postgres dump script. It does not cover uploads, retention, checksum,
  manifest, or restore validation.
- `docs/deploy/backup-restore.md` already exists, but it is generic and uses
  older example volume names. Implementation should update it for
  `audiomind-prod` and `/opt/audiomind/backups`.
- Backing up uploads can consume meaningful disk on a 40 GB VPS. Retention and
  disk usage checks matter.
- Redis/job state loss can interrupt in-flight jobs, but default MVP recovery
  should prioritize completed durable data in Postgres plus uploads.
- Upload path consistency matters: DB rows may reference absolute paths such as
  `/app/uploads/<file>`. Restoring the upload volume to the same Compose mount
  preserves those paths.
- The backup directory itself must not live inside a Docker volume that could be
  affected by Compose lifecycle commands.
- Systemd timers should be installed only after manual backup and dry-run
  validation have passed.
