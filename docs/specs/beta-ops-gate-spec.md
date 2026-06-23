# Beta Ops Gate — Technical Specification

- **Branch:** `feat/beta-ops-gate`
- **Date:** 2026-06-23
- **Related:** [7B backend-health-checks.md](./backend-health-checks.md), [7D backend-logging-debuggability.md](./backend-logging-debuggability.md), [Gate-A](./gate-a-pre-beta-acceptance-checklist.md)

## 1. Goals

- Beta runs reliably on VPS Compose and K8s `audiomind-staging`.
- Operators can debug incidents in &lt;5 minutes using `traceId`, structured logs, and (on K8s) Jaeger HTTP traces.
- CI blocks regressions to health contracts and log-safety.

## 2. Health contract

### 2.1 Custom endpoints (canonical for Compose and probes)

| Endpoint | Semantics | HTTP |
|----------|-----------|------|
| `/health` | Process alive, lightweight | 200, `status=UP` |
| `/ready` | Dependencies OK | 200 UP / 503 DOWN |
| `/liveness` (ai-api) | Process only | 200 UP |

Response shape:

```json
{
  "status": "UP",
  "service": "processing-service",
  "timestamp": "2026-06-23T12:00:00Z",
  "legacyStatus": "ready",
  "dependencies": {
    "redis": "UP",
    "aiService": "UP"
  }
}
```

### 2.2 Spring Actuator (Java)

Expose: `health`, `info`, `metrics`, `prometheus`.

Enable Kubernetes-style probes:

```yaml
management:
  endpoint:
    health:
      probes:
        enabled: true
  health:
    livenessstate:
      enabled: true
    readinessstate:
      enabled: true
```

Paths: `/actuator/health`, `/actuator/health/liveness`, `/actuator/health/readiness`.

Custom `HealthController` remains the source of truth for dependency checks; Actuator probes reflect application readiness state.

### 2.3 ai-api (Python)

- `/health` — UP + runtime metadata (existing)
- `/ready` — DB, Redis, pipeline, provider keys (existing)
- `/liveness` — process alive only (new)

Optional readiness extension: Celery broker reachability via Redis ping (already covered); worker heartbeat via `celery inspect ping` is best-effort and non-blocking for API readiness.

## 3. CI-CD-A

### 3.1 Workflow `beta-ops-ci.yml`

Stages:

1. Health contract tests (`HealthControllerTest`, `test_health.py`)
2. Log-safety scan
3. OpenAPI `/ready` presence
4. (on `main` / manual) verify-ready-staging skeleton

Does not replace [ci-cd.yaml](../../.github/workflows/ci-cd.yaml) image build/deploy.

### 3.2 Log-safety

Script: `scripts/ci/log-safety-scan.sh`  
Forbidden literals per F9 §20 + F10 (secrets, raw transcript, grouped payloads in log calls).

## 4. Logging baseline (7D gaps)

- `SPRING_PROFILES_ACTIVE=production` on Java services in prod compose.
- `application-production.yml`: `logging.level.root=WARN`, no DEBUG security/WebSocket.
- ai-api: stderr JSON only (remove `logs/app.log` file handler).
- Celery failures: `event=BATCH_*` + `traceId` from payload.

### Event registry (P1)

`UPLOAD_*`, `REALTIME_*`, `STT_*`, `ANALYSIS_*`, `GEMINI_*`, `AUTH_*`, `REQUEST_*`.

Required fields when context exists: `event`, `traceId`, `requestId`, `meetingId`, `durationMs`, `errorCode`.

## 5. Light OTEL

### 5.1 Java

Dependencies: `micrometer-tracing-bridge-otel`, `opentelemetry-exporter-otlp`.

Export via OTLP HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://jaeger:4318` on K8s).

`TraceIdFilter`: set span attribute `audiomind.trace_id` from `X-Trace-Id`.

### 5.2 Python

`requirements-otel.txt` + `Dockerfile` arg `INSTALL_OTEL=true` (enabled in CI for `ai-api` images).  
`opentelemetry-instrumentation-fastapi` + OTLP exporter.  
Disable on VPS: `OTEL_SDK_DISABLED=true`.

### 5.3 K8s

Jaeger all-in-one in [k8s/observability/stack.yaml](../../k8s/observability/stack.yaml) (OTLP :4318).  
Prometheus scrape: add `user-api:8083`.

## 6. File inventory

See [README.md](./beta-ops-gate/README.md) implementation slices.

## 7. Non-goals

- Full WebSocket/Celery distributed tracing (P2)
- Mandatory Jaeger on VPS
- Gate-A feature scenarios
- Auto-deploy VPS from CI
