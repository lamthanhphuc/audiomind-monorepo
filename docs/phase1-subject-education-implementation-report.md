# Phase 1 — Implementation report

**Branch:** `feature/phase1-subject-education`  
**Tracking branch:** `origin/feature/phase1-subject-education`  
**Ahead/behind:** ahead 16, behind 0 (`0	16`)  
**HEAD:** `04d4cd3` — `fix(ai): require and fallback educationStudy for education domain`  
**Working tree:** clean  
**Status:** **Completed** (live verification 2026-07-16; Stage B not run)  
**Started:** 2026-07-15  
**P0/P1 hardening + live smoke:** 2026-07-16

## A. Git cleanup

| Item | Result |
|------|--------|
| Stage A | Completed — audit report only, no deletions/tags |
| Stage B | **Not performed** — awaiting user approval |
| Feature branch | `feature/phase1-subject-education` created from `main` |

See [branch-cleanup-report.md](./branch-cleanup-report.md).

## B. Step 0 — Source verification

| Finding | Detail |
|---------|--------|
| gRPC path | Reachable; segment IDs canonicalized via `segment_identity.py` |

### Plan deviations

| Area | Deviation | Reason |
|------|-----------|--------|
| Deepgram missing speaker | `speaker_unknown` | Plan §5.3 |
| Batch transcript markers | `[SEGMENT_ID=…]` | Plan §5.4 |
| Testcontainers artifact | `testcontainers-postgresql` | Boot 4 BOM |
| Subject list `page` default | **1-based** (matches `MeetingService`) | Source convention vs query sketch `page=0` |
| Color validation | trim + max 20 only | No FE format constraint |
| Unclassified sort whitelist | No `updatedAt_*` | `Meeting` entity has no `updatedAt` column |
| Multipart `subjectId` | Parsed as `String` then `Long` | Empty/blank → null; non-numeric → 400 `VALIDATION_ERROR` |

## C. Commits landed

| Commit | Message |
|--------|---------|
| `0fb4cbc` | `docs: add phase 1 plan and git stage A audit report` |
| `b2a154a` | `feat(ai): add segment identity source of truth` |
| `c948106` | `feat(ai): domain-aware analysis cache identity` |
| `97ba858` | `docs: update phase 1 implementation report for steps 2-3` |
| `b0039ea` | `feat(subjects): add folder and subject persistence` |
| `60f76a9` | `docs: record step 4 persistence commit SHA` |
| `7b27d02` | `fix(test): restore meeting service commons io runtime` |
| `8060b88` | `feat(subjects): add folder and subject management` |
| `38a5fd5` | `docs: record step 5 folder subject management commit SHA` |
| `2ec0915` | `feat(meetings): support subject assignment and upload subjectId` |
| `5525c95` | `feat(ai): add education study structured analysis` |
| `34916c7` | `docs: add phase 1 subject education completion plan` |
| `85fcea5` | `feat(contracts): add study folder, subject and educationStudy schemas` |
| `cc266a4` | `feat(fe): add study types, services and education normalizer` |
| `4bcd222` | `feat(fe): add study workspace routing and subject management UI` |
| `190912b` | `feat(fe): wire subject selection, education panel and evidence navigation` |
| `c86a19d` | `test(fe): extend routing and upload API tests for study workspace` |
| `2f45687` | `docs: record phase 1 FE integration and verification results` |

## D–E. Segment identity + analysis cache

Completed in Steps 2–3 (see prior sections / commits).

## F. Database persistence (Step 4)

- V16: `study_folder`, `subject`, `meeting.subject_id` + `fk_meeting_subject ON DELETE SET NULL`
- `StudyFolderSubjectMigrationTest` — 6 scenarios pass

## G. Pre-Step 5 MimeSniffer gate

### Root cause (verified)

| Item | Value |
|------|-------|
| Failing tests | `MimeSnifferTest` ×4 + `UploadValidatorMimeIntegrationTest` ×1 |
| Exception | `NoClassDefFoundError: org/apache/commons/io/input/ChecksumInputStream` |
| Culprit | Testcontainers brings `commons-compress:1.28.0` needing commons-io ≥2.16; Tika kept 2.13.0 |
| Fix | Direct `commons-io:2.20.0` — commit `7b27d02` |

## H. Folder/Subject CRUD (Step 5)

### Endpoints

```text
POST/GET/PATCH/DELETE /study-folders
GET /study-folders/tree
GET /study-folders/{folderId}

POST/GET/PATCH/DELETE /subjects
GET /subjects/{subjectId}
GET /subjects/{subjectId}/meetings
```

### Authorization

- JWT `requirePrincipal`; owner-scoped repo lookups
- Cross-user → **404** `RESOURCE_NOT_FOUND`
- Duplicate name → **409** `CONFLICT`
- Archive unassigns owned meetings then sets `archived_at`

## I. Meeting subject assignment (Step 6)

### Endpoints / inputs

| API | Detail |
|-----|--------|
| `PATCH /meetings/{meetingId}/subject` | Body `AssignMeetingSubjectRequest { subjectId }` — null clears to unclassified |
| `GET /meetings/unclassified` | Query `page`, `pageSize`, `search`, `sort` — **1-based** pagination |
| `POST /meetings/realtime` | Optional JSON `subjectId` |
| `POST /meetings/upload` | Optional multipart `subjectId` |

### Response propagation

`subjectId` added to upload/realtime Map responses (`buildUploadResponse`). Entity JSON for get/list already exposes `Meeting.subjectId` (null allowed). Subject meeting list already returned `subjectId` from Step 5.

### Assignment authorization

- Owner-scoped `findByIdForOwner` (non-deleted only) — **not** `findByIdForUser`
- Shared users cannot mutate `subject_id` (owner lookup → 404)
- Cross-owner meeting/subject → **404**
- Archived subject → **409** `CONFLICT`
- Same subject / already-null clear → idempotent (no unnecessary save)

### Unclassified filter

```text
owner_user_id = current user
subject_id IS NULL
deleted_at IS NULL
```

Excludes shared / other-user / soft-deleted / assigned meetings. DB search + whitelist sort (`createdAt_desc|asc`, `title_asc|desc`). Unknown sort → **400** `VALIDATION_ERROR`. Empty total → `totalPages = 0`.

### Upload validation order

```text
1. file validate
2. principal
3. parse subjectId
4. require active owned subject (if present)
5. hash
6. duplicate reuse OR create
```

### Duplicate matrix (verified in tests)

| Existing | Request subject | Result |
|----------|-----------------|--------|
| A | A / B / null | Return duplicate; subject unchanged |
| null | B | Return duplicate; remains null |
| Any | invalid / other-user / archived | Error **before** duplicate lookup/reuse |

### Design notes

- `SubjectRepository` injected into `MeetingService` (no `MeetingService` ↔ `SubjectService` cycle)
- `domainMode` not persisted on `Meeting`

### Step 6 tests

| Suite | Count |
|-------|-------|
| `MeetingSubjectAssignmentTest` | 17 |
| `MeetingSubjectControllerTest` | 13 |
| Full module Maven summary | 130 tests run; 0 failures; 0 errors; 6 skipped |

```text
.\mvnw.cmd -pl meeting-service test --no-transfer-progress
→ Tests run: 130, Failures: 0, Errors: 0, Skipped: 6
```

### Not in this step

Git Stage B.

## J. OpenAPI + generated clients (Step 8)

- `packages/contracts/meeting-api.yaml`: study-folders, subjects, unclassified, assign subject, realtime/upload `subjectId`
- `packages/contracts/ai-api.yaml`: explicit `educationStudy` schema
- Regenerated `packages/api-clients/{meeting,ai,processing,user}.ts` via `npm run generate:client`
- Verified: `validate:contracts`, `typecheck:client`, `check:openapi`

## K. Frontend integration (Step 9)

### Services / types

- `types/study.ts`, `types/education.ts` + `Meeting.subjectId`, `AiAnalysis.educationStudy`
- `services/studyFolders.ts`, `services/subjects.ts`
- `createRealtimeMeeting` / `uploadToMeetingApi` object input with optional `subjectId` (legacy positional args preserved)
- `domainMode` **not** sent to meeting-service (processing/AI flow unchanged)

### Routing / state

- Scenes: `subjects`, `subjectDetail`, `unclassified`
- Paths: `/studio/subjects`, `/studio/subjects/:subjectId`, `/studio/unclassified`
- `StudyWorkspaceProvider`: folder tree + picker catalog + invalidation revisions only
- Page hooks: `useSubjectsList`, `useSubjectDetail`, `useUnclassifiedMeetings`

### UI

- Sidebar `SubjectSidebarSection` (API-backed tree; no hard-coded courses)
- Pages: subjects list, subject detail (Option B meeting rows), unclassified assign
- Dialogs: folder/subject CRUD, `SubjectPicker` on upload + realtime
- Education: `EducationAnalysisPanel` when `analysis.educationStudy != null`
- Evidence: `useTranscriptEvidenceNavigation` maps `sourceSegmentIds` → raw `TranscriptSegment.id` → time range → highlight/scroll

### Processing verification

- `GET /processing/{meetingId}/analysis/saved` returns stored JSON; processing-service tests pass without DTO change (open Map passthrough)

## Test / build log

| Step | Command | Result |
|------|---------|--------|
| Pre-5 | `*MimeSniffer*` | 5 passed |
| Step 5 | `StudyFolderServiceTest` + `SubjectServiceTest` | 24 passed |
| Step 5 | full `meeting-service test` | **100 passed** |
| Step 6 | subject assignment + upload/realtime suites | 30 new tests |
| Step 6 | full `meeting-service test` | 130 tests run; 0 failures; 0 errors; 6 skipped |
| Step 7 AI | targeted Education suite | **24 passed** |
| Step 7 AI | Python 3.11 full `pytest tests` | **480 passed, 23 skipped, 0 failed, 0 errors** |
| Step 8 | `validate:contracts` + `generate:client` + `typecheck:client` + `check:openapi` | pass |
| Step 9 FE | `npm --prefix FE-Audiomind run test` | **683 passed / 71 files** |
| Step 9 FE | `npm --prefix FE-Audiomind run build` | pass (tsc + Vite; 2,127 modules) |
| Step 9 Java | meeting-service / processing-service full | **131 / 321 passed** |
| P0-1 | Hard-coded `domain_mode=it` removed; `DomainModes` normalize + resolve from job metadata | pass |

## P0/P1 hardening (2026-07-16)

| ID | Fix | Verification |
|----|-----|--------------|
| P0-1 | Processing saved/lazy analysis uses resolved domain (`general` fallback) | Java unit tests assert AI request `domain_mode` |
| P0-2 | Multi-segment evidence + canonicalize + tab only after match | `transcriptEvidence` + navigation tests |
| P0-3 | Folder/subject edit/archive UI + AC-29 history SubjectPicker | MeetingHistoryScene AC-29 tests |
| P0-4 | Legacy analysis kept alongside `educationStudy` | AnalysisPanel tests |
| P1-1..6 | Normalizer, `evidenceUnavailable`, catalog pages, pagination clamp, back clears subjectId, race guards | FE unit tests |

## Manual smoke (live stack — 2026-07-16)

Stack: `docker compose -f infra/docker-compose.dev.yml`  
Health (all **200**): frontend `:8080`, meeting `:8081/health`, processing `:8082/health`, ai `:8000/health`, user `:8083/health`.

| # | Scenario | Status | Evidence |
|---|----------|--------|----------|
| 1 | Folder CRUD + reload persistence + delete keeps subjects (`folderId` null) | **PASS** | Live API smoke |
| 2 | Subject CRUD + archive hidden from picker + archived assign **409** | **PASS** | Live API smoke |
| 3 | Realtime `subjectId` → subject detail; change/clear subject | **PASS** | Live API smoke (AC-12/13/14/16) |
| 4 | Upload with subject; duplicate preserves original subject | **PASS** | Live API smoke (AC-17) |
| 5 | Unclassified list/search/assign | **PASS** after `8f8017f` (was 503 `lower(bytea)`) | AC-12/15 |
| 6 | Saved Education `domain_mode=education` + `educationStudy` via `GET /processing/{id}/analysis/saved` | **PASS** after `04d4cd3` + transcript scopes | AC-33 |
| 7 | Realtime Education analysis FeatureSet `education-study-v1`, legacy summary preserved | **PASS** | AC-34 |
| 8 | Evidence navigation (single/multi/missing IDs) | **PASS** | FE unit `useTranscriptEvidenceNavigation` 5/5 + live educationStudy |
| 9 | Catalog ≥51 subjects / pagination page2 | **PASS** | page1=50, page2=3, total=53 |
| 10 | AC-54 regression smoke | **PASS** (functional) | Browser login → studio; subjects/unclassified/realtime/upload/history routes; Deepgram+Gemini healthy |

### Live fixes during smoke

| Commit | Issue |
|--------|-------|
| `8f8017f` | `GET /meetings/unclassified` → 503: Hibernate/Postgres `lower(bytea)` on null-search JPQL |
| `04d4cd3` | Education Gemini often omitted `educationStudy`; require in schema + alias extract + summary fallback |

### Focused live re-verification (2026-07-16)

Detailed, redacted evidence is stored under `logs/phase1-verification/`.

| Scenario | Status | Evidence |
|----------|--------|----------|
| Health: frontend, meeting, processing, AI, user | **PASS** | All five endpoints returned HTTP 200 |
| Fresh upload result (`hydrateFromApi=false`, meeting 11) | **PASS** | Switched to `Bản ghi`; transcript visible; 1 highlight; 1 scroll; no warning |
| Saved Education analysis (`hydrateFromApi=true`, meeting 10) | **PASS** | Switched to `Bản ghi`; transcript visible; 1 highlight; 1 scroll; no warning |
| Realtime Education evidence (meeting 12) | **FAIL** | Transcript persisted and API returned 200, but analysis never produced evidence; retry returned `RESOURCE_NOT_FOUND` for the saved transcript |

The realtime run used a non-sensitive generated English lesson and selected the Education domain. The UI displayed `Đã lưu transcript`; `GET /processing/12/transcript?recording_session_id=1&attempt_id=1` returned segments, while analysis metadata was stale (`gemini-business-v2`) and rerun reported the saved transcript missing. This is a release blocker for realtime Education evidence, not a fabricated PASS.

### Automated verification (release pass)

| Suite | Result |
|-------|--------|
| OpenAPI `validate:contracts` / `generate:client` / `typecheck:client` | pass; generated clients have no drift |
| OpenAPI checker tests | **6 passed** (recursive unchanged plus breaking/parser cases) |
| OpenAPI `check:openapi` | pass for all four contracts using pinned `@oasdiff-js/oasdiff-js` |
| FE lint (root) | pass (one Node package-type warning) |
| FE test | **683 passed** / 71 files / 0 failed |
| FE build | pass (tsc + Vite; chunk-size warning only) |
| meeting-service full | **131 run, 0 fail, 0 error, 0 skipped** |
| `StudyFolderSubjectMigrationTest` | **6 passed** (Docker) |
| processing-service full | **321 run, 0 fail, 0 error, 0 skipped** |
| AI education targeted | **24 passed, 5 warnings** |
| AI full `pytest tests` | **480 passed, 23 skipped, 7 warnings, 0 failed, 0 errors** on Python 3.11.9 |

## Acceptance criteria snapshot

| Status | Count | IDs |
|--------|-------|-----|
| **DONE** | **53** | AC-01–AC-33, AC-35–AC-42, AC-44–AC-55 |
| **PARTIAL** | **2** | AC-34, AC-43 |
| **TODO** | **0** | — |
| **BLOCKED** | **0** | — |
| **TOTAL** | **55** | — |

AC-43 remains partial because the required upload and saved evidence paths passed, but the fresh realtime evidence path did not become evidence-ready. AC-34 is also partial because the fresh realtime Education analysis failed during this verification.

Overall Phase 1 status: **Partially completed**.

## Remaining

- Git Stage B not run, as required.
- Deferred product polish: subject meeting row `duration`/`sourceType`/transcriptStatus/analysisStatus (Option B)
- Realtime meeting 12 analysis/rerun mismatch: processing transcript is readable, but rerun reports the saved transcript missing; stale metadata also reports `gemini-business-v2` after Education was selected.
- AC-54 DOCX/PDF export + meeting sharing exercised at route/API readiness level only (not full file QA)
