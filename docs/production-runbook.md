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
Cap nhat thong tin lien he truoc khi cutover production.

- On-call engineer: `CAN QUYET DINH` (`CAN QUYET DINH`)
- Platform lead: `CAN QUYET DINH` (`CAN QUYET DINH`)
- Database owner: `CAN QUYET DINH` (`CAN QUYET DINH`)
- Security contact: `CAN QUYET DINH` (`CAN QUYET DINH`)
- Incident channel: `CAN QUYET DINH`
