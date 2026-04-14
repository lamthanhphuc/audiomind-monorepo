# Production placeholders

This overlay intentionally uses placeholder values for production handoff.

## Managed PostgreSQL
- Update `db-secret-placeholder.yaml` with real managed database credentials.
- Prefer creating a SealedSecret or external secret instead of committing plain Secret values.

## In-cluster PostgreSQL
- `db-managed-patch.yaml` sets `db-deployment` replicas to `0` for production overlay.
- Keep this setting if using managed PostgreSQL.
