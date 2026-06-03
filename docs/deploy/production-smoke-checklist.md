# Production Smoke Checklist

Run this after DNS, Caddy, Compose config rendering, build, startup, and
container health checks succeed.

## Public Readiness

- `https://app.<domain>/` serves the frontend over HTTPS.
- `https://meeting.<domain>/health` returns success.
- `https://meeting.<domain>/ready` returns success.
- `https://processing.<domain>/health` returns success.
- `https://processing.<domain>/ready` returns success.
- `https://user.<domain>/health` returns success.
- `https://user.<domain>/ready` returns success.
- The TLS certificate is valid for all four public subdomains.
- Browser requests originate from `https://app.<domain>`.
- API responses are not blocked by CORS.
- Realtime WebSocket URL uses `wss://processing.<domain>/ws/meetings`.
- Realtime WebSocket connects when `VITE_REALTIME_WS_ENABLED=true`.

Example commands:

```bash
curl -fsS https://app.<domain>/
curl -fsS https://meeting.<domain>/ready
curl -fsS https://processing.<domain>/ready
curl -fsS https://user.<domain>/ready
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml exec ai-api python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/ready', timeout=4).read().decode())"
```

## Private Exposure

- `docker compose ps` shows healthy core services.
- `db` is not reachable from the internet.
- `redis` is not reachable from the internet.
- `ai-api` is not reachable from the internet.
- `celery-worker` is not reachable from the internet.
- Public host ports are limited to SSH, HTTP, and HTTPS.
- Compose service ports for `web`, `meeting-api`, `processing-api`, and
  `user-api` are bound to `127.0.0.1`.

## Browser Flow

- Open `https://app.<domain>`.
- Register a new user.
- Log out and log back in as that user.
- Upload a Vietnamese audio file.
- Confirm a readable transcript appears.
- Confirm speaker labels are stable in the readable transcript.
- Confirm Gemini analysis is generated.
- Upload an English audio file.
- Confirm transcript and analysis work for the English file.
- Open meeting history and confirm both meetings are listed.
- Open meeting detail and confirm the owner can view the meeting.
- Export raw TXT transcript.
- Export readable TXT transcript.
- Export CSV transcript if available in the UI.
- Export DOCX report.
- Confirm another user cannot access the first user's meeting detail.

## Provider Checks

- Default STT path uses Deepgram.
- Default analysis path uses Gemini.
- `STT_PROVIDER=deepgram`.
- `ANALYSIS_PROVIDER=gemini`.
- `AI_PROVIDER=gemini`.
- `LOCAL_WHISPER_ENABLED=false`.
- `ALLOW_LEGACY_LOCAL_STT=false`.
- `OLLAMA_ENABLED=false`.
- `ALLOW_LEGACY_LOCAL_AI=false`.
- The `legacy-offline` profile is not enabled.
- Logs do not include `Loading Whisper model`.
- Logs do not expose provider keys, JWTs, raw Deepgram frames, or full
  transcript content.

## Failure Capture

If a smoke step fails, capture:

- Failing URL or UI action.
- Browser console error.
- Network response status and response body.
- Relevant service logs with secrets redacted.
- Output from `docker compose ps`.
- Output from the relevant `/ready` endpoint.
