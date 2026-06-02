# Phase 7T DevOps Audit Results

## Scope

Audit/spec-only review of current Docker, env, health/readiness, storage, and MVP deployment readiness. No runtime code changes, Docker commands, real `.env` edits, commits, or pushes were performed.

## Files and Areas Reviewed

- [infra/docker-compose.dev.yml](../../infra/docker-compose.dev.yml)
- [infra/.env.example](../../infra/.env.example)
- [demoRecordAUDIOMID/ai-service/docker-compose.yml](../../demoRecordAUDIOMID/ai-service/docker-compose.yml)
- [demoRecordAUDIOMID/ai-service/.env.example](../../demoRecordAUDIOMID/ai-service/.env.example)
- [demoRecordAUDIOMID/ai-service/.dockerignore](../../demoRecordAUDIOMID/ai-service/.dockerignore)
- [demoRecordAUDIOMID/ai-service/Dockerfile](../../demoRecordAUDIOMID/ai-service/Dockerfile)
- [demoRecordAUDIOMID/ai-service/docker-entrypoint.sh](../../demoRecordAUDIOMID/ai-service/docker-entrypoint.sh)
- [demoRecordAUDIOMID/ai-service/app/config.py](../../demoRecordAUDIOMID/ai-service/app/config.py)
- [demoRecordAUDIOMID/ai-service/app/main.py](../../demoRecordAUDIOMID/ai-service/app/main.py)
- [demoRecordAUDIOMID/ai-service/app/tasks.py](../../demoRecordAUDIOMID/ai-service/app/tasks.py)
- [demoRecordAUDIOMID/ai-service/app/celery_app.py](../../demoRecordAUDIOMID/ai-service/app/celery_app.py)
- [demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py](../../demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py)
- [demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py](../../demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py)
- [demoRecordAUDIOMID/processing-service/Dockerfile](../../demoRecordAUDIOMID/processing-service/Dockerfile)
- [demoRecordAUDIOMID/processing-service/src/main/resources/application.yml](../../demoRecordAUDIOMID/processing-service/src/main/resources/application.yml)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/HealthController.java](../../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/HealthController.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java](../../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java)
- [demoRecordAUDIOMID/meeting-service/Dockerfile](../../demoRecordAUDIOMID/meeting-service/Dockerfile)
- [demoRecordAUDIOMID/meeting-service/docker-entrypoint.sh](../../demoRecordAUDIOMID/meeting-service/docker-entrypoint.sh)
- [demoRecordAUDIOMID/meeting-service/src/main/resources/application.yml](../../demoRecordAUDIOMID/meeting-service/src/main/resources/application.yml)
- [demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/HealthController.java](../../demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/HealthController.java)
- [demoRecordAUDIOMID/user-service/Dockerfile](../../demoRecordAUDIOMID/user-service/Dockerfile)
- [demoRecordAUDIOMID/user-service/src/main/resources/application.yml](../../demoRecordAUDIOMID/user-service/src/main/resources/application.yml)
- [demoRecordAUDIOMID/user-service/src/main/java/com/example/userservice/controller/HealthController.java](../../demoRecordAUDIOMID/user-service/src/main/java/com/example/userservice/controller/HealthController.java)
- [demoRecordAUDIOMID/whisper-service/Dockerfile](../../demoRecordAUDIOMID/whisper-service/Dockerfile)
- [demoRecordAUDIOMID/diarization-service/Dockerfile](../../demoRecordAUDIOMID/diarization-service/Dockerfile)
- [demoRecordAUDIOMID/ai-processing-service/Dockerfile](../../demoRecordAUDIOMID/ai-processing-service/Dockerfile)
- [FE-Audiomind/Dockerfile](../../FE-Audiomind/Dockerfile)
- [FE-Audiomind/.env.example](../../FE-Audiomind/.env.example)
- [FE-Audiomind/.dockerignore](../../FE-Audiomind/.dockerignore)
- [FE-Audiomind/src/services/config.ts](../../FE-Audiomind/src/services/config.ts)
- [FE-Audiomind/src/services/auth.ts](../../FE-Audiomind/src/services/auth.ts)
- [FE-Audiomind/src/services/api.ts](../../FE-Audiomind/src/services/api.ts)

Real env files were only existence-checked, not read:

- `infra/.env`
- `demoRecordAUDIOMID/ai-service/.env`

## CodeGraph Orientation

Required CodeGraph commands were run first:

- `codegraph status`
- `codegraph context "docker compose env health ready deploy Deepgram Gemini Whisper Ollama profiles ai-api processing-api meeting-api user-api web"`
- `codegraph query "docker-compose dev env_file environment ai-api processing-api"`
- `codegraph query "health ready endpoint Dockerfile compose"`
- `codegraph query "Whisper Ollama legacy offline profile docker compose"`
- `codegraph query "CORS API base URL frontend env deploy production"`

CodeGraph reported an up-to-date index with 313 files, 4,269 nodes, and 6,031 edges.

For the docs polish pass, CodeGraph was checked again with:

- `codegraph status`
- `codegraph context "docker compose mvp prod deploy healthcheck env secrets reverse proxy vite cors"`

## Current Compose Service Map

Source: [infra/docker-compose.dev.yml](../../infra/docker-compose.dev.yml)

| Service | Current profile | Port mapping | Depends on | Volumes | Healthcheck | Restart policy | MVP classification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `db` | default | `5432:5432` | none | `postgres_data` | none | none | core |
| `redis` | default | `6379:6379` | none | none | none | none | core |
| `meeting-api` | default | `8081:8081` | `db` | `uploads:/app/uploads` | none | none | core |
| `processing-api` | default | `8082:8082` | `meeting-api`, `ai-api` | `uploads:/app/uploads` | none | none | core |
| `user-api` | default | `8083:8083` | `db`, `redis` | none | none | none | core |
| `ai-api` | default | `8000:8000` | `db`, `redis` | `model_cache`, `uploads`, `job_status` | none | none | core |
| `celery-worker` | default | `8088:8080` | `ai-api`, `db`, `redis` | `model_cache`, `uploads`, `job_status` | none | none | core support worker |
| `web` | default | `8080:80` | none | none | none | none | core |
| `whisper-service` | `legacy-offline` | `8011:8011` | none | `model_cache`, `uploads` | none | none | legacy/offline only |
| `diarization-service` | `legacy-offline` | `8012:8012` | none | `model_cache`, `uploads` | none | none | legacy/offline only |
| `ollama-service` | `legacy-offline` | `11434:11434` | none | `ollama_cache` | none | none | legacy/offline only |
| legacy `processing-service` | `legacy-offline` | `8010:8010` | `whisper-service`, `diarization-service`, `ollama-service` | `uploads` | none | none | legacy/offline only |

Findings:

- The legacy/offline services are already separated by `profiles: ["legacy-offline"]`.
- `celery-worker` is in the default path and is needed for `ai-api` queued processing because `main.py` calls `process_meeting.delay(...)`.
- Compose uses start-order `depends_on`, not readiness conditions.
- No service-level healthchecks are defined even though app health/ready endpoints exist.
- No integrated MVP service defines a restart policy.
- `meeting-api` and `processing-api` Dockerfiles expose `8080`, while their Spring apps listen on `8081` and `8082`; compose mappings use the app ports, but the Dockerfile metadata is misleading.

## Standalone AI Compose Map

Source: [demoRecordAUDIOMID/ai-service/docker-compose.yml](../../demoRecordAUDIOMID/ai-service/docker-compose.yml)

This file is labelled standalone dev only. It defines isolated `db`, `redis`, `api`, and `worker` services, uses GPU/NVIDIA runtime, and defaults analysis to Ollama. It cannot communicate with the integrated `meeting-api`, `processing-api`, shared Redis, or full-stack compose network.

MVP conclusion:

- Do not use this file for MVP integration or production deployment.
- Keep it documented as local AI-service/GPU experimentation only.

## Current Env Precedence Map

### Docker compose env

Current compose interpolation uses `${...}` variables across service `environment` blocks. In normal Docker Compose behavior, those values come from the shell environment and/or the compose project `.env` file. For this repo, the intended Docker template appears to be [infra/.env.example](../../infra/.env.example), and `infra/.env` exists locally but was not read.

### `ai-api` env

`ai-api` has:

- `env_file: ../demoRecordAUDIOMID/ai-service/.env`
- explicit `environment` entries for Deepgram, Gemini, database, Redis, CORS, Celery, and STT ownership settings.

The explicit compose `environment` values should override values from `env_file` at container runtime. The AI-service settings class also has `env_file` pointing to `demoRecordAUDIOMID/ai-service/.env` for local Python execution. The AI-service `.dockerignore` excludes `.env`, so the runtime container should be driven by Docker env rather than a baked-in file.

Risk:

- Production compose should not point directly at a developer-local `demoRecordAUDIOMID/ai-service/.env`. Use a deploy env file or explicit secret injection instead.

### Local AI Python env

`demoRecordAUDIOMID/ai-service/app/config.py` defines `ENV_FILE = Path(__file__).resolve().parent.parent / ".env"` and uses Pydantic `SettingsConfigDict(env_file=...)`. This is appropriate for local Python runs, but should not be the production Docker secret source.

### Frontend env

[FE-Audiomind/src/services/config.ts](../../FE-Audiomind/src/services/config.ts) requires API base env variables in production via `resolveEnv(...)`:

- `VITE_PROCESSING_API_BASE_URL` or `VITE_PROCESSING_SERVICE_URL`
- `VITE_MEETING_API_BASE_URL` or `VITE_MEETING_SERVICE_URL`
- `VITE_API_CPU_BASE` or `VITE_AI_SERVICE_URL`
- `VITE_API_GPU_BASE`
- `VITE_API_BASE`

Optional frontend env:

- `VITE_REALTIME_WS_BASE_URL` or `REACT_APP_WS_URL`
- `VITE_REALTIME_WS_ENABLED` or `REACT_APP_REALTIME_WS_ENABLED`
- `VITE_AUDIO_DEBUG` or `REACT_APP_AUDIO_DEBUG`

[FE-Audiomind/src/services/auth.ts](../../FE-Audiomind/src/services/auth.ts) separately resolves:

- `VITE_USER_API_BASE_URL`
- `VITE_USER_SERVICE_URL`
- fallback `VITE_API_BASE`
- fallback `http://localhost:8083`

Findings:

- [FE-Audiomind/.env.example](../../FE-Audiomind/.env.example) does not include `VITE_USER_API_BASE_URL`.
- [FE-Audiomind/.env.example](../../FE-Audiomind/.env.example) does not include `VITE_REALTIME_WS_BASE_URL`.
- [FE-Audiomind/Dockerfile](../../FE-Audiomind/Dockerfile) accepts `ARG VITE_USER_API_BASE_URL`, but [infra/docker-compose.dev.yml](../../infra/docker-compose.dev.yml) currently passes localhost-oriented build args.

### Service env examples

[infra/.env.example](../../infra/.env.example) includes Deepgram and Gemini settings, speaker stabilization settings, CORS, JWT, Redis, Spring datasource, and provider defaults.

[demoRecordAUDIOMID/ai-service/.env.example](../../demoRecordAUDIOMID/ai-service/.env.example) includes Deepgram, Gemini, legacy local STT/AI flags, storage paths, Celery, STT ownership, and AI-service local runtime settings.

## Current Docker Volume and Storage Map

| Volume | Mounted by | Path | Purpose | MVP backup stance |
| --- | --- | --- | --- | --- |
| `postgres_data` | `db` | `/var/lib/postgresql/data` | PostgreSQL data | back up |
| `uploads` | `meeting-api`, `processing-api`, `ai-api`, `celery-worker`, legacy processing | `/app/uploads` | uploaded audio and shared upload paths | back up if audio retention matters |
| `job_status` | `ai-api`, `celery-worker` | `/app/storage` | AI job state and storage files | operational state, optional backup |
| `model_cache` | `ai-api`, `celery-worker`, `whisper-service`, `diarization-service` | `/app/models` | model cache | not essential for cloud-first MVP |
| `ollama_cache` | `ollama-service` | `/root/.ollama` | Ollama model cache | legacy/offline only |

Storage notes:

- `ai-api` entrypoint chowns `/app/models`, `/app/uploads`, `/app/storage`, and `/app/logs`.
- `meeting-api` entrypoint chowns `/app/uploads` and `/app`.
- `meeting-api` Spring config allows 200 MB file uploads and 210 MB requests.
- `processing-api` Spring config allows 512 MB file uploads and requests.
- `ai-api` config has `max_upload_size_bytes = 524288000` and allowed extensions.
- Upload size limits are not fully normalized across services.

## Current Health and Ready Endpoint Map

| Service | Endpoint | Current behavior |
| --- | --- | --- |
| `meeting-api` | `/health` | returns service status without dependency checks |
| `meeting-api` | `/ready` | checks database via repository count |
| `processing-api` | `/health` | returns service status without dependency checks |
| `processing-api` | `/ready` | checks Redis ping and `ai-api.ready()` |
| `user-api` | `/health` | returns service status without dependency checks |
| `user-api` | `/ready` | checks database and Redis |
| `ai-api` | `/health` | returns provider/config summary and STT actor registry |
| `ai-api` | `/ready` | checks database, Redis, pipeline object, Deepgram key when required, and Gemini key when required |
| `ai-api` | `/metrics` | exposes Prometheus metrics |
| `legacy ai-processing-service` | `/health`, `/ready` | exists in legacy/offline service |
| `whisper-service` | `/health` | exists in legacy/offline service |
| `diarization-service` | `/health` | exists in legacy/offline service |

Missing from compose:

- `pg_isready` healthcheck for `db`.
- `redis-cli ping` healthcheck for `redis`.
- HTTP healthchecks for Spring/FastAPI services.
- nginx/static healthcheck for `web`.
- Worker healthcheck for `celery-worker`.

## Current Cloud-First Guardrails

Present guardrails:

- AI-service defaults normalize `stt_provider` to `deepgram`.
- AI-service defaults normalize `analysis_provider` and legacy `ai_provider` to `gemini`.
- `LOCAL_WHISPER_ENABLED=false`.
- `ALLOW_LEGACY_LOCAL_STT=false`.
- `OLLAMA_ENABLED=false`.
- `ALLOW_LEGACY_LOCAL_AI=false`.
- Deepgram batch/realtime adapter requires `DEEPGRAM_API_KEY` for real transcription.
- Gemini analysis requires `GEMINI_API_KEY` when `analysis_provider=gemini`.
- `ai-api` readiness fails when Deepgram/Gemini are selected but required keys are missing.
- Legacy/offline services are already behind `legacy-offline` profile in the integrated compose.

Risks:

- Standalone AI compose defaults to Ollama/GPU and should stay clearly separated from MVP docs.
- AI-service Dockerfile still installs Whisper dependencies. This may be acceptable for compatibility, but it increases image size and blurs the cloud-first message.
- Production validation checks `ollama_base_url` for localhost even when Ollama is disabled. This is conservative, but production env should still avoid localhost values.

## Current MVP Deploy Blockers

Blockers to address before real MVP deploy:

- No production compose or production override exists for public URLs, CORS, secrets, healthchecks, restart policy, and private network exposure.
- `web` build args in current compose are localhost-based.
- `CORS_ALLOWED_ORIGINS` defaults include localhost and must be replaced for production.
- `JWT_SECRET`, `POSTGRES_PASSWORD`, `DEEPGRAM_API_KEY`, and `GEMINI_API_KEY` need deploy-time secret policy.
- `ai-api` production Docker env should not depend on `demoRecordAUDIOMID/ai-service/.env`.
- Compose has no healthchecks despite app readiness endpoints.
- Compose has no restart policy for core services.
- DB backup/restore and upload volume backup are not documented in deploy docs.
- Upload size limits differ across services.
- `FE-Audiomind/.env.example` is missing user API and realtime WebSocket env coverage.
- Java Dockerfile `EXPOSE` metadata is inconsistent for meeting/processing services.

## Current MVP Deploy Risks

- A production build could accidentally point the browser to `localhost` API URLs.
- CORS could reject the deployed frontend or allow local origins in production.
- Missing Deepgram/Gemini keys could surface only after a user attempts processing if `/ready` is not monitored.
- `depends_on` may start services before dependencies are ready.
- Lack of restart policy may leave the demo down after transient failures.
- Lack of backup plan risks losing meeting/user/transcript data.
- Upload volume growth and Docker logs could fill the VPS disk.
- Published service ports may expose internal APIs unintentionally.
- Legacy/offline services are separated, but future cleanup must avoid reintroducing Whisper/Ollama into the default runtime path.

## Top 5 Implementation Risks

1. Localhost FE URLs: production `web` build args currently need an override so browser API/WebSocket calls do not point to `localhost`.
2. `ai-api` developer-local `env_file`: integrated compose currently references `demoRecordAUDIOMID/ai-service/.env`, which should not be the production Docker secret source.
3. Missing healthchecks/restart policy: services expose useful endpoints, but compose does not yet wire healthchecks or restart behavior.
4. Secrets/default passwords: `JWT_SECRET`, `POSTGRES_PASSWORD`, `DEEPGRAM_API_KEY`, and `GEMINI_API_KEY` need deploy-time values with no committed real secrets.
5. DB/upload backup gap: `postgres_data` and `uploads` need backup/restore docs before real MVP deployment.

## MVP Deploy Recommendation

Use Option A: single VPS + Docker Compose for the first MVP.

Rationale:

- The repository already has an integrated compose topology close to the desired MVP shape.
- Deepgram and Gemini reduce local model/GPU complexity.
- The app needs a controlled demo deployment more than distributed infrastructure.
- The highest-value work is cleanup, env normalization, healthchecks, backup notes, and smoke validation.

Move to managed DB/app services later only after MVP usage proves the need.

## Recommended Implementation Order

1. Clean compose profiles and remove legacy offline services from the core default path.
2. Normalize `.env.example` and deploy env docs.
3. Add or verify healthcheck and readiness for core services.
4. Add MVP smoke checklist scripts/docs.
5. Add restart/logging/storage/backup notes.
6. Prepare production compose or deploy override.
7. User manually runs Docker/browser smoke.
8. After deploy MVP is stable, continue 7U/7V/7W.

## Recommended First Implementation PR Scope

The first implementation PR should be intentionally small and reversible:

- Keep `infra/docker-compose.dev.yml` for local dev.
- Add `infra/docker-compose.mvp.yml` or `infra/docker-compose.prod.yml` as a deploy override.
- Add healthchecks for `db`, `redis`, `web`, `meeting-api`, `processing-api`, `user-api`, and `ai-api`.
- Add restart policies for core services.
- Keep `legacy-offline` services out of the default MVP path.
- Update `infra/.env.example` and `FE-Audiomind/.env.example` only, not real `.env` files.
- Add `docs/deploy/mvp-deploy-guide.md`, `docs/deploy/mvp-smoke-checklist.md`, and `docs/deploy/backup-restore.md`.
- Document reverse proxy/domain/HTTPS/CORS assumptions with template domains only.
- Leave STT, Gemini, canonical transcript, speaker stabilization, search/cache/paragraph features, and runtime behavior unchanged.

## Notes for Next Implementation Phase

Implementation should stay narrowly scoped:

- Add or update compose/profile files and deploy docs.
- Update env examples only, never real `.env` files.
- Add healthchecks/restart policy.
- Add smoke checklist docs or scripts that do not require secrets in source.
- Do not change STT, Gemini, transcript, speaker stabilization, export, or ownership runtime behavior.
- Do not implement cache/search/paragraph/meeting integration features in this phase.
