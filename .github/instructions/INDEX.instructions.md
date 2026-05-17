<!-- keywords: index, instructions, navigation, troubleshooting-matrix -->
<!-- meta: generated index mapping instruction files to purpose and quick commands -->
# Instructions INDEX

## When To Use Which File
- Docker changes: docker.instructions.md — runtime checks: `docker logs`, `docker compose config`
- FE changes: typescript-react.instructions.md — runtime checks: `npm run dev`, `npm run build`
- Python services: python-services.instructions.md — runtime checks: `uvicorn`, `pytest`
- Java services: java-services.instructions.md — runtime checks: `mvn compile && mvn test`, `/actuator/health`
- gRPC/protos: grpc.instructions.md — runtime checks: `grpcurl`, regenerate stubs`
- DB migrations: database-migrations.instructions.md — runtime checks: `flyway migrate` against copy`
- E2E: e2e-testing.instructions.md — runtime checks: Playwright traces, `scripts/setup-e2e-account.ps1`
- Testing workflow: testing.instructions.md — reproducible command table for each service
- Security: security.instructions.md — audit commands `npm audit`, `pip-audit`, OWASP
- CI/CD: cicd.instructions.md — debug via re-run, reproduce locally

## Troubleshooting Matrix (quick)
- Build failure (Java): check `mvn test`, then container JVM args, then CI logs.
- API mismatch (proto/contract): check proto versions, regenerate stubs, run downstream compile.
- DB failure after migration: run Flyway validate and check per-service history table.
- E2E timeout: verify backend health, setup account script, audio fixtures, playwright traces.
- Secret leak suspicion: stop, rotate secrets, run secret-scan, preserve logs.

## Quick Navigation Table
- Docker: [docker.instructions.md](docker.instructions.md)
- FE: [typescript-react.instructions.md](typescript-react.instructions.md)
- Python: [python-services.instructions.md](python-services.instructions.md)
- Java: [java-services.instructions.md](java-services.instructions.md)
- gRPC: [grpc.instructions.md](grpc.instructions.md)
- Migrations: [database-migrations.instructions.md](database-migrations.instructions.md)
- E2E: [e2e-testing.instructions.md](e2e-testing.instructions.md)
- Testing: [testing.instructions.md](testing.instructions.md)
- Security: [security.instructions.md](security.instructions.md)
- CI/CD: [cicd.instructions.md](cicd.instructions.md)
