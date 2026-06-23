# Beta Ops Gate — Overview

Branch: `feat/beta-ops-gate`  
Status: IMPLEMENTATION  
Priority: P1 (Gate 4 — Beta Ops)

## Goal

Stable beta operations with sufficient logs and distributed trace context to debug production incidents. This gate is **operational** — separate from [Gate-A](../gate-a-pre-beta-acceptance-checklist.md) (F9/F10 feature QA). Both gates should pass before a public beta.

## Four pillars

| Pillar | Scope | Key artifacts |
|--------|--------|----------------|
| **CI-CD-A** | PR/staging gates | `.github/workflows/beta-ops-ci.yml`, `scripts/ci/log-safety-scan.sh`, `scripts/ci/verify-ready-staging.sh` |
| **Health** | Liveness/readiness alignment | `/health`, `/ready`, `/liveness`, Actuator probes, `health-prod.sh` |
| **Logging** | 7D baseline gaps | JSON stdout, `x-trace-id`, event keys, production log levels |
| **OTEL** | Light HTTP tracing | Micrometer OTEL (Java), OpenTelemetry FastAPI, Jaeger on K8s staging |

## Acceptance criteria

| Criterion | Target | Verification |
|-----------|--------|--------------|
| Staging deploy gate | Post-deploy `/ready` UP for 4 core APIs | `verify-ready-staging.sh` |
| Health latency | P95 &lt; 500ms for `/health` and `/ready` on warm services | Manual curl loop or drill 1 |
| Trace context | `X-Trace-Id` echoed; OTEL spans on HTTP path (K8s) | Drill 3, Jaeger UI |
| CI gate | `beta-ops-verify` green on PR | GitHub Actions |
| Log safety | No forbidden secrets in logger calls | `log-safety-scan.sh` |
| VPS health | `health-prod.sh` exit 0 | Production smoke |

## Known limitations (L1–L6)

| ID | Limitation | Workaround |
|----|------------|------------|
| L1 | WebSocket/realtime has no end-to-end OTEL spans | Debug with `meetingId` + `STT_*` / `REALTIME_*` log markers |
| L2 | Celery has no full distributed trace | `traceId` in task payload + grep worker logs |
| L3 | Jaeger drill is **K8s staging only** | VPS: grep `traceId` from FE errors |
| L4 | Loki/log aggregation is placeholder on K8s; none on VPS Compose | `kubectl logs` / `docker compose logs` |
| L5 | Gate-A feature checklist may still be Pending | Track separately in checklist |
| L6 | `user-api` has no OpenAPI contract | Health endpoints only; contract is P2 |

## Rollback plan

| Change | Rollback |
|--------|----------|
| K8s readiness probes | Revert `k8s/deployments/core-deployments.yaml`; `kubectl apply -k k8s/overlays/staging` |
| OTEL | Set `OTEL_SDK_DISABLED=true` or `OTEL_ENABLED=false`; revert dependency commits |
| Spring `application-production.yml` | Remove `SPRING_PROFILES_ACTIVE=production` from compose prod |
| CI workflows | Disable `beta-ops-ci.yml`; remove required check in branch protection |
| Actuator probe config | Revert `management.endpoint.health.probes` in `application.yml` |

## Implementation slices

1. **Slice 0** — Spec docs (this tree)
2. **Slice 1** — Health checks (Java Actuator probes, Python `/liveness`, `health-prod.sh`)
3. **Slice 2** — CI gate (`beta-ops-ci.yml`, verify script, log-safety)
4. **Slice 3** — Light OTEL (Java + Python, K8s Jaeger, VPS disable)
5. **Slice 4** — Smoke tooling (`log-bundle.sh`, drills, checklist sign-off)

## Related docs

- [beta-ops-gate-spec.md](./beta-ops-gate-spec.md) — Full technical spec
- [beta-ops-gate-checklist.md](./beta-ops-gate-checklist.md) — Sign-off checklist
- [beta-ops-vps-overlay.md](../../deploy/beta-ops-vps-overlay.md) — VPS runbook
- [beta-ops-k8s-overlay.md](../../deploy/beta-ops-k8s-overlay.md) — K8s staging runbook
- [scripts/ci/README.md](../../../scripts/ci/README.md) — CI scripts

## Definition of Done

Implementation on `feat/beta-ops-gate` delivers scaffolding; checklist sign-off remains manual on VPS/K8s.

- [x] Spec docs and CI scripts committed
- [ ] All checklist rows Pass or Waiver (owner + date)
- [ ] `beta-ops-ci` / `beta-ops-verify` green on `main`
- [ ] Drills 1, 2, 4, 5 pass; Drill 3 on K8s staging (or Waiver)
- [ ] Known limitations L1–L6 acknowledged
- [ ] Gate-A status documented
