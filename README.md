# AudioMind Monorepo

AudioMind is a local-first demo stack for meeting capture, realtime speech-to-text, transcript processing, and AI-assisted meeting analysis. The repository includes the React frontend, three Spring services, the Python AI service, a Celery worker, Redis, Postgres, and supporting AI services used by the Docker compose stack.

For deeper service-level details, see [demoRecordAUDIOMID/ai-service/README.md](demoRecordAUDIOMID/ai-service/README.md) and [FE-Audiomind/README.md](FE-Audiomind/README.md).

## Project Layout

- Frontend: [FE-Audiomind](FE-Audiomind)
- user-service: Spring backend for authentication and user data
- meeting-service: Spring backend for meetings and transcript access
- processing-service: Spring backend for orchestration and processing
- ai-service / ai-api: FastAPI service for STT, diarization, and AI analysis
- celery-worker: background worker for AI jobs
- Redis: job state, STT ownership, and worker coordination
- Postgres: persistent application data
- Supporting AI services: Whisper, diarization, and Ollama in local compose

## Prerequisites

- Git
- Docker Desktop
- Docker Compose
- Node.js and npm
- Python 3.11
- Java and Maven, if you want to run the Spring services outside Docker or build them locally; the service Maven wrappers are included
- Optional: Deepgram or OpenAI-compatible API keys if you use realtime STT or AI features that require them

## Fresh Clone Setup

```bash
git clone <repo-url>
cd <repo-root>
```

Create the local infra environment file from the committed template:

```bash
copy infra\.env.example infra\.env
copy demoRecordAUDIOMID\ai-service\.env.example demoRecordAUDIOMID\ai-service\.env
```

Edit `infra/.env` before starting the stack. The most important values are:

- `JWT_SECRET`
- database values if you need to override the defaults
- Redis values if you need to override the defaults
- STT ownership settings such as `STT_ENABLE_DISTRIBUTED_OWNERSHIP`
- AI/STT provider keys if your local setup needs them
- Provider selection values for MVP defaults (`STT_PROVIDER`, `ANALYSIS_PROVIDER`)

If you run the AI service outside Docker, also copy its local template:

```bash
copy demoRecordAUDIOMID\ai-service\.env.example demoRecordAUDIOMID\ai-service\.env
```

## Important Environment Notes

- `.env.example` files are committed templates only.
- `.env` files are local only and must not be committed.
- `infra/.env.example` is not auto-loaded by Compose; you must create `infra/.env` yourself.
- `STT_ENABLE_DISTRIBUTED_OWNERSHIP=true` enables Redis-backed STT ownership so multiple `ai-api` replicas do not claim the same meeting stream.
- Redis must be reachable when distributed STT ownership is enabled.
- Current MVP defaults:
  - `STT_PROVIDER=deepgram`
  - `ANALYSIS_PROVIDER=openai`
  - `DEEPGRAM_REALTIME_MODEL=nova-2`
  - `DEEPGRAM_BATCH_MODEL=nova-2`
  - `DEEPGRAM_LANGUAGE=vi`
  - `LOCAL_WHISPER_ENABLED=false`
  - `OLLAMA_ENABLED=false`
- Keep all real API keys in local `.env` files only; commit placeholders only in `.env.example`.
- `.gitattributes` forces LF for Docker entrypoint scripts to prevent Windows CRLF runtime failures.

## Run With Docker

Validate the compose file first:

```bash
docker compose -f infra/docker-compose.dev.yml config --quiet
```

Build and start the stack:

```bash
docker compose -f infra/docker-compose.dev.yml build
docker compose -f infra/docker-compose.dev.yml up -d
```

If you only changed the AI stack, rebuild the heavy images first:

```bash
docker compose -f infra/docker-compose.dev.yml build ai-api celery-worker
docker compose -f infra/docker-compose.dev.yml up -d --force-recreate
```

For a clean restart:

```bash
docker compose -f infra/docker-compose.dev.yml down
docker compose -f infra/docker-compose.dev.yml up -d --build
```

## Verify Services

Check the running containers:

```bash
docker compose -f infra/docker-compose.dev.yml ps
```

Check Redis:

```bash
docker compose -f infra/docker-compose.dev.yml exec redis redis-cli ping
```

Browser and health URLs:

- Frontend: http://localhost:8080/
- ai-api: http://localhost:8000/health
- meeting-api: http://localhost:8081/health
- processing-api: http://localhost:8082/health
- user-api: http://localhost:8083/health

## Local Validation

Run these checks before committing changes:

```bash
ruff check demoRecordAUDIOMID/ai-service
black --check demoRecordAUDIOMID/ai-service
python -m pytest demoRecordAUDIOMID/ai-service -q
npm run lint
npm test --if-present
docker compose -f infra/docker-compose.dev.yml config --quiet
```

## Realtime STT Ownership

The AI service uses Redis-backed ownership to keep multiple `ai-api` replicas from processing the same meeting stream at the same time. Sticky routing is still recommended for local and production deployments.

## Realtime Transcript Finalization

During recording, the live preview may appear as progressive text. After stop, the frontend hydrates persisted transcript fragments and the final transcript should render multiple segments with timestamps. The UI should not collapse the final result into a fake single `0:00` segment.

## Post-Stop Hydration

After stop, the FE calls the processing transcript endpoint for the meeting and retries hydration briefly so transcript finalization and persistence can complete. If the Redis job-state batch is missing or empty, the processing endpoint falls back to visible fragments from ai-service. If no fragments exist yet, the UI should stay in a waiting or no-transcript state instead of inventing a segment.

Useful Redis debug command:

```bash
docker compose -f infra/docker-compose.dev.yml exec redis redis-cli keys "stt:*"
```

Expected ownership logs include:

- `STT_LEASE_ACQUIRE`
- `STT_LEASE_RENEW`
- `STT_LEASE_RELEASE`

## Browser Test Flow

1. Open http://localhost:8080/
2. Log in or register
3. Create or join a meeting
4. Start realtime transcript capture
5. Record 20 to 40 seconds of speech
6. Stop recording and wait for hydration
7. Confirm the console shows fragments greater than 0
8. Confirm the UI shows multiple segments with timestamps that are not all `0:00`
9. Refresh the page and confirm the transcript remains available

## Troubleshooting

- `JWT_SECRET` warning: create or edit `infra/.env`
- Docker entrypoint `no such file or directory`: rebuild the image and confirm `.gitattributes` keeps entrypoint scripts on LF line endings
- Stale `ai-api` or `celery-worker` image: rebuild `ai-api celery-worker`
- Redis unavailable: check the Redis container and `STT_OWNERSHIP_REDIS_URL`
- If the UI shows Waiting for transcript after stop: check browser console hydration logs, GET `/processing/transcript/{meetingId}`, and ai-api logs for `STT_FRAGMENT_VISIBLE_OUTPUT` rows
- If the UI shows one segment at `0:00`: check whether the endpoint returns one aggregate row without `start_time` and `end_time`; expected responses contain multiple transcript fragments with timestamps
- If Deepgram returns `text_len=0`: likely no speech was detected, the mic volume was too low, the wrong input device was selected, or the audio quality was poor
- Port conflict: stop the other service or change the mapped port before restarting Compose
- npm module type warning: usually non-blocking unless lint or tests fail

## Git Safety

- Do not commit `.env`
- Check before commit:

```bash
git status --short --branch
git diff --check
```

## Service Docs

- [FE-Audiomind/README.md](FE-Audiomind/README.md)
- [demoRecordAUDIOMID/ai-service/README.md](demoRecordAUDIOMID/ai-service/README.md)
