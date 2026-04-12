---
description: "Use when: editing Python services in demoRecordAUDIOMID app/tests; enforce FastAPI patterns, pytest-cov usage, and dependency pinning rules."
name: "Python Services Guidelines"
applyTo:
  - demoRecordAUDIOMID/**/app/**
  - demoRecordAUDIOMID/**/tests/**
---
# Python Services Guidelines

## FastAPI
- Keep route handlers thin and delegate business logic to service modules.
- Validate request and response schemas with Pydantic models instead of ad-hoc dict parsing.
- Use dependency injection for shared resources (database/session/client), and avoid global mutable state.
- Keep async boundaries explicit: async endpoints for I/O workloads; avoid mixing blocking calls inside async handlers.

## Testing And Coverage
- Use pytest as default test runner and keep tests near service behavior in test modules.
- Prefer deterministic tests: mock external APIs, model inference endpoints, and file/network I/O.
- For coverage checks, use pytest-cov and report missing lines for changed modules.
- Recommended command pattern in each Python service:
  - `pytest --maxfail=1 --disable-warnings --cov=app --cov-report=term-missing`

## Dependency Pinning
- Pin direct dependencies in requirements files with explicit versions.
- Do not add broad ranges for runtime packages in service requirements.
- Separate dev-only tooling from runtime dependencies when possible.
- When adding or upgrading dependencies, document compatibility impact in PR notes and run service tests.
