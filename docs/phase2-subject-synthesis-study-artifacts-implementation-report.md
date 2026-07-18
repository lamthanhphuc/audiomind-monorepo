# Phase 2 — Implementation Report

**Verdict (this session):** **Ready to merge**

Second post-review remediation completed on top of prior Phase 2 commits. All mandatory gates green.

## A. Git

| Item | Value |
|------|--------|
| Branch | `feature/phase2-subject-synthesis-study-artifacts` |
| Base | `origin/main` @ `e7ba389` |
| Prior HEAD | `00ca68a` (23 commits) |
| New commits | second post-review remediation (see log) |
| History | No reset / rebase / force-push of prior commits |

## B. AI full suite

| Item | Detail |
|------|--------|
| Command | `pytest` (`demoRecordAUDIOMID/ai-service`) |
| Result | **561 passed, 0 failed, 23 skipped**, exit **0** |

## K. Post-review remediation

(See prior section K for first remediation: synthesisId security, dispatch lease, queue deployment, cache policy, stale modes, language, FE regenerate, evidence pairing, schemas, batch token budget, Celery timeouts, list pagination.)

## L. Second post-review remediation

### L.1 Retry state machine
- Transient errors (`StudyTransientError`: Gemini 429/5xx, timeout, network) requeue the row to `QUEUED`, clear `processing_started_at` / `last_heartbeat_at`, keep `attempt_count` + error fields, then `self.retry()`.
- Terminal `FAILED` only when `self.request.retries >= max_retries`.
- Non-transient validation/source/auth errors fail immediately without retry.
- Applies to `generate_subject_synthesis` and `generate_study_artifact`.
- Tests prove second claim succeeds and provider is called again.

### L.2 Dispatch recovery + migration 014
- Migration `014_phase2_dispatch_recovery.py`: `quota_confirmed_at`, `dispatch_attempt_count`, `last_dispatch_error`, `last_dispatch_error_at`, `next_dispatch_retry_at` on synthesis + artifact.
- Prepare returns `dispatchableIds` / `dispatchableArtifactIds` / `dispatchableSynthesisIds`.
- Flow: prepare → quota for newlyCreated → `confirm-quota` (`quota_confirmed_at`) → dispatch.
- Dispatch requires `quota_confirmed_at IS NOT NULL`; broker failure releases lease, records backoff; orphan QUEUED remains redispatchable without re-charging quota.
- Reconciliation enqueues orphans (not lease-clear-only); marks `DISPATCH_EXHAUSTED` past max attempts.

### L.3 Celery Beat deployment
- K8s: `celery-beat-deployment` (replicas: 1) in `k8s/deployments/core-deployments.yaml`.
- Compose: `celery-beat` / `beat` in infra dev/MVP and ai-service standalone compose.
- Beat schedule includes `study-generation-reconcile`; config guards assert Beat + queue + task registration.

### L.4 Source hash pre-worker check
- `_guard_source_hash_unchanged` before Gemini; mismatch → `STALE` + `SOURCE_CHANGED_AFTER_PREPARE`, no provider call.

### L.5 Multi-artifact savepoints
- Each artifact create uses `db.begin_nested()`; IntegrityError rolls back only the savepoint; response IDs are verified as live rows.

### L.6 Stale regenerate policy
- Processing `regenerateArtifact` passes `synthesisId = null`.
- Worker falls back to educationStudy-only generation on `SYNTHESIS_SOURCE_MISMATCH`.
- FE keeps prior content until the new version reaches a terminal status.

### L.7 Empty-subject stale
- `None` = no stale context; `[]` = empty subject.
- ALL_READY with non-empty stored sources and current `[]` → STALE on GET/LIST; FE stale banners cover synthesis + artifacts.

### L.8 MCQ option ID validation
- Exactly 4 options; option IDs unique and constrained to A–D; option texts unique; `correctOptionId` present once. Duplicate IDs (A,A,B,C) rejected.

### L.9 Reducer token budget
- Hierarchical / multi-round reducer when intermediate JSON exceeds `SUBJECT_SYNTHESIS_MAX_INPUT_TOKENS`.
- Preserves `sourceMeetingIds` / evidence; emits warnings when forced pairwise merge is required.

### L.10 Synthesis evidence pairs
- Synthesis schema/normalize/storage use `evidence[{meetingId,segmentId}]`.
- FE `SubjectSynthesisPanel` navigates via `pickStudyEvidence` (not independent array zip).

### L.11 Tests / smoke
- New: `tests/test_phase2_second_remediation.py`.
- Technical smoke updated (confirm-quota, 11-item PASS banner).
- Processing `StudyGenerationServiceTest` covers quota/confirm/dispatch/orphan/503 paths.

## H. Full matrix

| Module | Command | Exit | Passed | Failed | Skipped | Result |
|--------|---------|------|--------|--------|---------|--------|
| AI | `pytest` | 0 | 561 | 0 | 23 | PASS |
| Processing | `.\mvnw.cmd -q test` | 0 | suite | 0 | — | PASS |
| Meeting | `.\mvnw.cmd -q test` | 0 | suite | 0 | — | PASS |
| FE lint | `npm run lint` | 0 | — | — | — | PASS |
| FE test | `npm run test` | 0 | 727 | 0 | — | PASS |
| FE build | `npm run build` | 0 | — | — | — | PASS |
| Contracts | validate/generate/typecheck/check:openapi | 0 | — | — | — | PASS |
| Migration | `alembic upgrade/downgrade/upgrade` through **014** | 0 | — | — | — | PASS |
| `git diff --check` | origin/main...HEAD | 0 | — | — | — | PASS |

## Smoke

| Kind | Result |
|------|--------|
| Technical fake-provider smoke | **PASS** (retry, redispatch, source-changed, MCQ, reducer, evidence, Beat guards) |
| Real Gemini smoke | **NOT RUN** |

## I. Remaining risks

1. Real Gemini staging smoke still recommended (1 synthesis + 1 flashcard/MCQ).
2. Multi-service JWT Docker E2E loop still piecewise.
3. Concurrent multi-artifact race default DB remains SQLite file; prefer Postgres URL in CI.

## J. Status

**Ready to merge:** **Yes**
