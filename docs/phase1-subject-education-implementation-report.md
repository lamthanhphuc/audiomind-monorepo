# Phase 1 — Implementation report

**Branch:** `feature/phase1-subject-education`  
**Base:** `origin/main` @ `d77a030`  
**Started:** 2026-07-15  
**Status:** In progress (Steps 0–4 complete)

## A. Git cleanup

| Item | Result |
|------|--------|
| Stage A | Completed — audit report only, no deletions/tags |
| Stage B | **Not performed** — awaiting user approval |
| Feature branch | `feature/phase1-subject-education` created from `main` |

See [branch-cleanup-report.md](./branch-cleanup-report.md).

## B. Step 0 — Source verification

### grpc_stt_service reachability (locked)

| Finding | Detail |
|---------|--------|
| Production start | `main.py` lifespan starts gRPC when `_get_stt_adapter()` returns adapter (requires `deepgram_api_key`) |
| Primary browser realtime | WebSocket → `stt_session_actor` → `DeepgramSTTAdapter._resolve_segment_id` (stable meeting-start IDs) |
| gRPC `StreamAudio` | **Reachable** when gRPC server runs; was `uuid4()` — now canonicalized via `segment_identity.py` |
| **Decision** | Evidence guarantee for gRPC stream path included in same contract as adapter path |

### Plan deviations

| Area | Deviation | Reason |
|------|-----------|--------|
| Deepgram missing speaker | ID uses `speaker_unknown` (not `speaker_1`) | Plan §5.3 test vectors; updated `test_deepgram_stt_adapter` |
| Batch transcript format | `format_aligned_transcript_for_analysis` adds `[SEGMENT_ID=…]` markers | Plan §5.4; cache tests updated to match formatted text |
| Testcontainers artifact | Boot 4 BOM uses `testcontainers-postgresql` (not `postgresql`) | Verified against processing-service naming + Boot 4 parent |

## C. Commits landed

| Commit | Message | Scope |
|--------|---------|-------|
| `0fb4cbc` | `docs: add phase 1 plan and git stage A audit report` | Plan + branch audit + report stub |
| `b2a154a` | `feat(ai): add segment identity source of truth` | `segment_identity.py`, stt_adapter, grpc, canonical persist |
| `c948106` | `feat(ai): domain-aware analysis cache identity` | `analysis_versioning.py`, cache lookup by `idempotency_key`, pipeline/main wire-up |
| `97ba858` | `docs: update phase 1 implementation report for steps 2-3` | Implementation report |
| *(pending)* | `feat(subjects): add folder and subject persistence` | Flyway V16 + Meeting.subjectId + migration test |

## D. Segment identity (Step 2)

- **New:** `demoRecordAUDIOMID/ai-service/app/services/segment_identity.py`
- **Delegated:** `stt_adapter._resolve_segment_id`, `main._build_segment_id`, `canonical_persist_service.assign_segment_ids`, `grpc_stt_service` partial/final events
- **Batch:** `pipeline.py` assigns stable IDs before analysis; transcript formatted with segment markers
- **Tests:** `test_segment_identity.py` (plan vectors), `test_deepgram_stt_adapter` updated

## E. Analysis cache identity (Step 3)

- **New:** `demoRecordAUDIOMID/ai-service/app/services/analysis_versioning.py`
- **`AnalysisCacheIdentity`:** in-memory `normalized_domain_mode`; domain part in idempotency hash
- **`find_completed_analysis_run_for_identity`:** primary lookup by `idempotency_key` (not `_identity_filters` alone)
- **Domain feature sets:** `grouped-action-plan-v1-{general,it,business}`, `education-study-v1`
- **Tests:** `test_analysis_versioning.py`, updated `test_analysis_scope.py`, `test_analysis_cache_hit_miss.py`

## F. Database persistence (Step 4)

### Migration

- **File:** `meeting-service/.../V16__study_folder_subject_and_meeting_subject.sql`
- **Tables:** `study_folder`, `subject`
- **Column:** `meeting.subject_id BIGINT NULL`
- **FK:** `fk_meeting_subject` → `subject(id)` **ON DELETE SET NULL** (no CASCADE)
- **Indexes:** `idx_study_folder_owner`, `idx_study_folder_parent`, `idx_subject_owner`, `idx_subject_folder`, `idx_meeting_subject`, `idx_meeting_owner_unclassified` (partial on `owner_user_id` WHERE `subject_id IS NULL AND deleted_at IS NULL`)
- **Unique partial:** `uq_study_folder_owner_parent_name_active`, `uq_subject_owner_name_active`
- **Verified meeting columns:** `owner_user_id`, `deleted_at` (from V1/V2/V5)

### JPA

- `Meeting.subjectId` scalar `Long` only — no `@ManyToOne` yet (Step 5)

### Migration test

- `StudyFolderSubjectMigrationTest` (Surefire `*Test`, PostgreSQL Testcontainers)
- Seeds minimal `app_users` (V15 requires it; user-service owned in prod) + Flyway `baselineOnMigrate` at version `0`
- Scenarios: empty→V16 schema; V15→V16 legacy preserve; FK SET NULL; subject/folder unique indexes; legacy safety

### Not in this commit

- Folder/subject CRUD, meeting assignment API, upload/realtime `subjectId`, FE, education, OpenAPI

## G–I. (pending)

- Folder/subject domain + APIs (Step 5–6)
- Education schema/prompt (Step 7)
- OpenAPI + FE (Steps 8–11)
- Full verification (Step 12)

## Test / build log

| Step | Command | Result |
|------|---------|--------|
| Stage A | Git audit | OK |
| Step 2 | `pytest test_segment_identity.py test_deepgram…` | 21 passed |
| Step 3 | `pytest test_analysis_versioning.py test_analysis_scope.py test_analysis_cache_hit_miss.py` | All passed |
| Step 4 | `mvnw -pl meeting-service -Dtest=StudyFolderSubjectMigrationTest test` | **6 passed** |
| Step 4 | `mvnw -pl meeting-service test` | Migration + unit OK; **MimeSnifferTest (4) + UploadValidatorMimeIntegrationTest (1) fail** with `NoClassDefFoundError: org/apache/commons/io/input/ChecksumInputStream` — **unrelated to V16** (Tika/commons-io classpath); excluding those: **71 passed** |

## Remaining issues

- `main.py` transcript GET path uses `resolve_segment_id_for_read` but batch `format_transcript_for_analysis` in `ai_analyzer.py` unchanged (pipeline uses `format_aligned_transcript_for_analysis` instead)
- Legacy runs with `grouped-action-plan-v1` (no domain suffix) intentionally cache-miss per plan §6.4
- Git Stage B not run (by design)
- Pre-existing MimeSniffer / commons-io classpath failures on full `meeting-service` Surefire run
