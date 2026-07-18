# Staging overlay

## Managed PostgreSQL
- Database credentials are produced by `sealed-db-secret.yaml` → Secret `audiomind-db-secrets`.
- Seal real values with `kubeseal` into `encryptedData` (see `db-secret.example.yaml` for plaintext shape; do not include the example in `resources`).
- Java services read JDBC URLs (`MEETING_DATABASE_URL` / `USER_DATABASE_URL`); AI/worker read `AI_DATABASE_URL` (SQLAlchemy).

## In-cluster PostgreSQL
- Not rendered in staging. Internal `db-deployment` / Service `db` live only in the **dev** overlay.
- Application Deployments must not point datasource URLs at host `db`.
