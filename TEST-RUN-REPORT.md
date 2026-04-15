# Test Run Report
**Date:** 2026-04-15 20:50:37 +07:00
**Executor:** AI Assistant

## Environment Summary
- Docker: ✅ (Docker version 29.2.1)
- Docker Compose: ✅ (Docker Compose version v5.0.2)
- Java: ✅ (openjdk 21.0.9 LTS)
- Node: ✅ (v22.15.0)
- Python: ✅ (Python 3.10.11 configured for test run)
- pwsh: ✅ (PowerShell 7.6.0)
- Backend Services: ✅ (`http://localhost:8083/actuator/health`, `http://localhost:8081/actuator/health`, `http://localhost:8082/health` all returned HTTP 200)
- Flyway Migration Status: ✅
  - user-service: `flyway_schema_history_user` applied baseline `0` and `V1__create_user_table.sql`; `app_users` exists.
  - meeting-service: `flyway_schema_history_meeting` applied baseline `0`, `V1__init_schema.sql`, `V2__add_owner_user_id.sql`; `meeting.owner_user_id` exists.
  - processing-service: N/A (stateless Redis architecture, no JPA/PostgreSQL schema).
- E2E Account Setup: ✅ (`scripts/setup-e2e-account.ps1` created/verified `e2e_test_user`)

## Test Results

| Suite | Command | Status | Notes |
|-------|---------|--------|-------|
| user-service | `cd demoRecordAUDIOMID/user-service && mvn -B test` | PASS | 5 tests passed, 0 failed |
| meeting-service | `cd demoRecordAUDIOMID/meeting-service && ./mvnw -B test` | PASS | 6 tests passed, 0 failed |
| processing-service | `cd demoRecordAUDIOMID/processing-service && ./mvnw -B test` | PASS | 6 tests passed, 0 failed |
| ai-service | `cd demoRecordAUDIOMID/ai-service && python -m pytest` | PASS | 6 tests passed |
| whisper-service | `cd demoRecordAUDIOMID/whisper-service && python -m pytest` | PASS | 3 tests passed |
| diarization-service | `cd demoRecordAUDIOMID/diarization-service && python -m pytest` | PASS | 3 tests passed |
| ai-processing-service | `cd demoRecordAUDIOMID/ai-processing-service && python -m pytest` | PASS | 5 tests passed |
| FE unit | `cd FE-Audiomind && npm test` | PASS | Vitest: 5 tests passed |
| OpenAPI check | `npm run check:openapi` | PASS | No breaking changes; non-breaking additions reported |
| Schema validation | `npm run validate:schema` | PASS | 3 schema files validated |
| Lint | `npm run lint` | PASS | No lint errors |
| FE build | `cd FE-Audiomind && npm run build` | PASS | Vite build succeeded |
| FE E2E | `cd FE-Audiomind && npm run test:e2e:ci` | PASS | 1 Playwright test passed after setting required `E2E_USERNAME`/`E2E_PASSWORD` |

## Failure Details (if any)
No failed suite in final run.

Resolved blockers during remediation:
- Added and enabled Flyway for Java services with `ddl-auto: validate` retained.
- Standardized meeting schema via Flyway (`owner_user_id`, `audio_path`, `created_at`) and added idempotent FK logic.
- Pinned Flyway to `10.22.0` and introduced per-service Flyway history tables to avoid shared-DB checksum collisions.
- Updated Docker Compose DB env fallbacks so Java services always receive valid Postgres credentials.
- Initial FE E2E attempt failed with `ENVIRONMENT_BLOCKED` due missing `E2E_USERNAME` and `E2E_PASSWORD`; re-run passed after setting required environment variables.

## Summary
- Total Suites: 13
- Passed: 13
- Failed: 0
- Skipped: 0
