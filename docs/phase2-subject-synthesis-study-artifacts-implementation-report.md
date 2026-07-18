# Phase 2 — Implementation Report

**Verdict (this session):** **Ready to merge**

Post-review remediation completed on top of the prior 16 commits. All mandatory gates green.

## A. Git

| Item | Value |
|------|--------|
| Branch | `feature/phase2-subject-synthesis-study-artifacts` |
| Base | `origin/main` @ `e7ba389` |
| Prior HEAD | `565c53e` (16 commits) |
| New commits | post-review remediation (see log) |
| History | No reset / rebase / force-push of prior commits |

## B. AI full suite

| Item | Detail |
|------|--------|
| Command | `pytest` (`demoRecordAUDIOMID/ai-service`) |
| Result | **548 passed, 0 failed, 23 skipped**, exit **0** |

## K. Post-review remediation

### K.1 synthesisId security
- `resolve_compatible_synthesis` requires owner + subject + `deleted_at IS NULL` + `COMPLETED` + matching `source_hash` + `source_selection_mode`.
- Hint `synthesisId` still validated; auto-select latest compatible COMPLETED when omitted.
- Worker re-checks via `_load_compatible_synthesis_content` before injecting synthesis into prompts.
- Errors: `SYNTHESIS_NOT_FOUND` / `SYNTHESIS_NOT_OWNED` / `SYNTHESIS_SUBJECT_MISMATCH` / `SYNTHESIS_SOURCE_MISMATCH` / `SYNTHESIS_NOT_READY` (no foreign content leak).

### K.2 Dispatch / worker idempotency
- Migration `013_phase2_dispatch_idempotency.py`: `dispatch_requested_at`, `celery_task_id`, `processing_started_at`, `attempt_count`, `last_heartbeat_at`, plus synthesis `options_json`.
- Conditional claim dispatch (QUEUED + lease expired or null).
- Deterministic Celery task IDs: `study-artifact-{id}-v{version}`, `subject-synthesis-{id}-v{version}`.
- Worker conditional `QUEUED → PROCESSING`; skip without Gemini if claim fails.
- Broker enqueue failure releases dispatch claim for safe retry.
- Reconcile beat task clears expired QUEUED dispatch leases; marks stuck PROCESSING as `PROCESSING_TIMEOUT`.

### K.3 Queue deployment
- Fixed: `k8s/deployments/core-deployments.yaml`, `demoRecordAUDIOMID/ai-service/docker-compose.yml`.
- Dev/MVP already had `-Q audio_processing,study_generation`.
- Config guard: `tests/test_study_queue_deployment_config.py`.

### K.4 Cache policy
- Only `COMPLETED` → `cacheHit`.
- `QUEUED`/`PROCESSING` → `inFlight`.
- `FAILED`/`QUOTA_EXCEEDED` soft-deleted and replaced (new version), never cacheHit.

### K.5 Stale ALL_READY / EXPLICIT
- Empty current ALL_READY meeting set is stale (no empty-list skip).
- EXPLICIT: new meetings outside selection do not stale; source leaving subject does.
- List API computes stale with subject meeting IDs (processing passes membership set).

### K.6 Language
- Synthesis persists `options_json.language`; worker reads stored language (no hard-coded `vi`).
- Options hash includes language → `vi`/`en` caches are distinct.

### K.7 Frontend regenerate
- `regenerateStudyArtifact` → `StudyArtifactsCreateResponse`.
- `pickRegeneratedArtifact` + poll `artifactIds`; keep prior content until terminal.

### K.8 Evidence pairing
- `evidence.py` meeting→segment map; never positional zip across meetings.
- Artifacts/synthesis normalize to `evidence[{meetingId,segmentId}]` (+ legacy arrays derived).
- FE `pickStudyEvidence` prefers evidence pairs.

### K.9 Structured schemas + validators
- Per-type Gemini `response_schema` (nested).
- Min counts → `FAILED_VALIDATION` when below config mins.
- Mind-map duplicate IDs fail; orphan/cycle pruned.

### K.10 Token budget
- Batch by `MAX_MEETINGS_PER_BATCH` + `MAX_INPUT_TOKENS` (`estimate_tokens`).
- Parallelism capped by `MAX_PARALLEL_BATCHES`.
- Oversized single meeting truncated with warning.

### K.11 Celery timeouts / retry
- Timeouts via `task_annotations` (not mutating `self.soft_time_limit` at runtime).
- No broad `autoretry_for=(Exception,)`; only `StudyTransientError` retries.

### K.12 List pagination
- `page` / `size` / `sort` with defaults and max size; soft-deleted excluded; stale on list.
- OpenAPI + generated client updated.

## H. Full matrix

| Module | Command | Exit | Passed | Failed | Skipped | Result |
|--------|---------|------|--------|--------|---------|--------|
| AI | `pytest` | 0 | 548 | 0 | 23 | PASS |
| Processing | `.\mvnw.cmd -q test` | 0 | suite | 0 | — | PASS |
| Meeting | `.\mvnw.cmd -q test` | 0 | suite | 0 | — | PASS |
| FE lint | `npm run lint` | 0 | — | — | — | PASS |
| FE test | `npm run test` | 0 | 727 | 0 | — | PASS |
| FE build | `npm run build` | 0 | — | — | — | PASS |
| Contracts | validate/generate/typecheck/check:openapi | 0 | — | — | — | PASS |
| Migration | `alembic upgrade/downgrade/upgrade` through 013 | 0 | — | — | — | PASS |
| `git diff --check` | origin/main...HEAD | 0 | — | — | — | PASS |

## Smoke

| Kind | Result |
|------|--------|
| Technical fake-provider smoke | **PASS** (updated for dispatch claim + schemas + min counts) |
| Real Gemini smoke | **NOT RUN** |

## I. Remaining risks

1. Real Gemini staging smoke still recommended (1 synthesis + 1 flashcard/MCQ).
2. Multi-service JWT Docker E2E loop still piecewise (AI HTTP smoke + Java orchestration + live queue inspect).
3. Concurrent race default DB remains SQLite file; prefer Postgres URL in CI.

## J. Status

**Ready to merge:** **Yes**
