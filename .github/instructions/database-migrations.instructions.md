---
description: "Use when: creating, reviewing, or modifying SQL migrations and Flyway configuration for Java services."
name: "Database Migrations Guidelines"
applyTo:
  - "**/*.sql"
  - "**/db/migration/**"
---
# Database Migrations Guidelines

## Flyway Principles
- Treat Flyway migrations as the single source of truth for schema changes.
- Keep `spring.jpa.hibernate.ddl-auto` as `validate` in runtime configs for DB-backed services.
- Use `baseline-on-migrate` for legacy databases when introducing Flyway incrementally.
- Every entity/schema change must be paired with a migration change in the same PR.

## Idempotent SQL Patterns
- Prefer `CREATE TABLE IF NOT EXISTS` for table creation.
- Prefer `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for additive column changes.
- Prefer `CREATE INDEX IF NOT EXISTS` for index creation.
- For foreign keys and constraints, guard with PostgreSQL conditional checks in a `DO $$ ... $$;` block before adding constraints.
- Avoid destructive statements unless explicitly approved and covered by rollback/backup strategy.

## Per-Service History Table
- When multiple services share one PostgreSQL database, configure a dedicated Flyway history table per service.
- Keep history table naming explicit and service-specific (example: `flyway_schema_history_user`, `flyway_schema_history_meeting`).
- Do not let multiple services write into one shared Flyway history table.

## Migration File Naming Convention
- Tên file phải tuân theo định dạng `V<version>__<verb_object>.sql` (ví dụ: `V1__create_meeting_table.sql`).

## Anti-Patterns
- Do not edit a migration file that has already been applied in shared environments.
- Do not apply manual schema hotfixes directly in DB without creating a migration counterpart.
- Do not mix legacy startup `schema.sql` bootstrap flow with Flyway migration flow in production path.
- Do not rely on service startup ordering to hide migration dependency issues.
