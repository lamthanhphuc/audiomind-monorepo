# PR: production-ready -> main

## Summary
This PR hardens the system for production readiness across CI/CD, Kubernetes production overlays, managed database wiring, monitoring/logging setup, production test assets, and operations runbooks.

## Included changes
1. CI/CD
- Added `.github/workflows/ci-cd.yaml` triggered on `main` and `production-ready`.
- Added build, test, container publish to GHCR, and staging deploy steps.

2. Production Kubernetes overlay
- Added resource limits patch (`resource-patch.yaml`).
- Added HPA (`hpa.yaml`) and PDB (`pdb.yaml`).
- Added TLS NGINX ingress placeholder (`ingress.yaml`).
- Added placeholder SealedSecret keys and production placeholder notes.

3. Managed PostgreSQL wiring
- Added `db-secret-placeholder.yaml` for external DB credentials.
- Patched `user-api` to read DB config from `db-creds`.
- Disabled in-cluster DB deployment in production overlay.

4. Monitoring and logging
- Added monitoring namespace and ServiceMonitors.
- Added Helm values and install script for kube-prometheus-stack + Loki.
- Added Python `/metrics` endpoints and dependencies.
- Added Grafana dashboard configmap.

5. Production test scripts
- Added smoke, k6 load, and chaos scripts under `tests/`.

6. Operational docs
- Added `docs/production-runbook.md`.
- Added `docs/production-validation-report.md`.

## Validation
- `kubectl kustomize --load-restrictor=LoadRestrictionsNone k8s/overlays/prod`
- `kubectl kustomize k8s/monitoring`
- `mvn -pl meeting-service,processing-service,user-service -am -DskipTests compile`
- `python -m compileall` for updated Python services

## Notes
- Real secrets, TLS certs, cloud resources, and cluster add-ons are intentionally left as placeholders and must be completed during rollout.
