# Database Access Quick Guide

This guide provides quick ways to inspect service databases in local development.

## 1) Connection Profiles (MySQL dev profile)

- user-service: `userdb` on port `3306`
- meeting-service: `meetingdb` on port `3307`
- processing-service: `processingdb` on port `3308`

Notes:
- Credentials vary by local setup. Do not commit passwords or secrets.
- In this repository's default Docker Compose stack (`infra/docker-compose.dev.yml`), services currently use PostgreSQL via shared `db:5432`. Use this MySQL profile only when your environment provides per-service MySQL instances.

## 2) Option A: Docker CLI

```bash
docker exec -it <mysql-container-name> mysql -u root -p
```

Examples (common naming convention):
- `user-mysql`
- `meeting-mysql`
- `processing-mysql`

## 3) Option B: GUI Tools (DBeaver / MySQL Workbench)

Use these parameters:
- Host: `localhost`
- Port: service-specific (`3306`, `3307`, `3308`)
- Database: `userdb` / `meetingdb` / `processingdb`
- Username/Password: from your runtime config or environment variables

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
- Otherwise script falls back to MySQL mode.

Optional container name overrides:
- `DB_INSPECT_USER_CONTAINER`
- `DB_INSPECT_MEETING_CONTAINER`
- `DB_INSPECT_PROCESSING_CONTAINER`

## Security Reminder

- Never commit secrets, raw credentials, or tokens to the repository.
- Prefer CI secrets / local `.env` / secure secret stores for credentials.
