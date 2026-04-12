---
description: "Run pre-deploy checks by environment (dev/staging/prod): OpenAPI validation, config validation, and smoke test flow."
name: "Pre-Deploy Checks"
argument-hint: "Environment: dev, staging, or prod"
agent: "agent"
---
Run a pre-deploy validation workflow for the target environment provided by the user.

Objectives:
- Validate OpenAPI contracts.
- Validate runtime configuration and schema.
- Run smoke tests appropriate for the target environment.

Required steps:
1. Determine target environment from user input: dev, staging, or prod.
2. Execute contract and config checks from workspace root:
   - `npm run check:openapi`
   - `npm run validate:config:node`
   - `npm run validate:schema`
3. Run smoke tests by environment:
   - dev: prefer local smoke scripts (for example scripts/smoke-e2e.ps1 or tests/smoke-prod.sh equivalent dev-safe flow)
   - staging: run non-destructive smoke suite against staging endpoints
   - prod: run production-safe smoke checks only, no destructive or load test actions
4. Summarize results in a concise report:
   - commands executed
   - pass/fail per step
   - blocking issues
   - go/no-go recommendation

Constraints:
- Do not run destructive chaos or stress tests in this workflow.
- If any step fails, stop and report the exact failing command and likely cause.
