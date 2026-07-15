# Phase 1 — Implementation report

**Branch:** `feature/phase1-subject-education`  
**Base:** `origin/main` @ `d77a030`  
**Started:** 2026-07-15  
**Status:** In progress (Steps 0–5 complete)

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
| *(pending)* | `feat(subjects): add folder and subject management` |

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
| Call chain | `MimeSniffer.detectMime` → `Tika.detect` → `DefaultZipContainerDetector` → `ArchiveStreamFactory.detect` (commons-compress) |
| Resolved before fix | `commons-io:2.13.0` via `tika-core:2.9.0` |
| Culprit | Step 4 Testcontainers 2.0.3 brings `commons-compress:1.28.0` (requires commons-io **2.20.0** / ChecksumInputStream since 2.16+) onto test CP |
| Evidence | compress POM pins `commons-io:2.20.0`; jar 2.13.0 lacks `ChecksumInputStream`; jar 2.16.1+ has it |

### Fix

Direct `commons-io:2.20.0` on meeting-service (matches compress 1.28.0 declared dependency). Commit `7b27d02`.

### Full module after fix

`mvnw -pl meeting-service test` → **100 passed** (includes MimeSniffer + migration + folder/subject tests).

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
- Cross-user → **404** `RESOURCE_NOT_FOUND` (existing meeting/share convention)
- Duplicate name → **409** `CONFLICT`
- Unknown sort → **400** `VALIDATION_ERROR`
- PATCH uses `Map.containsKey` (null clear vs omitted)
- Archive (`DELETE /subjects/{id}`): transaction unassigns owned meetings then sets `archived_at`; idempotent

### Not in this step

Meeting assignment APIs, upload/realtime `subjectId`, education AI, FE, OpenAPI.

## Test / build log

| Step | Command | Result |
|------|---------|--------|
| Pre-5 | `dependency:tree -Dincludes=commons-io` | was 2.13.0 → now 2.20.0 |
| Pre-5 | `*MimeSniffer*` | 5 passed |
| Step 5 | `StudyFolderServiceTest` + `SubjectServiceTest` | 24 passed |
| Step 5 | full `meeting-service test` | **100 passed** |

## Remaining

- Step 6: meeting subject assign / unclassified / upload subjectId
- Git Stage B not run
