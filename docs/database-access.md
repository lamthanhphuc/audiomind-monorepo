# Database Access Quick Guide

This guide provides quick ways to inspect service databases in local development.

## 1) Connection Profile (PostgreSQL default)

- shared PostgreSQL service: `db` on port `5432`
- database name: `audiomind` (default from `infra/docker-compose.dev.yml`)
- username/password defaults: `audiomind` / `audiomind` (override via env)

Notes:
- Credentials vary by local setup. Do not commit passwords or secrets.
- In this repository's default Docker Compose stack (`infra/docker-compose.dev.yml`), services use PostgreSQL via shared `db:5432`.

## 2) Option A: Docker CLI

```bash
docker exec -it <postgres-container-name> psql -U audiomind -d audiomind
```

Examples (common naming convention):
- `db`
- `audiomind-db-1` (compose-generated name in some environments)

Useful psql checks:

```sql
\dt
SELECT current_database(), current_user;
```

## 3) Option B: GUI Tools (DBeaver / pgAdmin)

Use these parameters:
- Host: `localhost`
- Port: `5432`
- Database: `audiomind`
- Username/Password: from your runtime config or environment variables

Reference connection URI format:

```text
postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@localhost:5432/<POSTGRES_DB>
```

## 4) Option C: Quick Script

Use the helper script:

```powershell
pwsh ./scripts/db-inspect.ps1 -ServiceName user
pwsh ./scripts/db-inspect.ps1 -ServiceName meeting
pwsh ./scripts/db-inspect.ps1 -ServiceName processing
```

Optional parameters:
- `-DbUser root`
- `-DbPassword <runtime-only-value>`
- `-DatabaseType Auto|PostgreSQL|MySQL` (default: `Auto`)
- `-WhatIf` for dry-run command preview

Auto-detect behavior:
- If a PostgreSQL container (for example `db`) is running, script uses `psql`.
- Otherwise script can fall back to MySQL mode only for non-default/custom environments.

Optional container name overrides:
- `DB_INSPECT_USER_CONTAINER`
- `DB_INSPECT_MEETING_CONTAINER`
- `DB_INSPECT_PROCESSING_CONTAINER`

## Security Reminder

- Never commit secrets, raw credentials, or tokens to the repository.
- Prefer CI secrets / local `.env` / secure secret stores for credentials.
