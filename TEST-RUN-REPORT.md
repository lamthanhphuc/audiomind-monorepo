# Test Run Report
**Date:** 2026-04-29 09:37:15 +07:00
**Executor:** AI Assistant

## Environment Summary
- Docker: Not checked
- Docker Compose: Not checked
- Java: ✅ (openjdk 21.0.9 LTS)
- Node: ✅ (v22.15.0)
- Python: ✅ (Python 3.10.11 configured for test run)
- pwsh: ✅ (PowerShell 7.6.0)
- Backend Services: Not checked
- Flyway Migration Status: Not checked
- E2E Account Setup: Not checked

## Test Results

| Suite | Command | Status | Notes |
|-------|---------|--------|-------|
| user-service | `cd demoRecordAUDIOMID/user-service && mvn -B test` | PASS | 5 tests passed, 0 failed |
| meeting-service | `cd demoRecordAUDIOMID/meeting-service && ./mvnw -B test` | PASS | 6 tests passed, 0 failed |
| processing-service | `cd demoRecordAUDIOMID/processing-service && ./mvnw -B test` | PASS | 7 tests passed, 0 failed |
| ai-service | `cd demoRecordAUDIOMID/ai-service && python -m pytest` | PASS | 7 tests passed |
| whisper-service | `cd demoRecordAUDIOMID/whisper-service && python -m pytest` | PASS | 3 tests passed |
| diarization-service | `cd demoRecordAUDIOMID/diarization-service && python -m pytest` | PASS | 3 tests passed |
| ai-processing-service | `cd demoRecordAUDIOMID/ai-processing-service && python -m pytest` | PASS | 5 tests passed |
| FE unit | `cd FE-Audiomind && npm test` | PASS | Vitest: 5 tests passed |
| OpenAPI check | `npm run check:openapi` | PASS | No breaking changes; non-breaking additions reported |
| Schema validation | `npm run validate:schema` | PASS | 3 schema files validated |
| Lint | `npm run lint` | PASS | No lint errors (Node warned about module type) |
| FE build | `cd FE-Audiomind && npm run build` | PASS | Vite build succeeded |
| FE E2E | `cd FE-Audiomind && npm run test:e2e:ci` | ENVIRONMENT_BLOCKED | Missing `PLAYWRIGHT_REAL_BACKEND=1` and real backend credentials |

## Failure Details (if any)
- FE E2E: `PLAYWRIGHT_REAL_BACKEND=1` required; `E2E_USERNAME`/`E2E_PASSWORD` not provided.

## Summary
- Total Suites: 13
- Passed: 12
- Failed: 0
- Skipped: 1
