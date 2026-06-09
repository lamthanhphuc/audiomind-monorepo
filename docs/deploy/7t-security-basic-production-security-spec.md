# 7T-Security - Basic Production Security Spec

## 1. Problem summary

7T-Security is a production-security MVP for the current Audiomind VPS shape. It is not a full enterprise security program. The goal is to harden the already validated production path while preserving the flows that passed QA:

- Register/Login
- Realtime recording -> analysis appears automatically
- Normal file upload
- Meeting history/detail
- Re-analyze
- DOCX export
- Owner gate

Production runtime remains:

- STT/transcription: Deepgram
- Analysis/summarization: Gemini
- Offline Whisper/Ollama: not the default runtime path and must not be re-enabled

The main outcomes are:

- Only `22`, `80`, and `443` are public.
- DB, Redis, `ai-api`, and `celery-worker` are not public.
- `web`, `meeting-api`, `processing-api`, and `user-api` are reachable only through Caddy and the production domains.
- Production CORS allows only `https://app.audiomind.pro.vn`.
- Secrets are not committed or printed in logs.
- Upload audio has clear size/type/path traversal guardrails.
- Owner gate remains enforced for detail/export/re-analyze.
- Caddy adds basic security headers and blocks common bot scan paths.
- Spring warnings are cleaned up only where safe.
- SSH/root hardening is documented and staged so the operator does not lock themselves out.

## 2. Current production security baseline

Production domains:

- `https://app.audiomind.pro.vn` -> frontend `web`
- `https://meeting.audiomind.pro.vn` -> `meeting-api`
- `https://processing.audiomind.pro.vn` -> `processing-api`
- `https://user.audiomind.pro.vn` -> `user-api`

Compose layering:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml -f infra/docker-compose.mvp.yml -f infra/docker-compose.prod.yml ...
```

Current network baseline from repo:

- `infra/docker-compose.dev.yml` exposes many local-development ports: `8080`, `8081`, `8082`, `8083`, `8000`, `8088`, `5432`, `6379`, plus legacy-offline profile ports `8010`, `8011`, `8012`, and `11434`.
- `infra/docker-compose.mvp.yml` resets `db` and `redis` ports to empty, resets `ai-api` and `celery-worker` ports to empty, and binds public app/API services to configurable loopback defaults:
  - `WEB_BIND_ADDRESS:-127.0.0.1` / `WEB_HOST_PORT:-8080`
  - `MEETING_API_BIND_ADDRESS:-127.0.0.1` / `MEETING_API_HOST_PORT:-8081`
  - `PROCESSING_API_BIND_ADDRESS:-127.0.0.1` / `PROCESSING_API_HOST_PORT:-8082`
  - `USER_API_BIND_ADDRESS:-127.0.0.1` / `USER_API_HOST_PORT:-8083`
- `infra/docker-compose.prod.yml` is intentionally small and only sets `APP_ENV=production` for `ai-api` and `celery-worker`.
- `infra/.env.production.example` sets the production bind addresses to `127.0.0.1`, sets `CORS_ALLOWED_ORIGINS=https://app.audiomind.pro.vn`, and keeps Deepgram/Gemini as the MVP providers.
- `infra/Caddyfile.example` proxies:
  - `app.example.com` -> `127.0.0.1:8080`
  - `meeting.example.com` -> `127.0.0.1:8081`
  - `processing.example.com` -> `127.0.0.1:8082`
  - `user.example.com` -> `127.0.0.1:8083`
- The Caddy example already sets `encode zstd gzip` and `request_body max_size 512MB` on the processing site, but it does not yet define security headers or bot-path blocking.

Current deploy scripts:

- `scripts/deploy/check-prod-config.sh` validates required files/env keys, blocks placeholders, enforces production providers, renders Compose config, and checks `celery-worker` receives `CORS_ALLOWED_ORIGINS`.
- `scripts/deploy/health-prod.sh` checks all four public domains plus private `ai-api` readiness through Compose and the worker state.
- `scripts/deploy/monitor-prod.sh` checks memory, disk, Docker usage, container state, and health.
- `scripts/deploy/collect-prod-logs-redacted.sh` masks common provider/auth secrets.
- `scripts/deploy/cleanup-prod-safe.sh` is dry-run by default and includes Docker builder cache cleanup as a manual, explicit operation.

## 3. In-scope / out-of-scope

In scope:

- Repo-only audit and implementation plan.
- Production network exposure checks.
- CORS production check.
- `.env`, secret, and log-redaction checks.
- Upload size/type/path traversal hardening plan.
- Owner gate verification plan.
- Caddy security headers and bot path hardening plan.
- Spring Boot warning cleanup plan.
- VPS manual checklist for UFW, public ports, SSH/root hardening, and Docker cleanup.

Out of scope:

- Implementing code/config changes in this spec phase.
- Committing or pushing changes.
- Running Docker build/up/deploy.
- SSHing to the VPS.
- Editing real `infra/.env`.
- Editing the real production Caddyfile on the VPS.
- Changing live firewall or SSH config.
- Enabling Whisper/Ollama as the default path.
- Full enterprise security controls such as WAF, SIEM, SSO, vulnerability scanning platform, secrets manager migration, rate-limiting architecture, or formal penetration testing.

## 4. Threat model MVP

Primary MVP threats:

- Accidental public exposure of PostgreSQL, Redis, `ai-api`, or worker health ports.
- Browser CORS misconfiguration allowing untrusted origins to call APIs with credentials.
- Secret leakage through committed `.env` files, Compose output, logs, exception messages, or shared diagnostics.
- Oversized or unsupported uploads consuming disk/memory/CPU.
- Path traversal or user-controlled filenames writing outside intended upload directories.
- Authorization bypass for another user's meeting detail, report export, saved analysis, or re-analysis.
- Bot scans for `/.git/*`, `/.env`, WordPress/PHPMyAdmin paths, and OS metadata.
- Operator lockout from over-aggressive SSH/root hardening.
- Regressions that accidentally re-enable local Whisper/Ollama or expose internal services.

## 5. Current findings from repo

### Public and private ports

Expected public ports on the VPS:

- `22/tcp` for SSH
- `80/tcp` for Caddy ACME/redirects
- `443/tcp` for HTTPS

Expected non-public services:

- PostgreSQL `5432`
- Redis `6379`
- `ai-api` `8000`
- `celery-worker` health `8080` inside the worker container
- Legacy-offline services `8010`, `8011`, `8012`, `11434`

Repo finding:

- Dev compose exposes many ports for local use.
- MVP/prod compose overlays are designed to remove `db`, `redis`, `ai-api`, and `celery-worker` host ports and bind the frontend plus public APIs to loopback.
- The security audit should validate the rendered production config and live VPS port exposure, because `docker-compose.dev.yml` remains unsafe by itself for production.

### Compose bind address

Repo finding:

- `infra/docker-compose.mvp.yml` uses loopback defaults for `web`, `meeting-api`, `processing-api`, and `user-api`.
- `infra/.env.production.example` pins the same values explicitly.
- The audit script should fail if any production bind address is `0.0.0.0`, empty in a way that Docker interprets as public, or any internal service publishes a host port.

### Caddy reverse proxy domains

Repo finding:

- `infra/Caddyfile.example` contains placeholder domains and proxies to loopback ports `8080`-`8083`.
- Production docs instruct replacing them with the four Audiomind domains.
- No current Caddy security header block or bot-path matcher exists in the template.

### CORS production

Repo finding:

- `infra/.env.production.example` sets `CORS_ALLOWED_ORIGINS=https://app.audiomind.pro.vn`.
- `check-prod-config.sh` requires `CORS_ALLOWED_ORIGINS` and rejects nested env references for public URL values.
- Spring services read `cors.allowed-origins` from `CORS_ALLOWED_ORIGINS`.
- `meeting-service`, `processing-service`, and `user-service` configure `CorsConfigurationSource` with exact allowed origins, common methods, `Authorization`/`Content-Type`/trace headers, and credentials enabled.
- `ai-service` resolves the same comma-separated env value for FastAPI CORS, but `ai-api` is private in production.

Risk:

- Development defaults still include localhost. This is fine for local dev but production checks must explicitly reject localhost in `infra/.env`.

### Secrets and `.env`

Repo finding:

- `.gitignore` ignores `.env`, `.env.*`, and `.env.local`, while allowing example files via `!.env.example` and `!.env.production.example`.
- `infra/.env.production.example` uses placeholders and warns not to commit real secrets.
- `infra/docker-compose.mvp.yml` resets `ai-api` and `celery-worker` `env_file` usage and injects production env values from `infra/.env`; this prevents the production stack from using `demoRecordAUDIOMID/ai-service/.env`.
- `check-prod-config.sh` rejects placeholders for required production env keys.
- `ai-service/app/config.py` still has `env_file` pointing at `demoRecordAUDIOMID/ai-service/.env` for local settings loading, but production Compose provides env vars directly and the MVP override resets `env_file`.

Risk:

- Scripts and docs should keep avoiding raw `docker compose config` output in shared artifacts because rendered config can contain secrets.

### Redacted log collection

Repo finding:

- `collect-prod-logs-redacted.sh` masks `DEEPGRAM_API_KEY`, `GEMINI_API_KEY`, `JWT_SECRET`, `POSTGRES_PASSWORD`, bearer tokens, Google API key-looking values, and OpenAI keys.

Gaps:

- It does not explicitly mask `DATABASE_URL`, `CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND`, `JOB_STATE_REDIS_URL`, `STT_OWNERSHIP_REDIS_URL`, `HUGGINGFACE_TOKEN`, `POSTGRES_USER`, `POSTGRES_DB`, `OPENAI_API_KEY` by key name, or generic `password=`/`secret=` forms beyond the current four-key regex.
- It should preserve useful diagnostics while expanding the redaction patterns.

### Upload size/type/path traversal

Repo finding:

- `meeting-service` upload has:
  - empty-file check
  - file size guard against `MAX_UPLOAD_BYTES`
  - extension allowlist
  - `StringUtils.cleanPath`
  - `..` filename rejection
  - generated UUID storage filename
  - normalized target path must start with upload directory
- `meeting-service` multipart config allows `200MB` file and `210MB` request size.
- `ai-service /api/upload-audio` has:
  - original filename reduced to `Path(...).name`
  - extension allowlist from `allowed_upload_extensions`
  - generated UUID storage filename
  - streamed write in 1 MB chunks
  - size guard against `settings.max_upload_size_bytes`
  - delete-on-too-large
- `ai-service` default max upload is `524288000` bytes, approximately `500MB`, and default extensions are `.wav,.mp3,.m4a,.aac,.flac,.ogg,.webm,.mp4`.
- `processing-service` `/processing/upload` currently forwards the multipart file to `ai-api` without local size/type validation. Its Spring multipart and Tomcat limits are `512MB`.
- `infra/Caddyfile.example` caps processing request bodies at `512MB`.
- Frontend upload UI says `.mp3, .wav, .m4a` and uses `accept="audio/*"`, which is only a browser hint.

Gaps:

- Public ingress is `processing-service`, so the clearest MVP security slice should add explicit processing-layer validation and align Caddy/Spring/AI limits.
- The final accepted extensions and max size should be documented in one place and checked by tests.

### Owner gate coverage

Repo finding:

- `meeting-service` requires a `UserPrincipal` for upload, detail, list, rename, delete, and status update.
- `getById` uses `meetingService.findByIdForOwner(id, principal.userId())`.
- Processing controller requires a principal for analysis, saved analysis, rerun analysis, and report export, then forwards the original `Authorization` header to downstream services.
- Existing production smoke checklist includes "another user cannot access the first user's meeting detail."

Risk:

- The spec should require owner-gate validation for detail, export/report, saved analysis, and re-analysis. Do not rely only on frontend hiding controls.

### Spring generated password warning

Likely cause:

- Spring Security is on the classpath and the services define custom stateless `SecurityFilterChain` plus JWT filters, but they may not define a `UserDetailsService`/`AuthenticationProvider` bean that fully suppresses Boot's default generated user warning.

Recommended handling:

- Treat as warning cleanup, not an emergency security bug, because app endpoints are protected by JWT filters and explicit authorization rules.
- Fix only after verifying each Spring service. Prefer excluding/overriding default user details auto-configuration in a way that does not re-enable form login or basic auth.
- Validate with logs and smoke tests. Do not introduce a real default username/password.

### `spring.jpa.open-in-view` warning

Repo finding:

- `meeting-service` and `user-service` do not set `spring.jpa.open-in-view`.

Recommended handling:

- Set `spring.jpa.open-in-view=false` if controller/service code does not rely on lazy entity loading during JSON serialization.
- Validate meeting detail/history/upload and user login/register flows after the change.

### PostgreSQLDialect warning

Repo finding:

- `meeting-service` and `user-service` set `spring.jpa.properties.hibernate.dialect` from `SPRING_JPA_HIBERNATE_DIALECT`, defaulting to `org.hibernate.dialect.PostgreSQLDialect`.
- `infra/docker-compose.dev.yml` also sets `SPRING_JPA_HIBERNATE_DIALECT=org.hibernate.dialect.PostgreSQLDialect`.

Recommended handling:

- Remove the explicit dialect only if the Spring Boot/Hibernate version auto-detects PostgreSQL cleanly from JDBC metadata.
- Keep driver class and datasource values.
- Validate startup logs and Flyway/JPA schema validation.

### Bot scan `/.git/*`

Repo finding:

- Bot scans to `/.git/HEAD` and `/.git/config` currently return application-level `UNAUTHORIZED`.
- This does not leak contents, but it unnecessarily routes noise into the apps and logs.

Recommended handling:

- Block at Caddy with static `respond 404` or `respond 403` before `reverse_proxy`.
- Include `/.git/*`, `/.env`, `/.DS_Store`, `wp-admin`, `wp-login.php`, `phpmyadmin`, and similar common scans.
- Keep ACME HTTP challenge and normal app routes unaffected.

### SSH/root hardening

Recommended handling:

- Keep `22/tcp` public for now.
- Create/use a non-root deploy user with sudo and validated SSH key login before changing root/password settings.
- Do not disable password auth or root login until a second session confirms key login works.
- Keep a VPS provider console/backdoor recovery path available.

### Docker build cache

Repo finding:

- `cleanup-prod-safe.sh` supports dry-run-first cleanup and, with `--apply --yes`, prunes builder cache older than 168 hours plus stopped containers and dangling images.

Recommended handling:

- Add the 6GB reclaimable Docker build cache to the manual checklist. Use safe cleanup after a fresh backup and health check, not as part of app implementation.

## 6. Proposed slices

### 7T-Security-A - Audit / Baseline Check

- Add `scripts/deploy/security-check-prod.sh` as audit-only.
- Do not change live config.
- 7T-Security-A must be audit-only.
- It must not change firewall, Caddy, Compose, SSH, env, Docker containers, or app configuration.
- It only reports `PASS`/`WARN`/`FAIL` and suggests next actions.
- Check UFW/listening ports, rendered Compose ports, CORS, env placeholders, secrets, `.env` tracking, and public exposure.
- Confirm production providers remain Deepgram/Gemini and legacy local paths remain disabled.
- Output pass/fail with no secret values.
- It must not print the full rendered Docker Compose config because it may contain secrets.
- It should extract only safe fields such as service names, host port bindings, bind addresses, and redacted env presence.
- It should only report current upload limits across Caddy, Spring, `ai-service`, and UI. The canonical production upload limit should be decided and implemented in 7T-Security-D.

Suggested `security-check-prod.sh` severity model:

`FAIL`:

- Internal services publish public host ports.
- Production CORS contains localhost or wildcard.
- Required production env keys are missing or still placeholder values.
- `.env` is tracked by git.
- Whisper/Ollama default runtime is enabled.
- `health-prod.sh` fails.

`WARN`:

- UFW is missing/inactive but provider firewall may still be used.
- Docker build cache is high.
- Spring warning cleanup remains.
- Bot scan paths still reach app layer.
- Upload limits are inconsistent but current flows still work.

`INFO`:

- Current public domains.
- Current bind addresses.
- Current backup/monitor status summary.

### 7T-Security-B - Network / Port Exposure Hardening

- Ensure only `22`, `80`, and `443` are public.
- Ensure DB/Redis/`ai-api`/`celery-worker` are private.
- Ensure `web`, `meeting-api`, `processing-api`, and `user-api` are bound to loopback and reachable only through Caddy.
- Update deploy docs/checks if gaps are found.

### 7T-Security-C - Secrets / Env / Log Redaction

- Confirm real `.env` files are untracked.
- Expand redaction for URLs and additional secret keys.
- Keep docs on placeholders only.
- Avoid logging API keys, JWTs, passwords, Authorization headers, full DB URLs, or raw provider payloads.
- Add redaction tests if practical.

### 7T-Security-D - Upload Size / Type Limit

- Define a single production max upload size and extension/MIME policy.
- Add/verify public ingress validation in `processing-service`.
- Keep `ai-service` streamed size enforcement as downstream defense.
- Keep generated filenames and path traversal guards.
- Return clear `413`/`415`/`400` style errors.
- Align Caddy `request_body`, Spring multipart, AI service max bytes, UI hints, and tests.

### 7T-Security-E - Spring Warning Cleanup

- Suppress generated security password warning safely.
- Set `spring.jpa.open-in-view=false` if compatible.
- Remove unnecessary PostgreSQL dialect config if safe.
- Keep stateless JWT auth and current endpoints intact.

### 7T-Security-F - Caddy Headers / Bot Scan Hardening

- Add basic security headers:
  - `Strict-Transport-Security` after HTTPS is confirmed stable
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY` or an equivalent CSP `frame-ancestors 'none'`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - conservative `Permissions-Policy`
- Block common scan paths at Caddy before reverse proxy.
- Do not break ACME, WebSocket upgrades, uploads, or frontend assets.

### 7T-Security-G - SSH / Root Hardening

- Spec/runbook only at first.
- Validate deploy-user key login before changing SSH settings.
- Keep recovery path through provider console.
- Do not auto-disable root or password login from scripts.

## 7. Recommended implementation order

1. 7T-Security-A - audit-only check first.
2. 7T-Security-C - redaction improvements, because diagnostics must be safe before deeper changes.
3. 7T-Security-B - network exposure hardening checks/docs.
4. 7T-Security-D - upload ingress hardening and aligned limits.
5. 7T-Security-F - Caddy headers and bot-path blocks.
6. 7T-Security-E - Spring warning cleanup after security behavior is covered by tests/smoke.
7. 7T-Security-G - manual SSH/root hardening runbook.

## 8. Files likely to change

Likely scripts/docs:

- `scripts/deploy/security-check-prod.sh`
- `scripts/deploy/collect-prod-logs-redacted.sh`
- `scripts/deploy/check-prod-config.sh`
- `docs/deploy/production-vps-deploy-guide.md`
- `docs/deploy/vietnix-vps-deploy-guide.md`
- `docs/deploy/production-smoke-checklist.md`
- `docs/deploy/monitor-cleanup.md`
- `docs/deploy/backup-restore.md`

Likely infra templates:

- `infra/Caddyfile.example`
- `infra/.env.production.example`
- `infra/docker-compose.mvp.yml`
- `infra/docker-compose.prod.yml`

Likely app/config:

- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java`
- `demoRecordAUDIOMID/processing-service/src/main/resources/application.yml`
- `demoRecordAUDIOMID/meeting-service/src/main/resources/application.yml`
- `demoRecordAUDIOMID/user-service/src/main/resources/application.yml`
- `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/config/SecurityConfig.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/config/SecurityConfig.java`
- `demoRecordAUDIOMID/user-service/src/main/java/com/example/userservice/config/SecurityConfig.java`
- `demoRecordAUDIOMID/ai-service/app/config.py`
- `demoRecordAUDIOMID/ai-service/app/main.py`
- `FE-Audiomind/src/components/features/FeatureUpload.tsx`

Likely tests:

- Spring service tests for upload validation and owner-gated endpoints.
- AI service tests for upload validation and redacted error logging.
- Script tests if the repo has a shell test pattern, otherwise documented manual validation.

## 9. Acceptance criteria

- `health-prod.sh` still passes after security changes.
- `monitor-prod.sh` still passes.
- Only `22`, `80`, and `443` are public.
- DB/Redis/`ai-api`/`celery-worker` are not publicly reachable.
- Production Compose renders `web`, `meeting-api`, `processing-api`, and `user-api` as loopback-only host bindings.
- CORS production only allows `https://app.audiomind.pro.vn`.
- `.env` is not tracked.
- Logs do not expose `GEMINI_API_KEY`, `DEEPGRAM_API_KEY`, `JWT_SECRET`, `POSTGRES_PASSWORD`, bearer tokens, or full secret-bearing URLs.
- Oversized uploads are blocked with a clear error.
- Wrong-type uploads are blocked with a clear error.
- Path traversal filenames cannot write outside the upload directory.
- Owner gate still passes for meeting detail, saved analysis, re-analysis, and DOCX/report export.
- Caddy security headers do not break frontend loading, API calls, WebSockets, or uploads.
- Bot scans for `/.git/*` do not leak content and are blocked before reaching apps.
- SSH/VPS access is not locked out.
- Whisper/Ollama remain disabled in production default runtime.

## 10. Validation plan

Do not run these during the spec phase. These are for the implementation phase/operator.

Production validation on VPS after implementation:

```bash
bash scripts/deploy/security-check-prod.sh
bash scripts/deploy/health-prod.sh
bash scripts/deploy/monitor-prod.sh
```

Windows public port checks:

```powershell
curl http://14.225.204.225:5432
curl http://14.225.204.225:6379
curl http://14.225.204.225:8000
curl http://14.225.204.225:8081
curl http://14.225.204.225:8082
curl http://14.225.204.225:8083
```

Windows TCP reachability checks:

```powershell
Test-NetConnection 14.225.204.225 -Port 5432
Test-NetConnection 14.225.204.225 -Port 6379
Test-NetConnection 14.225.204.225 -Port 8000
Test-NetConnection 14.225.204.225 -Port 8081
Test-NetConnection 14.225.204.225 -Port 8082
Test-NetConnection 14.225.204.225 -Port 8083
```

Expected result: internal ports should not serve public app responses. `TcpTestSucceeded` should be `False` for internal ports. Only `22`, `80`, and `443` should be reachable publicly.

CORS checks:

- From `https://app.audiomind.pro.vn`, API calls succeed.
- From an untrusted origin, API CORS preflight does not grant credentialed access.

Bot path checks:

```bash
curl -i https://app.audiomind.pro.vn/.git/HEAD
curl -i https://meeting.audiomind.pro.vn/.git/config
curl -i https://processing.audiomind.pro.vn/.env
curl -i https://user.audiomind.pro.vn/wp-admin/
```

Browser/domain QA:

- Register/Login
- Realtime recording -> analysis appears automatically
- Upload file
- Meeting history/detail
- Re-analyze
- DOCX export
- Owner gate

Upload validation:

- Valid `.mp3`, `.wav`, and `.m4a` files still work.
- Too-large file fails clearly.
- Unsupported extension fails clearly.
- Filename with traversal-like input does not escape upload storage.

Spring warning validation:

- Startup logs no longer show generated security password after the cleanup slice.
- Startup logs no longer show `spring.jpa.open-in-view` warning after setting it false.
- Startup logs no longer show unnecessary PostgreSQL dialect warning after removing explicit dialect, if that change is made.
- Register/login, meeting history/detail, upload, report export, and re-analysis still work.

## 11. Rollback/safety plan

- Before changing production, run `bash scripts/deploy/backup-prod.sh`.
- Keep the previous checked-out revision and previous `infra/.env`.
- Render Compose config before restart.
- Apply one slice at a time.
- If health or smoke fails, revert to the previous revision and previous `infra/.env`, then restart using the same production Compose files.
- Do not delete Docker volumes during rollback.
- Do not run `docker compose down -v`, `docker volume prune`, or `docker system prune --volumes`.
- For Caddy changes, run `sudo caddy validate --config /etc/caddy/Caddyfile` before reload.
- For SSH hardening, keep an existing SSH session open and verify a second key-based login before disabling root/password auth.

## 12. VPS manual checklist

Network/firewall:

- Confirm provider firewall allows only `22/tcp`, `80/tcp`, and `443/tcp`.
- Confirm UFW, if enabled, allows only the same public ports.
- Confirm no public listener exists for `5432`, `6379`, `8000`, `8080`, `8081`, `8082`, `8083`, `8088`, `8010`, `8011`, `8012`, or `11434`.
- Confirm Caddy is the only public HTTP/HTTPS ingress.

Compose:

- Run rendered config and inspect ports.
- Confirm `db`, `redis`, `ai-api`, and `celery-worker` have no host ports.
- Confirm app/API services bind to `127.0.0.1`.
- Confirm `legacy-offline` profile is not enabled.

Secrets:

- Confirm `infra/.env` exists only on the VPS and is not tracked.
- Confirm placeholders are replaced in `infra/.env`.
- Confirm shared diagnostics use redacted logs only.

Caddy:

- Replace example domains with Audiomind domains.
- Validate and reload Caddy.
- Confirm security headers exist.
- Confirm `/.git/*` and similar scan paths are blocked.
- Confirm uploads and WebSockets still work.

Docker cleanup:

- Run `bash scripts/deploy/cleanup-prod-safe.sh` first.
- Review the dry run.
- Ensure a recent backup exists.
- Only then run `bash scripts/deploy/cleanup-prod-safe.sh --apply --yes` if needed for the reclaimable build cache.

SSH/root:

- Confirm deploy user exists and has sudo.
- Confirm SSH key login works in a new session.
- Keep the old session open while testing.
- Only then consider disabling direct root login or password auth.
- Keep provider console access available.

## 13. Risks / notes

- The dev compose file is intentionally not production-safe by itself. Always use the MVP/prod overlays for production.
- `processing-service` is the public upload ingress, so relying only on downstream AI upload validation is weaker than validating at processing ingress too.
- Caddy `request_body max_size`, Spring multipart limits, AI max bytes, and UI copy must be kept aligned or users will see inconsistent failures.
- Security headers should be added conservatively. A strict CSP may break the Vite-built frontend if introduced without testing.
- Bot-path blocks belong in Caddy for this MVP because they stop noise before app auth/logging, but app-level auth should remain correct.
- Spring warning cleanup can cause subtle behavior changes if `open-in-view=false` exposes lazy-loading assumptions.
- Do not add any default/basic auth user to suppress Spring warnings.
- Do not enable legacy local Whisper/Ollama while working on security.
- SSH/root hardening is operationally risky and should be manual, staged, and reversible.

Recommended next implementation phase:

```text
7T-Security-A - Audit / Baseline Check
```

Do not implement 7T-Security-B/C/D/E/F/G in the same PR.
