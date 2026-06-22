# Production Smoke Checklist

Run this after DNS, Caddy, Compose config rendering, build, startup, and
container health checks succeed.

## Audit-Only Security Baseline

- Run `bash scripts/deploy/security-check-prod.sh`.
- Confirm the script reports no `FAIL` items.
- Review any `WARN` items before moving to later security hardening slices.
- Treat the script as audit-only: it must not change firewall, Caddy, SSH,
  Compose, Docker containers, or `infra/.env`.
- Do not share full rendered Docker Compose config in smoke notes because it may
  contain secrets.

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
- `docker compose ps` does not show `celery-worker` as `Restarting` or
  `Exited`.
- The rendered Compose config includes
  `celery-worker.environment.CORS_ALLOWED_ORIGINS`.
- `docker inspect celery-worker` shows `CORS_ALLOWED_ORIGINS` in the worker
  environment.
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
- Logs or job output show a successful Deepgram STT request for at least one
  smoke upload.
- Logs or job output show successful Gemini analysis for at least one smoke
  upload, or a clear Gemini quota/rate-limit fallback message if the key is out
  of quota during testing.
- Logs do not expose provider keys, JWTs, raw Deepgram frames, or full
  transcript content.

## Epic 7T PR1 — Stop Tail Preservation

Run after deploying PR1 (`web`, optional `processing-api` log markers).

- Record one mic meeting and stop immediately after the final sentence.
- Confirm the last sentence is present in the transcript (repeat 3–5 times).
- Record one browser-tab meeting with the same fast-stop pattern.
- Confirm browser console shows `REALTIME_FINAL_CHUNK_ENQUEUED` with `postStop: true`.
- Confirm processing logs include `REALTIME_FINALIZE_AFTER_CLIENT_DRAIN` or
  `REALTIME_STOP_FINALIZE_AFTER_DRAIN` for the meeting.
- Confirm no duplicate `stream.stop` finalize errors (`REALTIME_STOP_DUPLICATE_IGNORED`
  is acceptable for idempotent retries).

```bash
bash scripts/log-bundle.sh --since 15m --grep PR1
```

## Epic 7T PR2 — Gemini Recovery + Short Transcript Gate

Run after deploying PR2 (`ai-api`, `celery-worker`, `celery-beat`, `processing-api`, `web`).

- Run `alembic upgrade head` inside `ai-api` before smoke (see rollout spec).
- Confirm `celery-beat` is healthy and exactly one replica is running.
- Upload or record a very short transcript (< 80 normalized chars) and confirm analysis
  is skipped with status/message referencing short content.
- Confirm logs show `ANALYSIS_SKIPPED_SHORT_TRANSCRIPT` (no live Gemini call).
- With fault injection or staging quota limits, confirm retryable analysis failures show
  `ANALYSIS_FAILED_RETRYABLE` in the UI banner ("AI đang quá tải, hệ thống sẽ tự thử lại.").
- Confirm export is blocked while analysis is `ANALYZING` or `ANALYSIS_FAILED_RETRYABLE`
  (unless `retryExhausted=true`).
- Confirm background retry logs appear: `ANALYSIS_BACKGROUND_RETRY_ENQUEUED`,
  `ANALYSIS_BACKGROUND_RETRY_DISPATCH`, or `ANALYSIS_BACKGROUND_RETRY_EXHAUSTED`.
- Confirm Gemini key rotation logs use aliases only: `GEMINI_KEY_SELECTED`, `GEMINI_KEY_FAILED`.

```bash
bash scripts/log-bundle.sh --since 15m --grep PR2
```

## Failure Capture

If a smoke step fails, capture:

- Failing URL or UI action.
- Browser console error.
- Network response status and response body.
- Relevant service logs with secrets redacted.
- Output from `docker compose ps`.
- Output from the relevant `/ready` endpoint.
