# MVP Smoke Checklist

Run this after `docker compose config`, build/start, and basic `/ready` checks
succeed.

## API And Container Readiness

- `docker compose ps` shows healthy core services.
- `web` serves the frontend through HTTPS.
- `meeting-api` `/health` returns success.
- `meeting-api` `/ready` returns success.
- `processing-api` `/health` returns success.
- `processing-api` `/ready` returns success.
- `user-api` `/health` returns success.
- `user-api` `/ready` returns success.
- `ai-api` `/health` succeeds from inside the Compose network.
- `ai-api` `/ready` succeeds from inside the Compose network.
- `db`, `redis`, and `ai-api` are not publicly reachable from the internet.
- The reverse proxy preserves WebSocket upgrade headers when realtime is enabled.

Example commands:

```bash
curl -fsS https://app.example.com/
curl -fsS https://api.example.com/meeting/ready
curl -fsS https://api.example.com/processing/ready
curl -fsS https://api.example.com/user/ready
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml exec ai-api python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/ready', timeout=4).read().decode())"
```

## Browser Flow

- Open `https://app.example.com`.
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

## MVP Provider Checks

- Default STT path uses Deepgram.
- Default analysis path uses Gemini.
- `STT_PROVIDER=deepgram`.
- `ANALYSIS_PROVIDER=gemini`.
- `LOCAL_WHISPER_ENABLED=false`.
- `ALLOW_LEGACY_LOCAL_STT=false`.
- Whisper is not loaded for the default Deepgram smoke flow; logs should not
  include `Loading Whisper model`.
- Ollama is not loaded or required for the smoke flow.
- The `legacy-offline` profile is not enabled.
- `DEEPGRAM_DEBUG_RAW_MESSAGES=false`.
- Local MVP smoke can temporarily reduce Gemini waits when quota is exhausted:
  `GEMINI_ANALYSIS_RETRY_MAX_ATTEMPTS=1`,
  `GEMINI_RATE_LIMIT_RETRY_MAX_SECONDS=5`,
  `GEMINI_MAX_TOKENS_RETRY_ENABLED=false`.
- Gemini quota failures should log `GEMINI_QUOTA_EXCEEDED` and fall back clearly
  without exposing the API key. Cache/hash rerun policy is deferred to 7U.

## CORS And WebSocket Checks

- Browser requests originate from `https://app.example.com`.
- API responses are not blocked by CORS.
- Localhost origins are not allowed in the MVP env unless this is a temporary
  staging-only deployment.
- For local-only smoke, use `APP_ENV=development` and set
  `CORS_ALLOWED_ORIGINS=http://localhost:8080,http://127.0.0.1:8080`.
- Realtime WebSocket connects when `VITE_REALTIME_WS_ENABLED=true`.
- Realtime WebSocket URL uses `wss://` on HTTPS deployments.

## Failure Capture

If a smoke step fails, capture:

- Failing URL or UI action.
- Browser console error.
- Network response status and response body.
- Relevant service logs with secrets redacted.
- Output from `docker compose ps`.
- Output from the relevant `/ready` endpoint.
