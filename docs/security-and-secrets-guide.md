# Security and Secrets Guide

This guide defines how secrets and security-sensitive configuration must be handled in `audiomind-monorepo`.

## 1. Secret Inventory (Current)

The following secrets are actively used across local, CI, and deployment workflows:

- `JWT_SECRET`
- `DATABASE_URL`
- `DEEPGRAM_API_KEY`
- `E2E_USERNAME`
- `E2E_PASSWORD`
- `NVD_API_KEY`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `HUGGINGFACE_TOKEN` (where diarization/tokenized model access is required)

## 2. Approved Secret Storage Locations

### Local Development

- Local `.env` files (ignored by git)
- Shell session environment variables
- Developer machine secret manager (recommended)

### CI/CD

- GitHub Actions Secrets
- Repository/environment-scoped secrets for workflow jobs

### Kubernetes

- Kubernetes `Secret` resources
- Sealed Secrets / external secret operator (recommended for shared clusters)

## 3. Mandatory Rules

1. Never hardcode secret values in source code, docs examples with real values, Dockerfiles, or workflow YAML.
2. Never commit `.env` files or secret dumps.
3. Always consume secrets through environment variables or secret stores.
4. Keep placeholders explicit for deployment manifests that require manual secret injection.
5. Rotate secrets when exposure is suspected.

## 4. Secret Guard Enforcement

This repository uses a pre-tool hook:

- Config file: `.github/hooks/secret-guard.json`
- Command: `python ./scripts/hooks/secret_guard.py`

Expected behavior:
- Detect common secret patterns before tool actions proceed.
- Block or warn on suspicious payloads depending on hook logic.

## 5. Secret Rotation Policy

Recommended rotation baseline:

- `JWT_SECRET`: every 90 days or immediately after suspected exposure.
- `DATABASE_URL` credentials: every 90 days or during major environment transitions.
- `DEEPGRAM_API_KEY`: every 60-90 days or after incident.
- `E2E_USERNAME`/`E2E_PASSWORD`: every 30-60 days (non-production account but still sensitive).
- `NVD_API_KEY`: rotate per org policy or when token is shared beyond intended scope.

Rotation steps:

1. Create new secret value in secure generator/vault.
2. Update GitHub/K8s/local secret stores.
3. Restart/redeploy affected services.
4. Verify health and smoke checks.
5. Revoke old secret.

## 6. Dependency Security Audit Rules

### Node

```powershell
npm audit
```

### Python

```powershell
pip-audit -r demoRecordAUDIOMID/ai-service/requirements.txt
```

### Java

```powershell
cd demoRecordAUDIOMID
./mvnw -q -pl user-service org.owasp:dependency-check-maven:check
```

Guidance:
- Do not ignore CVEs silently.
- If an ignore is required, document reason, scope, and review date.
- Track accepted risk in audit reports and PR notes.

## 7. Incident Response (Secret Exposure)

If a secret is leaked:

1. Treat as incident and notify maintainers immediately.
2. Rotate exposed secret first, then investigate blast radius.
3. Remove leaked values from git history if required by policy.
4. Re-run smoke/security checks.
5. Document timeline and corrective actions.

## 8. AI Agent Safety Notes

For AI-assisted sessions:

- Do not print full secret values in chat outputs.
- Use placeholders (`<REDACTED>`, `<YOUR_SECRET>`).
- Prefer references to variable names over actual values.
- If secret values appear in files unexpectedly, stop and ask for guidance before continuing.
