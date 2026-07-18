# Phase 2 — Implementation Report

**Verdict (this session):** **Not ready to merge** — mandatory acceptance criteria still lack full evidence (manual smoke NotRun; one pre-existing AI `test_api.py` env failure; concurrent DB race covered by IntegrityError path + unit tests but not a live dual-request integration).

## A. Git

| Item | Value |
|------|--------|
| Base branch | `origin/main` |
| Base commit | `e7ba3898947aceabb1e3e68b21b8ea9566fd5b18` |
| Phase 1 on main | Verified — PR #122 / #123 |
| Phase 2 branch | `feature/phase2-subject-synthesis-study-artifacts` |
| Branch creation | `git switch -c … origin/main` (never `-B`) |
| Prior commits (preserved) | `03e9310` … `d976055` (5 commits) — not reset |

## B. Architecture

- **Persistence:** ai-service Alembic `012`
- **Public API:** processing-service `/processing/...` (JWT)
- **Internal API:** ai-service `/api/internal/...` (`X-Internal-Service-Token`)
- **Source resolve:** `POST /api/internal/study-sources/resolve` (bulk)
- **Jobs:** Celery queue `study_generation`
- **Worker command:** `celery -A app.celery_app.celery_app worker … -Q audio_processing,study_generation`
- **Flow:** prepare → quota(newlyCreated only) → dispatch; FE polls **artifactIds**
- **Aggregate status:** `QUEUED|PROCESSING|COMPLETED|PARTIALLY_FAILED|FAILED`
- **Soft delete:** partial unique on `idempotency_key WHERE deleted_at IS NULL`

## C. Celery / deployment (this pass)

| File | Change |
|------|--------|
| `demoRecordAUDIOMID/ai-service/app/celery_app.py` | `task_routes` for `generate_subject_synthesis` + `generate_study_artifact` → `settings.celery_study_generation_queue` |
| `infra/docker-compose.dev.yml` | Worker `-Q audio_processing,study_generation` |
| `infra/docker-compose.mvp.yml` | Explicit worker command with same `-Q` |
| `infra/.env.example` | `CELERY_STUDY_GENERATION_QUEUE=study_generation` |
| `infra/docker-compose.staging.yml` / `prod.yml` | Override **environment only**; worker command inherited from base compose when layered with MVP/dev |

**Routing proof (no live Gemini):** `tests/test_study_celery_routing.py` — tasks bound to `study_generation`; job lifecycle `QUEUED → PROCESSING → COMPLETED/FAILED`; transient retry vs validation no-retry.

**Worker health:** existing `worker_ready` → `start_worker_health_server()` + timeout monitor unchanged.

## D. Contracts (exit 0)

| Command | Exit | Result |
|---------|------|--------|
| `npm run validate:contracts` | 0 | 2 proto + 4 OpenAPI validated |
| `npm run generate:client` | 0 | Regenerated `packages/api-clients/{meeting,processing,ai,user}.ts` |
| `npm run typecheck:client` | 0 | `tsc --noEmit -p tsconfig.generated.json` |
| `npm run check:openapi` | 0 | No breaking changes vs main for all 4 YAML |

OpenAPI Phase 2 paths/schemas present in `packages/contracts/processing-api.yaml` and `ai-api.yaml`.

## E. Test / build matrix

### AI service

| Command | Result |
|---------|--------|
| `pytest tests/test_study_phase2.py tests/test_study_celery_routing.py tests/test_study_service_critical.py -q` | **28 passed** |
| Full `pytest -q` (suite) | **510 passed, 1 failed, 22 skipped** |
| Failure detail | `test_api.py::test_endpoints_async_flow` — `TypeError: Client.__init__() got an unexpected keyword argument 'app'` (httpx/starlette TestClient env mismatch). **Pre-existing / environment — not introduced by Phase 2 study code.** Study tests all green. |

### Processing service

| Command | Result |
|---------|--------|
| `.\mvnw.cmd -q test` | **EXIT 0** (full suite) |
| `.\mvnw.cmd -q "-Dtest=StudyGenerationServiceTest,MeetingServiceClientPaginationTest" test` | **EXIT 0** (8 StudyGeneration + pagination) |

Covered: cache-hit skips quota+dispatch; newlyCreated consumes then dispatch; quota denied → mark failed, **never** dispatch; regenerate force consumes; paginate-all; GET/DELETE map AI 404; EXPLICIT meeting owned by other user → FORBIDDEN.

### Meeting service

| Command | Result |
|---------|--------|
| `.\mvnw.cmd -q test` | **EXIT 0** (Testcontainers Docker warning present; suite completed successfully) |

### Frontend

| Command | Result |
|---------|--------|
| `npm run lint` | **EXIT 0** |
| `npm run test` | **76 files / 715+ tests passed** (includes Phase 2 workflow/UI tests) |
| `npm run build` | **EXIT 0** |

FE coverage added: multi-id poll + `PARTIALLY_FAILED`; cache-hit terminal stops after one poll; empty ids no poll; double-submit busy guard; stale banner; mind-map cycle/orphan; Phase 1 meetings tab; synthesis tab no auto-generate; evidence path helpers.

## F. Critical backend AC checklist (evidence)

| # | Criterion | Evidence |
|---|-----------|----------|
| 1 | User A cannot GET B's artifact | AI `get_artifact_for_owner` + processing maps AI 404 |
| 2 | User A cannot regenerate B's | Owner filter on prepare + EXPLICIT meeting owner check |
| 3 | User A cannot delete B's | AI soft_delete owner + processing 404 map |
| 4 | Bulk resolver no other-owner sources | `test_bulk_resolve_filters_other_owner_education_runs` |
| 5 | Concurrent same idempotency → one active | IntegrityError re-fetch path in `prepare_artifacts`; conceptual soft-delete reuse test. **No live dual-request race harness.** |
| 6 | Cache hit no quota | `createArtifacts_cacheHit_skipsQuotaAndDispatch` |
| 7 | Regenerate always quota | `createArtifacts_regenerateForce_alwaysConsumesQuota` |
| 8 | Quota fail no Celery dispatch | `createArtifacts_quotaDenied_marksFailedAndThrows` |
| 9 | Reserved record on quota fail | `mark_reserved_quota_exceeded` |
| 10 | Soft-deleted does not block new | Partial unique + reuse conceptual test |
| 11 | Cache ignores soft-deleted | `_live_artifact_query` filter test |
| 12–16 | Stale ALL_READY / EXPLICIT / transcript / analysis version | `test_study_service_critical` + phase2 hash tests |
| 17 | Paginate-all | `MeetingServiceClientPaginationTest` + service test |
| 18–19 | Transient retry / validation no retry | `test_study_celery_routing` |
| 20 | Multi-artifact `PARTIALLY_FAILED` | aggregate tests + FE poll test |

## G. Manual smoke (§36)

| Scenario | Result |
|----------|--------|
| Full local stack + Gemini | **NotRun** |
| Stub/fake provider technical smoke | **NotRun** (stack not started this session) |
| Gemini real call | **NotRun** |

Do **not** claim smoke Passed.

## H. Remaining gaps (block Completed / merge)

1. Manual smoke NotRun (Gemini and/or stub stack).
2. Full AI pytest: 1 env failure in legacy `test_api.py` (httpx/starlette).
3. No live concurrent dual-request idempotency integration test.
4. Some FE evidence UX (cross-meeting wait-for-transcript toast/unauthorized navigate) covered indirectly via helpers / Phase 1 analysis tests — not a dedicated Phase 2 E2E component test for every toast path.
5. PDF/DOCX intentionally out of scope (Phase 3).

## I. Status

**Phase 2 Completed:** **No** (missing smoke + incomplete concurrent race proof + env pytest failure on unrelated `test_api`).

**Ready to merge:** **No** — use after smoke evidence and preferably fixing or quarantining `test_api.py` env issue in CI.
