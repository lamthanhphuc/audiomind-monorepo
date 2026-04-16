---
description: "Use when: planning or running full test workflows, validating command order, and updating test run reports."
name: "Testing Workflow Guidelines"
applyTo:
  - "**/*.test.*"
  - "**/package.json"
---
# Testing Workflow Guidelines

## Preconditions
- Ensure required services are healthy before integration and E2E tests.
- Ensure toolchain prerequisites are available (Java, Node, Python, Docker, PowerShell).
- Ensure required environment variables are set for suites that require real backend credentials.

## Standard Execution Order
- Java Maven tests.
- Python pytest suites.
- Frontend unit tests.
- Root-level checks: OpenAPI, schema validation, lint.
- Frontend build.
- Frontend E2E tests.

## Command Table
| Scope | Command | Expected Outcome |
|---|---|---|
| user-service | `cd demoRecordAUDIOMID/user-service && mvn -B test` | Tests pass with no failures |
| meeting-service | `cd demoRecordAUDIOMID/meeting-service && ./mvnw -B test` | Tests pass with no failures |
| processing-service | `cd demoRecordAUDIOMID/processing-service && ./mvnw -B test` | Tests pass with no failures |
| ai-service | `cd demoRecordAUDIOMID/ai-service && python -m pytest` | Tests pass with no failures |
| whisper-service | `cd demoRecordAUDIOMID/whisper-service && python -m pytest` | Tests pass with no failures |
| diarization-service | `cd demoRecordAUDIOMID/diarization-service && python -m pytest` | Tests pass with no failures |
| ai-processing-service | `cd demoRecordAUDIOMID/ai-processing-service && python -m pytest` | Tests pass with no failures |
| FE unit | `cd FE-Audiomind && npm test` | Vitest passes |
| OpenAPI check | `npm run check:openapi` | No blocking breaking changes |
| Schema validation | `npm run validate:schema` | Schemas validated |
| Lint | `npm run lint` | No lint errors |
| FE build | `cd FE-Audiomind && npm run build` | Build succeeds |
| FE E2E | `cd FE-Audiomind && npm run test:e2e:ci` | Playwright passes |

## Pass/Fail Criteria
- Mark suite as PASS only when command exits successfully and assertions/checks complete.
- Mark suite as FAILED when command exits non-zero due to test or build errors.
- Use `ENVIRONMENT_BLOCKED` only when failure is caused by unmet external prerequisites that cannot be fixed in-run.

## Reporting Requirements
- Update `TEST-RUN-REPORT.md` with:
  - Environment Summary.
  - Test Results table with command and status per suite.
  - Failure details for any failed/blocked run.
  - Final summary totals: passed, failed, skipped.
