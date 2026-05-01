---
description: "Use when: handling secrets, dependency audits, CVE remediation, or security-sensitive code/config changes."
name: "Security Guidelines"
applyTo:
  - "**/*"
---
# Security Guidelines

## Secret Detection and Handling
- Never hardcode credentials, API keys, tokens, or private cert data.
- Never commit `.env` files or secret payloads.
- Use environment variables or secret stores (GitHub Secrets, K8s Secrets).
- Keep placeholders clearly marked and non-sensitive.

## Repository Controls
- Respect `.github/hooks/secret-guard.json` and secret-guard checks.
- If a potential secret leak is detected, stop and sanitize before continuing.
- Do not print full secret values in logs, CI output, or chat responses.

## Dependency Audit Rules
- Node: run `npm audit` (or CI equivalent checks).
- Python: run `pip-audit` against relevant requirements files.
- Java: run OWASP dependency-check where configured.

## CVE Handling Rules
- Prefer patch/upgrade first when feasible.
- If ignore is required, document:
  - CVE/ID
  - reason for temporary ignore
  - scope and expiration/review date
- Track accepted risk in audit docs and PR notes.

## CI Security Behavior
- Distinguish clearly between `FAILED` and `ENVIRONMENT_BLOCKED`.
- Keep security jobs actionable with clear remediation notes.
- Avoid overusing `continue-on-error` for blocking vulnerabilities.
