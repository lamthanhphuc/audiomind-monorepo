# Phase 2 — Subject Synthesis & Study Artifacts (Implementation Plan)

**Status:** Implementing on `feature/phase2-subject-synthesis-study-artifacts`  
**Base branch:** `origin/main` @ `e7ba389` (Phase 1 landed via PR #122 / #123 — verified files on origin/main)  
**Provisional note:** Pre-fetch local Phase 1 HEAD `f8cd3db` was provisional only; discarded after verify.

## 1. Phase 1 architecture (verified)

- meeting-service: `study_folder`, `subject`, `meeting.subject_id` (Flyway V16)
- ai-service: `educationStudy` in `meeting_analysis_runs.analysis_payload_json`
- processing-service: Redis jobs, JWT public API, proxies AI
- FE: History API studio routes; SubjectDetailScene; evidence navigation

## 2. Base branch and commit

| Item | Value |
|------|--------|
| Branch | `feature/phase2-subject-synthesis-study-artifacts` |
| Created with | `git switch -c … origin/main` (branch did not exist; never `-B`) |
| Base SHA | `e7ba3898947aceabb1e3e68b21b8ea9566fd5b18` |

## 3. Affected modules

- ai-service: Alembic 012, models, bulk resolve, synthesis/artifact pipelines, Celery `study_generation`, internal APIs
- processing-service: public `/processing/subjects/...` and `/processing/study-artifacts`, prepare→quota→dispatch
- FE-Audiomind: subject detail tabs, study UI, ESLint, evidence handoff
- packages/contracts: processing-api + ai-api

## 4. Database ownership

All Phase 2 tables in **ai-service** Postgres (shared `audiomind` DB, Alembic). No meeting-service Flyway for content JSON. No cross-DB FK.

## 5–6. Data flows

See Cursor plan §7a: FE → processing (JWT) → meeting membership (paginate-all) → AI bulk resolve → AI prepare → processing quota(newlyCreated) → AI dispatch → Celery → FE polls **artifactIds**.

## 7. Hierarchical summarization

educationStudy batches → intermediate → final reducer. Config: `SUBJECT_SYNTHESIS_MAX_MEETINGS_PER_BATCH`, `MAX_INPUT_TOKENS`, `MAX_PARALLEL_BATCHES`.

## 8. Async job

Celery queue `study_generation`; explicit autoretry for transient errors only; soft/hard time limits.

## 9. Cache / source hash

SHA-256 canonical JSON; partial unique `idempotency_key WHERE deleted_at IS NULL`; soft-delete filters everywhere.

## 10. Evidence

`meetingId` + `segmentId` → analysis route + query/history state → wait transcript → scroll/highlight.

## 11. API contract

Public under `/processing/...`; AI under `/api/internal/...` with `X-Internal-Service-Token`.

## 12. Frontend

Subject detail tabs + SubjectMindMapView (not MindmapView/AiAnalysis). Poll artifactIds. Aggregate: QUEUED|PROCESSING|COMPLETED|PARTIALLY_FAILED|FAILED.

## 13. Security

JWT at processing only; owner from SecurityContext; AI owner only with internal token; IDOR tests.

## 14. Test plan

Product §§32–34 mandatory. Contracts: validate/generate/typecheck/check:openapi. FE lint via new FE-Audiomind script.

## 15. Expected files

See implementation report when complete. Locked decisions: prepare/dispatch, poll artifactIds, partial unique index, no checkout -B.
