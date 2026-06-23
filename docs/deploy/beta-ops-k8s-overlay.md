# Beta Ops — K8s Staging Overlay

Namespace: `audiomind-staging`  
Deploy: [ci-cd.yaml](../../.github/workflows/ci-cd.yaml) `deploy-staging` job.

## Apply / verify

```bash
kubectl kustomize k8s/overlays/staging --load-restrictor=LoadRestrictionsNone | kubectl apply -f -
kubectl get pods -n audiomind-staging
bash scripts/ci/verify-ready-staging.sh
```

## Readiness probes

Deployments in [core-deployments.yaml](../../k8s/deployments/core-deployments.yaml):

| Service | readiness | liveness |
|---------|-----------|----------|
| meeting-api | `/ready:8081` | `/health:8081` |
| processing-api | `/ready:8082` | `/health:8082` |
| user-api | `/ready:8083` | `/health:8083` |
| ai-api | `/ready:8000` | `/health:8000` |

## Jaeger (OTLP)

Stack: [k8s/observability/stack.yaml](../../k8s/observability/stack.yaml) — Jaeger all-in-one, OTLP HTTP **:4318**.

```bash
kubectl port-forward -n audiomind-staging svc/jaeger 16686:16686
# UI: http://localhost:16686
```

Env on Java pods:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
SPRING_PROFILES_ACTIVE=production
OTEL_ENABLED=true
```

`user-api` uses the same OTEL env block as meeting/processing.

## Prometheus

Static scrape in `stack.yaml` includes meeting, processing, ai-api.  
Add `user-api:8083` `/actuator/prometheus`.

ServiceMonitor [user-api-servicemonitor.yaml](../../k8s/monitoring/servicemonitors/user-api-servicemonitor.yaml) — patch staging `namespaceSelector` to `audiomind-staging`.

## Post-deploy CI gate

```bash
K8S_NAMESPACE=audiomind-staging bash scripts/ci/verify-ready-staging.sh
```

Dry-run (no cluster):

```bash
bash scripts/ci/verify-ready-staging.sh --dry-run
```

## Drill 3 (trace chain)

1. Port-forward Jaeger UI
2. Call processing API with `X-Trace-Id: drill-3-test`
3. Confirm child span to `ai-api` and attribute `audiomind.trace_id`

## Rollback

```bash
kubectl rollout undo deployment/processing-api-deployment -n audiomind-staging
# or revert git + re-apply kustomize
```
