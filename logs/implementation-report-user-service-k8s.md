# Implementation Report: User Service + K8s E2E + Rollback

Date: 2026-04-08
Environment: local Kubernetes namespace `audiomind`

## 1) Summary

This run completed all requested steps:

- Stabilized JWT secret wiring for `user-api` before E2E.
- Executed full E2E flow via `scripts/smoke-e2e.ps1` with Kubernetes port-forward.
- Performed rollback drill (forced bad deployment -> fail confirmed -> rollback undo -> recovered).
- Collected trace evidence from `user-service` logs.

Overall status: **PASS**

## 2) JWT Secret Wiring Stabilization

### What was found

- `jwt-secret` did not exist in namespace `audiomind`.
- `user-api-deployment` used hardcoded env value:
  - `JWT_SECRET=replace-this-secret-with-at-least-32-bytes-for-dev`

### What was fixed

1. Created dedicated secret:

- Secret name: `jwt-secret`
- Key: `JWT_SECRET`

2. Patched deployment env wiring to secretKeyRef:

- `JWT_SECRET -> secretKeyRef(name=jwt-secret, key=JWT_SECRET)`

3. Verified rollout health:

- `kubectl rollout status deployment/user-api-deployment -n audiomind` -> success

4. Persisted manifest fix in repo:

- Updated `k8s/deployments/core-deployments.yaml` to use `secretKeyRef` for `JWT_SECRET`.

## 3) Full E2E Execution (processing + ai-service)

### Port-forward setup used

- `svc/meeting-api` -> `localhost:8081`
- `svc/processing-api` -> `localhost:8082`
- `svc/ai-api` -> `localhost:8000`

### Initial blocker and fix

- First run failed due missing audio file:
  - `Audio file not found: D:\Bin\EXE101\Thu_muc_moi\smoke-short-12s.wav`
- Fix:
  - Generated local WAV fixture `smoke-short-12s.wav` (12 seconds).

### Final smoke result

Executed:

- `scripts/smoke-e2e.ps1 -AudioFile d:\Bin\EXE101\Thu_muc_moi\smoke-short-12s.wav -AiBaseUrl http://localhost:8000 -ProcessingBaseUrl http://localhost:8082 -TimeoutSeconds 240`

Observed flow:

- Upload: OK
- Process start: OK
- Poll status progression:
  - `QUEUED (uploading, progress=0)`
  - `RUNNING (chunking, progress=10)`
  - `COMPLETED (completed, progress=100)`
- Transcript fetch: OK

Reported result: **PASS**

Smoke report file:

- `logs/smoke-test-report.md`

## 4) Rollback Drill

### Failure injection

Injected bad env to force failure:

- `SPRING_DATASOURCE_URL=jdbc:postgresql://db-invalid:5432/audiomind`

Result:

- rollout timed out
- pod restarted repeatedly
- logs confirmed startup failure with:
  - `java.net.UnknownHostException: db-invalid`
  - `Failed to initialize JPA EntityManagerFactory`

### Rollback execution

- `kubectl rollout undo deployment/user-api-deployment -n audiomind`
- rollout status after undo: success
- new pod ready: `1/1 Running`

### Post-rollback functional verification

Auth lifecycle revalidated through `user-api`:

- Register: 200
- Login: 200
- `/me`: 200
- Logout: 200
- `/me` after logout: 401

Rollback status: **PASS**

## 5) TraceId Evidence

### Evidence A (pre-rollback stabilization flow)

TraceId: `verify-89e5e062`

`user-service` logs include:

- `user registered`
- `user login accepted`
- `user logout accepted for userId=3`

all with traceId `verify-89e5e062`.

### Evidence B (post-rollback validation flow)

TraceId: `rbk-01536bdf`

`user-service` logs include:

- `user registered`
- `user login accepted`
- `user logout accepted for userId=4`

all with traceId `rbk-01536bdf`.

## 6) Errors Fixed During This Run

1. JWT secret wiring instability

- Cause: hardcoded JWT secret value in deployment.
- Fix: moved to `jwt-secret` with `secretKeyRef`.

2. E2E fixture input missing

- Cause: missing smoke audio file.
- Fix: generated local `smoke-short-12s.wav`.

3. Forced deployment failure (rollback drill)

- Cause: intentionally wrong DB host.
- Validation: failure observed and confirmed in logs.
- Recovery: rollout undo restored service.

## 7) Rerun Guide

### A) Ensure JWT wiring is correct

1. Verify secret:

- `kubectl get secret -n audiomind jwt-secret`

2. Verify env wiring:

- `kubectl get deploy -n audiomind user-api-deployment -o jsonpath="{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{.valueFrom.secretKeyRef.name}:{.valueFrom.secretKeyRef.key}{'\n'}{end}"`

### B) Start port-forward for E2E

- `kubectl port-forward -n audiomind svc/meeting-api 8081:8081`
- `kubectl port-forward -n audiomind svc/processing-api 8082:8082`
- `kubectl port-forward -n audiomind svc/ai-api 8000:8000`

### C) Run E2E smoke

- `powershell -File scripts/smoke-e2e.ps1 -AudioFile d:\Bin\EXE101\Thu_muc_moi\smoke-short-12s.wav -AiBaseUrl http://localhost:8000 -ProcessingBaseUrl http://localhost:8082 -TimeoutSeconds 240`

### D) Rollback drill (optional)

1. Inject failure:

- `kubectl set env deployment/user-api-deployment -n audiomind SPRING_DATASOURCE_URL=jdbc:postgresql://db-invalid:5432/audiomind`
- `kubectl rollout status deployment/user-api-deployment -n audiomind --timeout=120s`

2. Undo and verify:

- `kubectl rollout undo deployment/user-api-deployment -n audiomind`
- `kubectl rollout status deployment/user-api-deployment -n audiomind --timeout=180s`

