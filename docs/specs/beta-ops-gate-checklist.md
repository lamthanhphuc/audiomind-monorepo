# Beta Ops Gate — Acceptance Checklist

Updated: 2026-06-23

Mark each row **Pass**, **Fail**, or **Waiver** (owner, date, reason).

## P0 Prerequisites

| Item | Expected | Evidence | Status |
|------|----------|----------|--------|
| 7T-Ops-A celery CORS | Worker healthy after `start-prod.sh` | `docker compose exec celery-worker` health :8080 | Pending |
| CI E2E secrets | Configured on `main` or Waiver | GitHub secrets / waiver note | Pending |
| Gate-A | Status documented | Link to Gate-A checklist | Pending |

## CI-CD-A

| Item | Expected | Evidence | Status |
|------|----------|----------|--------|
| beta-ops-ci workflow | Green on PR | Actions URL | Pending |
| log-safety-scan | Exit 0 | CI log | Pending |
| verify-ready-staging | `/ready` UP all 4 APIs | CI log or manual | Pending |
| Branch protection | `beta-ops-verify` required | GitHub settings screenshot | Pending |

## Health

| Item | Expected | Evidence | Status |
|------|----------|----------|--------|
| K8s readiness | `/ready` on 4 APIs | `core-deployments.yaml` | Pending |
| Compose celery | healthcheck on worker :8080 | `docker compose ps` | Pending |
| Actuator probes | `/actuator/health/liveness` + `/readiness` | curl local | Pending |
| health-prod.sh | Exit 0, JSON status UP | script output | Pending |
| Health P95 | &lt;500ms warm `/health` | drill notes | Pending |

## Logging

| Item | Expected | Evidence | Status |
|------|----------|----------|--------|
| JSON stdout | Java + ai-api | `docker compose logs` sample | Pending |
| No app.log in container | ai-api | `docker exec` ls logs/ | Pending |
| traceId grep drill | &lt;5 min | Drill 1 evidence | Pending |

## Observability

| Item | Expected | Evidence | Status |
|------|----------|----------|--------|
| Drill 3 Jaeger (K8s) | processing → ai-api span | Jaeger screenshot / trace id | Pending |
| Prometheus user-api | scrape 8083 | Prometheus targets | Pending |
| OTEL VPS disabled | `OTEL_SDK_DISABLED=true` default VPS | compose env | Pending |

## Known limitations

| ID | Acknowledged | Owner | Date |
|----|--------------|-------|------|
| L1 WebSocket no OTEL | | | |
| L2 Celery no distributed trace | | | |
| L3 Drill 3 K8s only | | | |
| L4 No Loki on VPS | | | |
| L5 Gate-A separate | | | |
| L6 user-api no OpenAPI | | | |

## Drill evidence table

| Drill | Description | Env | Result | Evidence |
|-------|-------------|-----|--------|----------|
| 1 | Upload failure traceId grep | VPS/local | | |
| 2 | Stop ai-api → processing /ready 503 | Compose/K8s | | |
| 3 | HTTP trace chain Jaeger | K8s staging | | |
| 4 | Log bundle no secrets | VPS | | |
| 5 | ANALYSIS_BUSY logs + FE | Any | | |

## Sign-off

| Role | Name | Date |
|------|------|------|
| Ops | | |
| Dev | | |
