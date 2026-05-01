---
description: "Use when: editing Dockerfiles, docker-compose files, or container runtime configuration."
name: "Docker Guidelines"
applyTo:
  - "**/Dockerfile"
  - "**/docker-compose*.yml"
  - "**/docker-compose*.yaml"
---
# Docker Guidelines

## Dockerfile Best Practices
- Prefer multi-stage builds when feasible.
- Keep image layers cache-friendly (copy dependency manifests before source copy where practical).
- Use non-root runtime user for application containers whenever possible.
- Keep image base versions explicit and reviewed.

## Compose Rules (Dev/Staging)
- Keep environment-specific differences explicit (dev vs staging/prod).
- Use descriptive service names aligned with runtime architecture.
- Do not silently change exposed ports without updating related docs.

## Health and Restart
- Define health checks for long-running services when practical.
- Use restart policy consistent with environment and failure behavior.
- Document required dependencies (`depends_on`) when startup order matters.

## Secret Handling
- Never hardcode secrets in Dockerfile or compose files.
- Use env vars, `.env` (local only), and secret stores for sensitive values.
- Keep placeholder values non-sensitive and clearly marked.

## Validation Before Finish
- Validate compose syntax and render:
  - `docker compose -f infra/docker-compose.dev.yml config`
- Build touched images locally when possible before commit.
