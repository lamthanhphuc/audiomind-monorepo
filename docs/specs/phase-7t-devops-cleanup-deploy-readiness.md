# Phase 7T DevOps Cleanup and MVP Deploy Readiness Spec

## Goal

Phase 7T prepares AudioMind for a minimal MVP deployment by cleaning up the Docker and DevOps plan without changing runtime behavior.

The target MVP runtime keeps the current product path stable:

Deepgram STT/transcription
-> canonical transcript pipeline
-> speaker-stabilized readable/export/UI transcript
-> Gemini analysis/summarization
-> meeting history/detail/export

Whisper, Ollama, pyannote-style local diarization, and the legacy AI processing stack must not be required by the default MVP runtime. They may remain available only as explicit opt-in legacy/offline/dev paths.

## Current Architecture Summary

The current full-stack compose entry point is [infra/docker-compose.dev.yml](../../infra/docker-compose.dev.yml). It defines the main MVP services plus legacy/offline services.

Current default services:

- `db`: PostgreSQL 15.7 with `postgres_data` volume.
- `redis`: Redis 7.2.5 used by user sessions/cache, processing state, Celery, and STT ownership/state.
- `meeting-api`: Spring service on `8081`, owns meeting records and upload persistence.
- `processing-api`: Spring service on `8082`, orchestrates upload/process/status/transcript/export/report calls.
- `user-api`: Spring service on `8083`, owns register/login/logout and user auth.
- `ai-api`: FastAPI service on `8000`, owns STT, transcript persistence, Gemini analysis, readiness, metrics, and realtime STT state.
- `celery-worker`: AI-service worker used by `ai-api` queued processing via `process_meeting.delay(...)`.
- `web`: Vite build served by nginx on `8080`.

Current opt-in legacy/offline services:

- `whisper-service`: local Whisper service, profile `legacy-offline`.
- `diarization-service`: local diarization service, profile `legacy-offline`.
- `ollama-service`: local Ollama service, profile `legacy-offline`.
- `processing-service`: legacy Python AI processing service, profile `legacy-offline`.

There is also a standalone, non-integrated AI compose file at [demoRecordAUDIOMID/ai-service/docker-compose.yml](../../demoRecordAUDIOMID/ai-service/docker-compose.yml). It is labelled standalone dev only and should not be used for integrated MVP deployment.

## Target MVP Deployment Architecture

Preferred MVP target:

- One small VPS running Docker Compose.
- Public HTTPS reverse proxy in front of `web`, `user-api`, `meeting-api`, and `processing-api`.
- `ai-api`, `celery-worker`, `db`, and `redis` kept private on the Docker network.
- Public frontend uses production Vite build args for API and WebSocket URLs.
- CORS is restricted to the deployed frontend origin.
- Deepgram and Gemini API keys are supplied only through deploy-time secrets/env, never committed.
- Uploads, AI job storage, and PostgreSQL data use named volumes with documented backup/restore steps.

For an MVP demo, keep the deployment boring and inspectable. Avoid Kubernetes, multi-region topology, and managed queues until product usage justifies them.

## Reverse Proxy, Domain, and HTTPS Assumptions

MVP deployment should assume a public HTTPS reverse proxy in front of the browser-facing surfaces.

Recommended assumptions:

- Use Caddy or Nginx as the reverse proxy for the first MVP.
- Use a template frontend domain such as `https://app.example.com` in docs only.
- Do not hard-code a real production domain in committed compose or frontend files.
- Feed public domains, API URLs, and WebSocket URLs from deploy env/template values.
- Route public browser traffic to `web`, `user-api`, `meeting-api`, and `processing-api`.
- Keep `db`, `redis`, `ai-api`, and `celery-worker` private on the Docker network unless an operations-only exposure is explicitly documented.
- API routing may use subdomains, such as `https://api.example.com`, or path-based routing, such as `https://app.example.com/api/...`; choose one in deploy docs before implementation.
- CORS should allow only the deployed frontend origin, for example `https://app.example.com`, not localhost in MVP/prod.
- WebSocket routing must preserve upgrade headers when `VITE_REALTIME_WS_ENABLED=true`.

## Deployment Options

### Option A: Single VPS + Docker Compose

Recommended for the current MVP.

Advantages:

- Lowest operational complexity.
- One deploy target for demo and customer validation.
- Existing compose topology is already close to this shape.
- Easy to inspect logs, volumes, health endpoints, and env.
- Low fixed cost.

Trade-offs:

- Backups, monitoring, TLS renewal, and host security are manual responsibilities.
- PostgreSQL and Redis availability are tied to one machine.
- Scaling `ai-api`/`celery-worker` requires extra care around STT ownership, Redis, and resource limits.

### Option B: Managed DB + App Services

Useful after the MVP has stable traffic or stricter uptime needs.

Advantages:

- Managed PostgreSQL backup/restore and observability.
- Easier long-term reliability story for database state.
- App services can move to containers on a PaaS or managed VM group.

Trade-offs:

- Higher cost and setup overhead.
- More environment-specific networking and secrets management.
- Still needs a clear container/runtime contract before migration.

## Compose Profile Proposal

### `dev`

Purpose: local integrated development.

Default services:

- `db`
- `redis`
- `meeting-api`
- `processing-api`
- `user-api`
- `ai-api`
- `celery-worker`
- `web`

Allowed defaults:

- Deepgram STT.
- Gemini analysis.
- Localhost API URLs and local CORS origins.
- Published ports for all services to simplify local debugging.

### `mvp` or `prod`

Purpose: real MVP deployment.

Default services:

- `db`
- `redis`
- `meeting-api`
- `processing-api`
- `user-api`
- `ai-api`
- `celery-worker`
- `web`

Required differences from current dev compose:

- No localhost frontend build args.
- No localhost CORS origins.
- No default `POSTGRES_PASSWORD=audiomind`.
- No empty `JWT_SECRET`, `DEEPGRAM_API_KEY`, or `GEMINI_API_KEY`.
- Add service healthchecks using `/health` and `/ready`.
- Add restart policy for core services.
- Keep `ai-api`, `celery-worker`, `db`, and `redis` private unless intentionally exposed for operations.
- Document volume backup/restore.

## Production Compose Strategy

Keep [infra/docker-compose.dev.yml](../../infra/docker-compose.dev.yml) as the local integrated development compose file. Do not turn the dev compose into a production-only file.

Recommended MVP strategy:

- Create a separate deploy override such as `infra/docker-compose.mvp.yml`.
- `infra/docker-compose.prod.yml` is also acceptable if the team prefers `prod` terminology, but use one name consistently.
- The MVP/prod override should layer production deploy concerns over the dev compose instead of duplicating every service definition.
- The override should provide production build args for `web`, production CORS values, restart policies, healthchecks, and public/private port policy.
- The override should remove or avoid public host port exposure for `db`, `redis`, and `ai-api` unless needed for a documented operations workflow.
- The override should not enable `legacy-offline`.
- Public access should go through the reverse proxy, not through many directly exposed service ports.

Preferred implementation command shape for later user-run deployment:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml config
```

This task does not create or run that override; it defines the target plan for the next implementation slice.

### `legacy-offline`

Purpose: explicit local/offline experiments only.

Services:

- `whisper-service`
- `diarization-service`
- `ollama-service`
- legacy Python `processing-service`

Rules:

- Must not start with the default MVP profile.
- Must not be required when `STT_PROVIDER=deepgram` and `ANALYSIS_PROVIDER=gemini`.
- Must require explicit flags such as `LOCAL_WHISPER_ENABLED=true`, `ALLOW_LEGACY_LOCAL_STT=true`, `OLLAMA_ENABLED=true`, and `ALLOW_LEGACY_LOCAL_AI=true` before becoming a runtime path.

## Core Services Required for MVP

Required:

- `db`: stores meetings, users, transcripts, analysis metadata, and schema migrations.
- `redis`: stores job state, user-service Redis state, Celery broker/result data, and STT ownership/state.
- `meeting-api`: meeting ownership, upload persistence, history/detail.
- `processing-api`: processing orchestration, status, transcript, analysis, TXT/CSV transcript export, DOCX report export.
- `user-api`: register/login/logout and JWT issuance.
- `ai-api`: Deepgram STT, canonical transcript persistence, Gemini analysis, realtime STT, health/ready/metrics.
- `celery-worker`: asynchronous AI processing worker for queued processing jobs.
- `web`: built frontend served by nginx.

Supporting external services:

- Deepgram API.
- Gemini API.

## Services Out of Default Path

Out of the MVP default path:

- `whisper-service`
- `diarization-service`
- `ollama-service`
- legacy Python `processing-service`
- standalone AI GPU compose at [demoRecordAUDIOMID/ai-service/docker-compose.yml](../../demoRecordAUDIOMID/ai-service/docker-compose.yml)

These may remain for local/offline experiments, but they should be documented as non-MVP and opt-in.

## Env and Secrets Policy

Secrets that must never be committed:

- `DEEPGRAM_API_KEY`
- `GEMINI_API_KEY`
- `OPENAI_API_KEY` if used later
- `JWT_SECRET`
- `POSTGRES_PASSWORD`
- provider tokens such as `HUGGINGFACE_TOKEN` when enabled

MVP env sources:

- Docker Compose variable interpolation should use a deploy-specific env file such as `infra/.env`, provided manually on the target host.
- `infra/.env.example` should be the canonical Docker/deploy template.
- `demoRecordAUDIOMID/ai-service/.env.example` should remain the canonical local Python AI-service template.
- Real `.env` files must remain untracked and should not be copied into images.
- `ai-api` currently uses `env_file: ../demoRecordAUDIOMID/ai-service/.env`; for MVP this should be replaced or overridden with the deploy env source so Docker deployment does not depend on a developer-local Python `.env`.

Env precedence policy:

- Shell or explicit compose `--env-file` values should supply interpolation for compose.
- Compose `environment` should define service runtime env.
- Compose `env_file` may provide defaults, but must not point to a developer-local secret file in production.
- In `ai-api`, explicit container environment should override values from `env_file`; Pydantic settings also know about `/app/.env`, but `.dockerignore` excludes `.env`, so deploy env should come from Docker runtime env.

Frontend env policy:

- Production must provide `VITE_MEETING_API_BASE_URL`.
- Production must provide `VITE_PROCESSING_API_BASE_URL`.
- Production must provide `VITE_USER_API_BASE_URL`.
- Production must provide `VITE_API_BASE` if the app keeps using `API_BASE` as the processing umbrella URL.
- Production should provide `VITE_REALTIME_WS_BASE_URL` when realtime WebSocket is enabled.
- `FE-Audiomind/.env.example` should include `VITE_USER_API_BASE_URL` and `VITE_REALTIME_WS_BASE_URL` because auth and realtime paths already use them.

## Target Files for Implementation

Expected target files for the next 7T implementation PR:

- [infra/docker-compose.dev.yml](../../infra/docker-compose.dev.yml): preserve local dev behavior; only make minimal cleanup if needed.
- `infra/docker-compose.mvp.yml` or `infra/docker-compose.prod.yml`: new MVP/prod override if implementation chooses a separate file.
- [infra/.env.example](../../infra/.env.example): canonical Docker/deploy env template.
- [FE-Audiomind/.env.example](../../FE-Audiomind/.env.example): frontend API/WebSocket env template.
- `docs/deploy/mvp-deploy-guide.md`: deploy guide for single-VPS MVP.
- `docs/deploy/mvp-smoke-checklist.md`: browser and API smoke checklist.
- `docs/deploy/backup-restore.md`: PostgreSQL/upload backup and restore notes.

Files that must not be edited or committed:

- `infra/.env`
- `demoRecordAUDIOMID/ai-service/.env`
- logs, audio dumps, zip/debug artifacts, `.codegraph/`, `.github/skills/`

## Health and Readiness Checklist

Required service endpoints:

- `meeting-api`: `/health`, `/ready`; readiness checks database.
- `processing-api`: `/health`, `/ready`; readiness checks Redis and `ai-api`.
- `user-api`: `/health`, `/ready`; readiness checks database and Redis.
- `ai-api`: `/health`, `/ready`, `/metrics`; readiness checks database, Redis, pipeline, Deepgram key when Deepgram is selected, and Gemini key when Gemini is selected.
- `web`: nginx static site should have a simple HTTP healthcheck against `/`.
- `db`: use `pg_isready`.
- `redis`: use `redis-cli ping`.
- `celery-worker`: current worker starts a health server on `WORKER_HEALTH_PORT=8080`; compose should add a healthcheck once the exact endpoint is verified.

Readiness rules:

- Reverse proxy should route only to ready services.
- Compose `depends_on` should use health conditions where supported, not only service start order.
- `/ready` should fail if required secrets or dependencies are missing.
- `/health` should remain lightweight and not require external provider calls.

## Storage and Backup Plan

Current Docker volumes:

- `postgres_data`: PostgreSQL database data.
- `uploads`: mounted to `/app/uploads` for `meeting-api`, `processing-api`, `ai-api`, `celery-worker`, and legacy processing.
- `job_status`: mounted to `/app/storage` for `ai-api` and `celery-worker`.
- `model_cache`: mounted to `/app/models` for `ai-api`, `celery-worker`, and legacy/offline model services.
- `ollama_cache`: legacy/offline Ollama model cache.

MVP plan:

- Back up `postgres_data` with `pg_dump` before deploys and on a schedule.
- Back up `uploads` if audio files and exported artifacts must be retained.
- Treat `job_status` as operational state; back it up only if recovery of in-flight job details is required.
- Do not back up `model_cache` or `ollama_cache` for cloud-first MVP unless legacy/offline profile is intentionally used.
- Document restore order: stop app services, restore database, restore uploads, start db/redis, start APIs, run smoke checklist.

## Basic Monitoring and Logging Plan

Minimum MVP monitoring:

- Compose healthchecks for all core services.
- Restart policy for core services, likely `unless-stopped` for VPS MVP.
- Central log review via `docker compose logs` plus documented log retention.
- Alert or manual check for `/ready` failures.
- Track `ai-api` `/metrics` and Spring actuator metrics where available.
- Track Deepgram/Gemini failure counts in logs.
- Track disk usage for `postgres_data`, `uploads`, and Docker logs.

Avoid logging:

- Provider API keys.
- JWTs.
- Raw Deepgram frames in normal MVP mode.
- Full transcript content in production logs unless explicitly required for a debug session.

## Cost Guard Plan for Deepgram and Gemini

Current guards:

- `ai-service` has `MAX_UPLOAD_SIZE_BYTES` with a 500 MB default.
- Spring upload limits are 200 MB for `meeting-api` and 512 MB for `processing-api`.
- Gemini analysis has input/output token limits and retry settings.
- Gemini long-input behavior includes truncation/logging of token counts.
- Deepgram batch and realtime configs log effective model/language/audio byte metadata.

MVP cost guard requirements:

- Normalize upload size limits across FE, `meeting-api`, `processing-api`, and `ai-api`.
- Add an explicit audio duration limit in docs or code before broad beta usage.
- Prefer small default Deepgram/Gemini models for MVP.
- Keep `DEEPGRAM_DEBUG_RAW_MESSAGES=false`.
- Keep realtime enabled only where needed.
- Document expected cost per smoke test and per demo session.
- Add manual budget alerts in Deepgram and Google/Gemini consoles.
- For now, do not implement 7U cache/hash policy in this phase.

## Production Smoke Checklist

Run manually after deployment:

- Register a new user.
- Login with that user.
- Upload Vietnamese audio.
- Upload English audio.
- Confirm readable transcript renders.
- Confirm speaker labels are stable in readable transcript.
- Confirm Gemini analysis is generated.
- Confirm meeting history lists the meetings.
- Confirm meeting detail opens for the owner.
- Export raw TXT transcript.
- Export readable TXT transcript.
- Export DOCX report.
- Confirm owner gate blocks another user.
- Confirm default runtime does not require Whisper.
- Confirm default runtime does not require Ollama.
- Confirm `/ready` is healthy for `meeting-api`, `processing-api`, `user-api`, and `ai-api`.

## Manual Smoke Commands

These commands are documentation targets for the user or implementer to run manually during the later deploy/smoke phase. The agent should not run Docker in this docs-polish phase.

Validate compose rendering:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml config
```

Inspect running services:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml ps
```

Check health and readiness through the deployed routes or local host ports, depending on the deployment topology:

```bash
curl -fsS https://app.example.com/health
curl -fsS https://api.example.com/meeting/health
curl -fsS https://api.example.com/meeting/ready
curl -fsS https://api.example.com/processing/health
curl -fsS https://api.example.com/processing/ready
curl -fsS https://api.example.com/user/health
curl -fsS https://api.example.com/user/ready
curl -fsS http://ai-api:8000/health
curl -fsS http://ai-api:8000/ready
```

If path-based routing is chosen instead of API subdomains, adjust the API paths in the deploy guide. Do not hard-code real production domains in committed examples.

Browser smoke:

- Open the deployed frontend.
- Register and login.
- Upload Vietnamese audio.
- Upload English audio.
- Verify transcript, speaker stability, Gemini analysis, history/detail, exports, and owner gate.

## Rollback Plan

For compose/deploy cleanup:

1. Keep the last known-good compose file and env file on the host.
2. Before changes, back up `postgres_data` with `pg_dump` and preserve the `uploads` volume.
3. Deploy new compose/profile changes without deleting existing volumes.
4. If smoke fails, switch back to the previous compose/env, restart services, and rerun `/ready` checks.
5. Do not delete Docker images, containers, or volumes as part of rollback unless a separate migration plan explicitly requires it.

## Risks

- `ai-api` currently references the developer-local `demoRecordAUDIOMID/ai-service/.env` through compose `env_file`; production should not depend on this path.
- Current compose has no service-level healthchecks even though app endpoints exist.
- Current compose has no restart policy on the integrated MVP services.
- Current `web` build args are localhost-based and unsuitable for deployed production without override.
- `FE-Audiomind/.env.example` omits `VITE_USER_API_BASE_URL` and `VITE_REALTIME_WS_BASE_URL`.
- Default Postgres fallback credentials in compose are acceptable for local dev only.
- `meeting-api` and `processing-api` Dockerfiles expose `8080` while apps listen on `8081` and `8082`; this is confusing and should be normalized.
- Upload/file size limits differ across services.
- Production URL, HTTPS, and CORS assumptions are not yet captured in a deploy document.
- Legacy/offline code paths still exist and must stay opt-in.

## Recommended Implementation Order

1. Clean compose profiles and remove legacy offline services from the core default path.
2. Normalize `.env.example` and deploy env docs.
3. Add or verify healthcheck and readiness for core services.
4. Add MVP smoke checklist scripts/docs.
5. Add restart/logging/storage/backup notes.
6. Prepare production compose or deploy override.
7. User manually runs Docker/browser smoke.
8. After deploy MVP is stable, continue 7U/7V/7W.

## Implementation Slices

### 7T-A Compose/Env Cleanup

Goal: make the existing dev compose and env templates unambiguous.

Deliverables:

- Preserve `infra/docker-compose.dev.yml` as local dev.
- Keep `legacy-offline` opt-in only.
- Normalize `infra/.env.example` with Deepgram, Gemini, JWT, DB, CORS, FE API URL, and realtime WebSocket placeholders.
- Normalize `FE-Audiomind/.env.example` with meeting, processing, user, umbrella API, and realtime WebSocket variables.
- Remove production reliance on developer-local `demoRecordAUDIOMID/ai-service/.env` in the proposed deploy path.

### 7T-B MVP Compose Override + Healthchecks

Goal: create a low-risk MVP/prod override without rewriting the dev compose.

Deliverables:

- Add `infra/docker-compose.mvp.yml` or `infra/docker-compose.prod.yml`.
- Add healthchecks for `db`, `redis`, `web`, `meeting-api`, `processing-api`, `user-api`, and `ai-api`.
- Add restart policy for core services.
- Keep `db`, `redis`, and `ai-api` off public host ports unless explicitly needed.
- Configure production build args for `web` from env/template values.

### 7T-C Deploy Docs + Smoke Checklist

Goal: make deployment repeatable enough for MVP demo use.

Deliverables:

- Add `docs/deploy/mvp-deploy-guide.md`.
- Add `docs/deploy/mvp-smoke-checklist.md`.
- Add `docs/deploy/backup-restore.md`.
- Include reverse proxy, domain, HTTPS, CORS, backup, rollback, and smoke steps.

### 7T-D User Manual Docker/Browser Smoke

Goal: let the user validate the deployed MVP manually.

Deliverables:

- User runs compose config validation.
- User starts/restarts Docker services on the deploy host.
- User checks `docker compose ps`.
- User checks `/health` and `/ready`.
- User performs browser smoke for auth, upload, transcript, analysis, exports, and owner gate.

### 7T-E Optional Deploy Host Hardening

Goal: document basic VPS hygiene after the MVP path works.

Deliverables:

- Host firewall notes.
- HTTPS renewal notes if using Nginx instead of Caddy automation.
- Log retention and disk usage notes.
- Backup schedule notes.
- Minimal monitoring or alerting notes.

## Definition of Done

Phase 7T implementation is done when all measurable checks below are true:

- Core compose starts without the `legacy-offline` profile.
- Whisper/Ollama services are not started by default.
- Healthchecks exist for `db`, `redis`, `web`, `meeting-api`, `processing-api`, `user-api`, and `ai-api`.
- Restart policy exists for core services.
- FE production build args are configurable and not localhost-only.
- Env examples include Deepgram, Gemini, JWT, DB, FE API URLs, and realtime WebSocket variables.
- No real `.env` file is edited or committed.
- Smoke checklist documents register/login, Vietnamese upload, English upload, transcript, analysis, export, and owner gate.
- Rollback and backup docs exist.
- Default runtime remains Deepgram plus Gemini.

## Implementation Guardrails

- Do not change STT/Gemini runtime behavior.
- Do not change the 7Q canonicalizer.
- Do not change 7S speaker stabilization or timeline ordering behavior.
- Do not implement 7U cache/hash policy.
- Do not implement 7V search.
- Do not implement 7W paragraph mode.
- Do not delete legacy code in the first 7T implementation PR.
- Do not deploy the app for real inside the implementation task; the user will deploy and test manually.
- Do not run Docker build/up/down as part of docs polish or implementation unless the task explicitly changes to a user-run smoke phase.

## Out of Scope

- Do not implement 7U cache/hash policy.
- Do not implement 7V search.
- Do not implement 7W paragraph mode.
- Do not implement Zoom/Meet integration.
- Do not build team workspace/share.
- Do not change STT/Gemini runtime behavior.
- Do not deploy the app for real in this phase.
- Do not run Docker build/up/down in this phase.
- Do not edit real `.env` files in this phase.
