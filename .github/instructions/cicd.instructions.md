---
description: "Use when: editing GitHub workflows or CI/CD pipeline behavior under .github/workflows."
name: "CI CD Guidelines"
applyTo:
  - .github/workflows/**/*.yml
  - .github/workflows/**/*.yaml
---
# CI/CD Guidelines

## Workflow Purpose Baseline
Main workflows in this repository include:
- `ci.yml`: build, lint, tests, contract checks, commit checks.
- `ci-cd.yaml`: build/test plus image build-and-push and deploy pipeline steps.
- `contract-check.yml`: OpenAPI/schema/client drift checks.
- `security-recheck.yml`: dependency security checks.
- `smoke-test.yml`: real-backend smoke verification.

## Rules for Editing Workflows
- Do not change workflow triggers/branches without explicit request.
- Preserve branch protection compatibility (`main` protected flow via PR).
- Keep retries and timeout logic explicit for flaky external dependencies.
- Avoid removing validation gates unless replacement gate is provided.

## Adding New Jobs
- Keep job names clear and action-oriented.
- Define `needs` dependencies explicitly.
- Ensure new jobs report failures clearly and fail fast on blocking errors.
- Prefer reusable scripts for long shell blocks.

## Debugging CI Failures
1. Identify first failing step and command.
2. Classify failure type: code regression, env missing, external transient, permissions.
3. Re-run equivalent command locally if possible.
4. Document root cause and corrective action in PR notes.

## Safety Rules
- Do not expose secrets in logs.
- Keep `continue-on-error` only for non-blocking/reporting tasks.
- If a job is intentionally non-blocking, add comment explaining why.
