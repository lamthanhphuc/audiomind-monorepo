# Copilot Session Context

This file is a persistent handoff note for AI agents (Copilot, Cursor, and similar).
Update this file at the start and end of each meaningful session.

## 1. Session Header

- Last updated: 2026-05-01
- Updated by: AI Assistant
- Current branch: docs/post-audit-fixes
- Target branch: main
- Active objective: Post-audit documentation fixes and guidance expansion

## 2. Locked Files (Do Not Modify Without Review)

- .github/workflows/*
- packages/contracts/*
- infra/docker-compose.dev.yml
- k8s/overlays/prod/*
- k8s/overlays/staging/*

Reason:
- These files impact CI/CD, deployment, or contract compatibility.
- Any edit should be accompanied by explicit validation and reviewer sign-off.

## 3. Current Working Set

- docs/documentation-audit-report.md
- demoRecordAUDIOMID/ai-service/README.md
- docs/database-access.md
- docs/domain/service-boundaries.md
- docs/domain/processing-state-machine.md
- FE-Audiomind/README.md
- docs/dev-environment-guide.md
- docs/architecture-overview.md
- docs/security-and-secrets-guide.md
- .github/instructions/*.instructions.md (new files)

## 4. Architecture Decisions (Confirmed)

1. Monorepo with multi-service architecture remains the baseline.
2. Batch/polling flow remains available as fallback.
3. Realtime path uses WebSocket (frontend-facing) plus gRPC/protobuf (service streaming).
4. Ollama is the current LLM runtime baseline.
5. Deepgram adapter is used for realtime STT where configured.
6. Contracts are managed under `packages/contracts` and generated clients under `packages/api-clients`.

## 5. Open Questions (Unresolved)

- Is `realtime-gateway` currently an independently deployed service in all environments, or embedded in processing service for some stages?
- Is `glossary-service` already fully deployed, or partially represented in docs/contracts only?
- Which production contacts are final owners for on-call/security/escalation?
- What is the canonical Python baseline in CI (3.10 vs 3.11) across all workflows?

## 6. Next Agent Instructions

### Start Here

1. Run `git status` and verify branch alignment.
2. Read `docs/documentation-audit-report.md` first.
3. Continue with highest-priority docs listed under section "Lam ngay".

### Do Not Touch Without Explicit Request

- Secrets values, `.env` files, or credential payloads.
- Protected-branch workflow triggers unless change request is explicit.
- Historical audit artifacts unless the task is to archive/normalize them.

### Validation Checklist Before Commit

- Markdown files render correctly.
- Commands in docs are copy-paste runnable.
- No secret values included.
- Cross-file references point to existing files.

## 7. Session Update Template

Use this block at the end of your session:

```markdown
### Session Update
- Date:
- Agent:
- Branch:
- Files changed:
- Commits:
- Remaining tasks:
- Risks/blockers:
```
