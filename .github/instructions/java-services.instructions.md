---
description: "Use when: editing Java services source files; enforce Spring Boot layering, Maven build/test workflow, and API contract synchronization."
name: "Java Services Guidelines"
applyTo:
  - demoRecordAUDIOMID/user-service/src/main/**
  - demoRecordAUDIOMID/meeting-service/src/main/**
  - demoRecordAUDIOMID/processing-service/src/main/**
---
# Java Services Guidelines

## Spring Boot Layering
- Preserve clean layering: controller -> service -> repository.
- Keep controllers focused on transport concerns (validation, status codes, DTO mapping).
- Keep business rules in service classes, not controllers or repositories.
- Keep repository layer focused on persistence and query semantics only.

## Maven Build And Test
- Use Maven inside the service directory for local verification.
- Preferred quick validation sequence:
  - `mvn -B -q compile`
  - `mvn -B test`
- Before finishing non-trivial Java changes, ensure tests pass in the touched service.

## API Contract Synchronization
- When changing request/response DTOs or endpoints, update relevant OpenAPI contracts in packages/contracts.
- Regenerate API clients after contract changes from workspace root:
  - `npm run generate:client`
- Run OpenAPI check and schema validation after contract updates:
  - `npm run check:openapi`
  - `npm run validate:schema`
- Follow breaking-change rules documented in docs/architecture/contract-breaking-rules.md.

## Database Migrations (Flyway)
- When changing JPA entities or database schema, add/update Flyway migration scripts in the same service change.
- Keep `spring.jpa.hibernate.ddl-auto` at `validate` for runtime safety; do not rely on `update` to mutate production schema.
- Write idempotent migration SQL to support shared or previously initialized environments.
- Use service-scoped Flyway history table configuration when multiple services share one PostgreSQL database.
- Detailed migration conventions and anti-patterns are documented in .github/instructions/database-migrations.instructions.md.

## Regression Prevention
- Before committing Java service changes, run `mvn -B test` in the touched service directory and fix any failures before pushing.
- When changing a public method signature in a service class, update every call site and the corresponding tests in the same change.
- Do not change a public method's return type or parameters without verifying the full service call chain and test coverage.
