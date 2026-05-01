# Production Runbook

## Scope
This runbook describes rollback and disaster recovery procedures for the AudioMind production environment.

## 1. Rollback deployments
Use rollout undo for impacted services in namespace `audiomind`.

```bash
kubectl rollout undo deployment/user-api-deployment -n audiomind
kubectl rollout undo deployment/meeting-api-deployment -n audiomind
kubectl rollout undo deployment/processing-api-deployment -n audiomind
kubectl rollout undo deployment/ai-api-deployment -n audiomind
kubectl rollout undo deployment/ai-processing-service-deployment -n audiomind
```

Verify rollout:

```bash
kubectl rollout status deployment/user-api-deployment -n audiomind
kubectl get pods -n audiomind
```

## 2. Restore managed PostgreSQL from snapshot
Example flow (AWS RDS):

1. Open AWS Console -> RDS -> Snapshots.
2. Choose latest healthy snapshot for `audiomind` database.
3. Click `Restore snapshot` and create a new instance endpoint.
4. Update Kubernetes DB secret with new endpoint credentials.
5. Restart API workloads.

Example command update:

```bash
kubectl create secret generic db-creds \
  -n audiomind \
  --from-literal=DATABASE_URL='jdbc:postgresql://<new-endpoint>:5432/audiomind' \
  --from-literal=DB_USERNAME='<username>' \
  --from-literal=DB_PASSWORD='<password>' \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl rollout restart deployment/user-api-deployment -n audiomind
kubectl rollout restart deployment/meeting-api-deployment -n audiomind
```

## 3. Redis blacklist loss recovery
If Redis data is lost, access token blacklist entries are lost.

Expected behavior:
- Previously logged out tokens may temporarily appear valid until token expiration.
- Users should be asked to log in again.

Recovery steps:

```bash
kubectl rollout restart statefulset/redis -n audiomind
kubectl rollout restart deployment/user-api-deployment -n audiomind
```

Communication:
- Notify users of a forced re-login window.
- Monitor `/api/users/me` and auth error rates until stable.

## 4. Escalation and contacts
Cap nhat thong tin lien he truoc khi cutover production. Thay the cac placeholder duoi day voi thong tin on-call thuc te.

- On-call engineer: `oncall@audiomind.example.com` (PagerDuty/Slack)
- Platform lead: `platform-lead@audiomind.example.com`
- Database owner: `db-owner@audiomind.example.com`
- Security contact: `security@audiomind.example.com`
- Incident channel: `#audiomind-incidents` (Slack)

## 5. Realtime Feature (enable/disable)

This section explains how to enable, disable, and rollback the realtime WebSocket feature (keyword highlight).

Enable realtime (staging/production):

1. Ensure feature flag is available in the runtime config or environment store for the target environment.
  - Example env var: `VITE_REALTIME_WS_ENABLED=true` (frontend)
  - Example backend flag: `REALTIME_WS_ENABLED=true`

2. Update the environment secret/ConfigMap and perform a rollout restart for the frontend and gateway services:

```bash
kubectl set env deployment/fe-audiomind VITE_REALTIME_WS_ENABLED=true -n audiomind
kubectl rollout restart deployment/fe-audiomind -n audiomind
kubectl set env deployment/realtime-gateway REALTIME_WS_ENABLED=true -n audiomind
kubectl rollout restart deployment/realtime-gateway -n audiomind
```

3. Monitor metrics (ws_connected, event_lag_ms, error_rate) and logs. Follow Canary plan in docs/next-steps-manual-guide.md.

Disable realtime (rollback to polling):

1. Flip feature flags off:

```bash
kubectl set env deployment/fe-audiomind VITE_REALTIME_WS_ENABLED=false -n audiomind
kubectl set env deployment/realtime-gateway REALTIME_WS_ENABLED=false -n audiomind
kubectl rollout restart deployment/fe-audiomind -n audiomind
kubectl rollout restart deployment/realtime-gateway -n audiomind
```

2. No code deploy is required for rollback if the system is implemented to fall back to polling when the feature flag is off.

3. If a rollback to a previous image is required for any component:

```bash
kubectl rollout undo deployment/realtime-gateway -n audiomind
kubectl rollout undo deployment/processing-api-deployment -n audiomind
```

4. Communicate status to on-call and product stakeholders via the incident channel.
