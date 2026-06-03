# Backup And Restore

This runbook covers MVP data preservation for the single-VPS Docker Compose
deployment.

## Data To Preserve

Back up:

- PostgreSQL data in `postgres_data`.
- Uploaded audio and generated artifacts in `uploads`, if retention matters.

Usually optional:

- `job_status`, for in-flight or recent operational job state.

Usually skip for cloud-first MVP:

- `model_cache`
- `ollama_cache`

## PostgreSQL Backup

Create a compressed logical backup:

```bash
mkdir -p backups
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > backups/audiomind-postgres-$(date +%Y%m%d-%H%M%S).sql.gz
```

If shell variables are not exported on the host, substitute the values from
`infra/.env` explicitly.

## Upload Volume Backup

Create an archive of the `uploads` volume:

```bash
mkdir -p backups
docker run --rm -v phase3-worktree_uploads:/data:ro -v "$PWD/backups:/backup" alpine tar czf /backup/audiomind-uploads-$(date +%Y%m%d-%H%M%S).tar.gz -C /data .
```

Confirm the actual Compose project volume name with:

```bash
docker volume ls
```

## Restore Order

1. Stop app services, leaving backups untouched.
2. Restore PostgreSQL.
3. Restore uploads if needed.
4. Start `db` and `redis`.
5. Start `ai-api`, `meeting-api`, `user-api`, and `processing-api`.
6. Start `web`.
7. Run `/ready` checks.
8. Run the MVP smoke checklist.

## PostgreSQL Restore

Stop app services first:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml stop web meeting-api processing-api user-api ai-api celery-worker
```

Restore from a logical backup:

```bash
gunzip -c backups/audiomind-postgres-YYYYMMDD-HHMMSS.sql.gz | docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml exec -T db sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'
```

For a destructive restore into an existing database, create a separate migration
plan first. Do not drop production data as an ad hoc rollback step.

## Upload Restore

Restore an uploads archive into the named volume:

```bash
docker run --rm -v phase3-worktree_uploads:/data -v "$PWD/backups:/backup" alpine sh -c "cd /data && tar xzf /backup/audiomind-uploads-YYYYMMDD-HHMMSS.tar.gz"
```

If restoring over existing files, decide first whether to merge or clear the
target volume. Do not delete volume contents without a separate confirmation.

## Backup Schedule

Suggested MVP minimum:

- PostgreSQL logical backup before each deploy.
- PostgreSQL logical backup daily for active demos.
- Upload archive before each deploy that changes upload handling.
- Weekly disk usage review.

Also configure provider-console budget alerts for Deepgram and Gemini before
running frequent demos.

## Rollback Notes

Rollback should normally switch back to the previous compose/env/revision and
restart services without deleting volumes. Restore data only when the deploy
changed persisted data and a data rollback is explicitly required.
