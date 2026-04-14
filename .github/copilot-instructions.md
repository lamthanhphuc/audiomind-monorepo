# AudioMind Workspace Guidelines

## Code Style
- Keep changes scoped to the service or package being modified; avoid cross-service refactors unless required by the task.
- Follow existing language/tooling per module: Java (Maven), Python (pytest), TypeScript/Node (ESLint/Jest), FE app (Vite/Vitest/Playwright).
- For PowerShell scripts, use strict and fail-fast patterns already used in this repo (`$ErrorActionPreference = 'Stop'`, `Set-StrictMode -Version Latest`, `Join-Path` for paths).

## Architecture
- This workspace is a polyglot microservice monorepo (Java + Python + TypeScript frontend + infra).
- Respect service boundaries: no direct cross-database access; prefer API/contract integration between services.
- Core architecture and boundary decisions: docs/adr/0001-architecture.md.
- Service/component map and ports: demoRecordAUDIOMID/PROJECT_STRUCTURE.md.

## Build And Test
- Root install: `npm install`
- Root local pipeline (Windows): `npm run dev:full`
- Root local pipeline (Unix-like): `make dev`
- Root tests: `npm test`
- Root lint: `npm run lint`
- Root config/schema checks: `npm run validate:config:node`, `npm run validate:schema`
- OpenAPI checks and client generation: `npm run check:openapi`, `npm run generate:client`

- Java services (inside each service folder):
  - Build/test: `mvn -B test`
- Python services (inside each service folder):
  - Install/test: `pip install -r requirements.txt`, `pytest`
- Frontend app (`FE-Audiomind`):
  - Dev/build/test: `npm run dev`, `npm run build`, `npm run test`
  - E2E: `npm run test:e2e`

## Conventions
- Configuration must be validated at runtime; see docs/architecture/config-loader-pattern.md and docs/architecture/config-validation-runtime.md.
- Do not add hardcoded secret defaults. Use environment variables and existing schema validation flow in packages/contracts/config.schema.json.
- For API evolution, follow breaking-change guidance in docs/architecture/contract-breaking-rules.md.
- Prefer linking to existing docs instead of duplicating runbook/architecture content.

## Key References
- Production runbook: docs/production-runbook.md
- Production readiness and validation context: docs/production-ready-pr-description.md, docs/production-validation-report.md
- AI service integration flow: demoRecordAUDIOMID/ai-service/INTEGRATION.md
- Dev compose stack: infra/docker-compose.dev.yml
- Kubernetes manifests: k8s/base, k8s/deployments, k8s/services, k8s/overlays
