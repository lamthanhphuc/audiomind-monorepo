# Staging overlay

## Managed PostgreSQL
- Database credentials are produced by `sealed-db-secret.yaml` → Secret `audiomind-db-secrets`.
- Seal real values with `kubeseal` into `encryptedData` (see `db-secret.example.yaml` for plaintext shape; do not include the example in `resources`).
- Java services read JDBC URLs (`MEETING_DATABASE_URL` / `USER_DATABASE_URL`); AI/worker read `AI_DATABASE_URL` (SQLAlchemy).

## In-cluster PostgreSQL
- Not rendered in staging. Internal `db-deployment` / Service `db` live only in the **dev** overlay.
- Application Deployments must not point datasource URLs at host `db`.

## Frontend ingress and build-time URLs
- Ingress uses a **unified host** (`app.audiomind.example.com`): API prefixes first, then `/` → `frontend` Service (see `ingress.yaml`).
- Realtime WebSocket traffic uses `/ws/meetings` on the same host (routed to `processing-api`).
- Build the web image with **relative** API bases (same origin), not `localhost`. `FE-Audiomind/Dockerfile` accepts build-args:
  - `VITE_MEETING_API_BASE_URL=/api/meetings`
  - `VITE_PROCESSING_API_BASE_URL=/api/processing`
  - `VITE_USER_API_BASE_URL=/api/users`
  - `VITE_API_BASE=/api/processing`
  - `VITE_API_CPU_BASE=/api/ai`
  - `VITE_REALTIME_WS_BASE_URL=wss://app.audiomind.example.com/ws/meetings` (pathname is replaced at runtime; origin must match ingress host)
  - `VITE_REALTIME_WS_ENABLED=true`
- CI/deploy overrides the container image tag (`audiomind/frontend:0.1.0` → SHA); VITE_* values are baked at **docker build** time.
