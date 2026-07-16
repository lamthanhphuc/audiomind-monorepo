# Phase 1 — Implementation report

**Branch:** `feature/phase1-subject-education`  
**Base:** `origin/main` @ `d77a030`  
**Started:** 2026-07-15  
**Status:** In progress (Steps 0–6 complete)

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
| Regression + full module | **130 passed**, 0 failures, 0 errors |

```text
.\mvnw.cmd -pl meeting-service test --no-transfer-progress
→ Tests run: 130, Failures: 0, Errors: 0
```

### Not in this step

Education AI (`educationStudy`), OpenAPI/clients, FE SubjectPicker/pages, Git Stage B.

## Test / build log

| Step | Command | Result |
|------|---------|--------|
| Pre-5 | `*MimeSniffer*` | 5 passed |
| Step 5 | `StudyFolderServiceTest` + `SubjectServiceTest` | 24 passed |
| Step 5 | full `meeting-service test` | **100 passed** |
| Step 6 | subject assignment + upload/realtime suites | 30 new tests |
| Step 6 | full `meeting-service test` | **130 passed** |

## Remaining

- Step 7+: AI education / OpenAPI / FE (per plan)
- Git Stage B not run
