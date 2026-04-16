---
description: "Use when: executing or troubleshooting Playwright E2E tests against real backend services."
name: "E2E Testing Guidelines"
applyTo:
  - "**/*.spec.ts"
  - "**/playwright.config.*"
---
# E2E Testing Guidelines

## Required Environment Variables
- `PLAYWRIGHT_REAL_BACKEND=1`
- `E2E_USERNAME`
- `E2E_PASSWORD`

## Optional Environment Variables
- `E2E_USER_SERVICE_BASE_URL`
- `E2E_EMAIL`
- `PLAYWRIGHT_AUDIO_FILE`

## Account Setup Script
- Run `scripts/setup-e2e-account.ps1` before E2E execution to ensure test account existence.
- The setup script is idempotent by design and treats "already exists" API responses as success.

## Run Commands
- CI mode: `cd FE-Audiomind && npm run test:e2e:ci`
- Local mode: `cd FE-Audiomind && npm run test:e2e`
- Headed mode: `cd FE-Audiomind && npm run test:e2e:headed`
- Debug mode: `cd FE-Audiomind && npm run test:e2e:debug`

## Common Failures And Fast Fixes
- `ENVIRONMENT_BLOCKED` due to missing `E2E_USERNAME`/`E2E_PASSWORD`:
  - Export required variables and rerun.
- Unable to reach user-service during account setup:
  - Verify service health and base URL, then rerun setup script.
- Timeout waiting for processing/upload or processing/start response:
  - Verify backend services and dependencies are healthy, then rerun E2E.
- Missing or invalid audio fixture path:
  - Set `PLAYWRIGHT_AUDIO_FILE` to a valid file or use the default fixture path.
